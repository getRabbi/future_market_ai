"""PostgreSQL access for the analytics job.

Queue claims run on the owner (system) path with FOR UPDATE SKIP LOCKED; everything that reads or
writes tenant data runs inside `tenant()`, which sets app.tenant_id and switches to the fg_tenant
role so PostgreSQL row-level security enforces isolation (D-008), exactly like the TS services.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

MAX_ATTEMPTS = 3
STALE_RUNNING_MINUTES = 120


class Store:
    def __init__(self, dsn: str):
        self.conn = psycopg.connect(dsn, autocommit=True, row_factory=dict_row, application_name="futuregrow-analytics")
        row = self.conn.execute(
            "select (r.rolsuper or (exists(select 1 from pg_roles where rolname = 'fg_tenant') and pg_has_role(current_user, 'fg_tenant', 'MEMBER'))) as ok "
            "from pg_roles r where r.rolname = current_user"
        ).fetchone()
        self.rls = bool(row and row["ok"])

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------------ queue

    def claim(self, worker_id: str) -> dict | None:
        with self.conn.transaction():
            # Reclaim requests abandoned by a crashed run.
            self.conn.execute(
                "update analytics_requests set status = 'queued', locked_by = null "
                "where status = 'running' and started_at < now() - make_interval(mins => %s)",
                (STALE_RUNNING_MINUTES,),
            )
            return self.conn.execute(
                """update analytics_requests set status = 'running', started_at = now(), attempts = attempts + 1, locked_by = %s
                   where id = (select id from analytics_requests where status = 'queued' and attempts < %s
                               order by priority, requested_at for update skip locked limit 1)
                   returning *""",
                (worker_id, MAX_ATTEMPTS),
            ).fetchone()

    @contextlib.contextmanager
    def tenant(self, tenant_id: str) -> Iterator[psycopg.Cursor]:
        with self.conn.transaction():
            cur = self.conn.cursor()
            cur.execute("select set_config('app.tenant_id', %s, true), set_config('app.actor', 'system:analytics-job', true)", (tenant_id,))
            if self.rls:
                cur.execute("set local role fg_tenant")
            yield cur

    def complete(self, req: dict, result_ref: str | None, summary: dict) -> None:
        with self.tenant(req["tenant_id"]) as cur:
            cur.execute(
                "update analytics_requests set status = 'completed', finished_at = now(), result_ref = %s, result_summary = %s, error = null where id = %s",
                (result_ref, jsonb(summary), req["id"]),
            )
            emit(cur, req["tenant_id"], "analytics.request.completed", "analytics_request", str(req["id"]), {"kind": req["kind"], "resultRef": result_ref, "summary": summary})

    def fail(self, req: dict, error: str) -> None:
        final = req["attempts"] >= MAX_ATTEMPTS
        with self.tenant(req["tenant_id"]) as cur:
            cur.execute(
                "update analytics_requests set status = %s, finished_at = now(), error = %s, locked_by = null where id = %s",
                ("failed" if final else "queued", error[:4000], req["id"]),
            )
            if final:
                emit(cur, req["tenant_id"], "analytics.request.failed", "analytics_request", str(req["id"]), {"kind": req["kind"], "error": error[:1000]})


EVENT_VERSIONS = {
    "analytics.request.completed": 1,
    "analytics.request.failed": 1,
    "market.trend.detected": 1,
    "experiment.result.computed": 1,
}


def emit(cur: psycopg.Cursor, tenant_id: str, event_type: str, aggregate_type: str, aggregate_id: str, payload: dict[str, Any]) -> None:
    """Transactional outbox insert (the DB trigger enqueues dispatch atomically)."""
    cur.execute(
        """insert into outbox_events (id, tenant_id, event_type, event_version, aggregate_type, aggregate_id, occurred_at,
                                      correlation_id, causation_id, actor_type, actor_id, payload)
           values (%s, %s, %s, %s, %s, %s, now(), null, null, 'system', 'analytics-job', %s)""",
        (str(uuid.uuid4()), tenant_id, event_type, EVENT_VERSIONS[event_type], aggregate_type, aggregate_id, Jsonb(_jsonable(payload))),
    )


def _jsonable(v: Any) -> Any:
    """Make values JSON-safe: non-finite floats -> null; UUID/datetime/Decimal -> canonical forms."""
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, float):
        return v if v == v and v not in (float("inf"), float("-inf")) else None
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    return v


def jsonb(v: Any) -> Jsonb:
    return Jsonb(_jsonable(v))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def dumps(v: Any) -> str:
    return json.dumps(_jsonable(v), sort_keys=True, separators=(",", ":"), default=str)
