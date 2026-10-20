"""Northflank analytics cron entry point (D-016, D-030).

The Sandbox allows two jobs (analytics + media), so platform backups ride on the analytics job:
each run drains queued analytics requests, then - when backups are configured - takes a backup if
the last successful one is older than ``FG_BACKUP_INTERVAL_HOURS`` (default 24) and verifies the
newest backup if it has not been verified yet. Any failure gives a non-zero exit so the job run is
marked failed in Northflank.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import psycopg

from . import backup, runner


def backup_due(last_success: datetime | None, now: datetime, interval_hours: float) -> bool:
    return last_success is None or now - last_success >= timedelta(hours=interval_hours)


def _last_backup(dsn: str) -> tuple[datetime | None, str | None, bool]:
    with psycopg.connect(dsn, autocommit=True) as c:
        row = c.execute("select finished_at, object_key from backup_runs where kind = 'backup' and status = 'succeeded' order by finished_at desc limit 1").fetchone()
        if not row:
            return None, None, False
        verified = c.execute("select exists(select 1 from backup_runs where kind = 'verification' and status = 'succeeded' and object_key = %s)", (row[1],)).fetchone()[0]
        return row[0], row[1], bool(verified)


def main() -> int:
    rc = runner.main([])
    dsn = os.environ.get("DATABASE_URL")
    if not dsn or not os.environ.get("FG_BACKUP_KEY"):
        print(json.dumps({"backups": "not configured (FG_BACKUP_KEY unset)"}))
        return rc
    key = backup.load_key(os.environ["FG_BACKUP_KEY"])
    store = backup.store_from_env()
    interval = float(os.environ.get("FG_BACKUP_INTERVAL_HOURS", "24"))
    now = datetime.now(timezone.utc)
    started = now
    result: dict = {}
    try:
        last, object_key, verified = _last_backup(dsn)
        if backup_due(last, now, interval):
            created = backup.create_backup(dsn, store, key)
            object_key, verified = created["objectKey"], False
            result["backup"] = {"objectKey": object_key, "bytes": created["archiveBytes"]}
        if object_key and not verified:
            v = backup.verify_backup(store, object_key, key)
            backup._record(dsn, "verification", "succeeded" if v["ok"] else "failed", started, object_key, None, None, v.get("rows", {}), {"problems": v["problems"], "decrypted": v["decrypted"]})
            result["verification"] = {"objectKey": object_key, "ok": v["ok"], "problems": v["problems"]}
            if not v["ok"]:
                rc = rc or 1
    except Exception as exc:  # noqa: BLE001 - recorded, surfaced as a failed run
        backup._record(dsn, "backup", "failed", started, None, None, None, {}, {"error": f"{type(exc).__name__}: {exc}"})
        print(f"backup step failed: {exc}", file=sys.stderr)
        rc = rc or 1
    print(json.dumps(result or {"backups": "nothing due"}))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
