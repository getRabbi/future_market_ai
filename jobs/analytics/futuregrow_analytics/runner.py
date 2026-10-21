"""Analytics job entrypoint (Northflank cron job, D-016).

Drains `analytics_requests` until the queue is empty or the time budget is used, then exits.
Usage: python -m futuregrow_analytics.runner   (DATABASE_URL required)
"""

from __future__ import annotations

import hashlib
import os
import socket
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

import numpy as np

from . import __version__, experiments, forecasting, mmm, propensity, topics, trends
from .db import Store, dumps, emit, jsonb
from .pgtls import secure_dsn

STEP = {"hour": timedelta(hours=1), "day": timedelta(days=1), "week": timedelta(weeks=1)}
SEASON = {"hour": 24, "day": 7, "week": 52, "month": 12}


def _sha(obj) -> str:
    return hashlib.sha256(dumps(obj).encode()).hexdigest()


def _future(last: datetime, granularity: str, h: int) -> list[datetime]:
    if granularity == "month":
        out, y, m = [], last.year, last.month
        for _ in range(h):
            m += 1
            if m > 12:
                y, m = y + 1, 1
            out.append(last.replace(year=y, month=m))
        return out
    step = STEP[granularity]
    return [last + step * (k + 1) for k in range(h)]


def _tenant_policy(cur, tenant_id: str) -> dict:
    cur.execute("select policy from tenant_settings where tenant_id = %s", (tenant_id,))
    row = cur.fetchone()
    return (row or {}).get("policy") or {}


def _series(cur, series_id: str) -> tuple[dict, list[datetime], list[float]]:
    cur.execute("select * from metric_series where id = %s", (series_id,))
    s = cur.fetchone()
    if not s:
        raise ValueError(f"series {series_id} not found")
    cur.execute("select ts, value from metric_points where series_id = %s order by ts", (series_id,))
    pts = cur.fetchall()
    return s, [p["ts"] for p in pts], [float(p["value"]) for p in pts]


# --------------------------------------------------------------------------- handlers


def handle_forecast(store: Store, req: dict) -> tuple[str, dict]:
    p = req["params"]
    with store.tenant(req["tenant_id"]) as cur:
        s, ts, vals = _series(cur, p["seriesId"])
        policy = _tenant_policy(cur, req["tenant_id"])
    horizon = int(p.get("horizon", 14))
    season = int(p.get("seasonLength", SEASON.get(s["granularity"], 1)))
    if s["granularity"] == "week" and len(vals) < 2 * 52 + horizon + 10:
        season = 1  # not enough years of weekly data to learn annual seasonality
    seed = int(p.get("seed", 1234))
    np.random.seed(seed)
    future = _future(ts[-1], s["granularity"], horizon) if ts else []
    out = forecasting.run_forecast(vals, [t.isoformat() for t in ts], [f.isoformat() for f in future], season, policy.get("forecastGates"), folds=int(p.get("folds", 20)))
    with store.tenant(req["tenant_id"]) as cur:
        cur.execute(
            """insert into forecast_runs (tenant_id, request_id, series_id, horizon, status, champion_model, baseline_model, candidates, gate,
                   selection_reason, calibration, drift, dataset_sha256, config, seed, code_version)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (
                req["tenant_id"], req["id"], s["id"], horizon, out.status, out.champion, out.baseline, jsonb(out.candidates), jsonb(out.gate),
                out.selection_reason, jsonb(out.calibration), jsonb(out.drift), _sha([[t.isoformat(), v] for t, v in zip(ts, vals)]),
                jsonb({"seasonLength": season, "folds": int(p.get("folds", 20)), "quantiles": list(forecasting.QUANTILES)}), seed, __version__,
            ),
        )
        run_id = cur.fetchone()["id"]
        for pt in out.points:
            cur.execute(
                "insert into forecast_points (tenant_id, run_id, ts, mean, q025, q10, q50, q90, q975) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (req["tenant_id"], run_id, pt["ts"], pt["mean"], pt["q025"], pt["q10"], pt["q50"], pt["q90"], pt["q975"]),
            )
    return str(run_id), {"status": out.status, "champion": out.champion, "seriesId": s["id"], "sourceEvidenceId": str(s["source_evidence_id"]), "drift": out.drift.get("detected", False)}


def _aligned(cur, ids: list[str]) -> tuple[list[datetime], dict[str, list[float]], dict[str, dict]]:
    data, meta = {}, {}
    common: set | None = None
    for sid in ids:
        s, ts, vals = _series(cur, sid)
        meta[sid] = s
        data[sid] = dict(zip(ts, vals))
        common = set(ts) if common is None else common & set(ts)
    order = sorted(common or [])
    return order, {sid: [data[sid][t] for t in order] for sid in ids}, meta


def handle_mmm(store: Store, req: dict) -> tuple[str, dict]:
    p = req["params"]
    kpi, channels, controls = p["kpiSeriesId"], list(p["channelSeriesIds"]), list(p.get("controlSeriesIds", []))
    with store.tenant(req["tenant_id"]) as cur:
        order, data, meta = _aligned(cur, [kpi, *channels, *controls])
        policy = _tenant_policy(cur, req["tenant_id"])
    names = [meta[c]["key"] for c in channels]
    exp_priors = []
    for e in p.get("experimentPriors", []):
        if e["channelSeriesId"] in meta:
            exp_priors.append({"channel": meta[e["channelSeriesId"]]["key"], "liftPerPeriod": e["liftPerPeriod"], "se": e["se"], "experimentId": e.get("experimentId")})
    seed = int(p.get("seed", 20261019))
    spend = np.column_stack([data[c] for c in channels]).tolist() if channels else []
    ctrl = np.column_stack([data[c] for c in controls]).tolist() if controls else None
    out = mmm.fit_mmm(data[kpi], spend, names, controls=ctrl, experiment_priors=exp_priors, gates=policy.get("mmmGates"), seed=seed, total_budget=p.get("totalBudgetPerPeriod"))
    with store.tenant(req["tenant_id"]) as cur:
        cur.execute(
            """insert into mmm_runs (tenant_id, request_id, kpi_series_id, channel_series_ids, control_series_ids, priors, diagnostics, converged,
                   causal_language_allowed, posterior_summary, response_curves, budget_scenarios, assumptions, dataset_sha256, seed, code_version)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (
                req["tenant_id"], req["id"], kpi, channels, controls, jsonb(out.get("priors", {})), jsonb(out.get("diagnostics", {"status": out.get("status"), "reason": out.get("reason")})),
                bool(out.get("converged", False)), bool(out.get("causalLanguageAllowed", False)), jsonb(out.get("channels", {})), jsonb(out.get("responseCurves", {})),
                jsonb(out.get("budgetScenarios", {})), jsonb(out.get("assumptions", [out.get("reason", "abstained")])), _sha({k: v for k, v in data.items()}), seed, __version__,
            ),
        )
        run_id = cur.fetchone()["id"]
    return str(run_id), {"status": out.get("status"), "converged": out.get("converged", False), "periods": len(order), "sourceEvidenceIds": [str(meta[c]["source_evidence_id"]) for c in [kpi, *channels]]}


def handle_experiment(store: Store, req: dict) -> tuple[str, dict]:
    p = req["params"]
    with store.tenant(req["tenant_id"]) as cur:
        cur.execute("select * from experiments where id = %s", (p["experimentId"],))
        exp = cur.fetchone()
        if not exp:
            raise ValueError("experiment not found")
        cur.execute("select * from experiment_variants where experiment_id = %s order by key", (exp["id"],))
        variants = cur.fetchall()
        metric_names = [exp["target_metric"], *[g["metric"] for g in (exp["guardrails"] or [])]]
        cur.execute(
            """with exposed as (select distinct variant_id, unit_id from experiment_exposures where experiment_id = %s),
                    per_unit as (select o.variant_id, o.unit_id, o.metric, sum(o.value) as v
                                 from experiment_outcomes o join exposed e on e.variant_id = o.variant_id and e.unit_id = o.unit_id
                                 where o.experiment_id = %s and o.metric = any(%s) group by 1, 2, 3)
               select e.variant_id, m.metric, count(*) as n, count(*) filter (where coalesce(pu.v, 0) > 0) as successes,
                      avg(coalesce(pu.v, 0)) as mean, coalesce(var_samp(coalesce(pu.v, 0)), 0) as var
               from exposed e cross join unnest(%s::text[]) as m(metric)
               left join per_unit pu on pu.variant_id = e.variant_id and pu.unit_id = e.unit_id and pu.metric = m.metric
               group by 1, 2""",
            (exp["id"], exp["id"], metric_names, metric_names),
        )
        stats = {(str(r["variant_id"]), r["metric"]): r for r in cur.fetchall()}
        cur.execute("select variant_id, count(*) as n from experiment_assignments where experiment_id = %s group by 1", (exp["id"],))
        assigned = {str(r["variant_id"]): int(r["n"]) for r in cur.fetchall()}
    vs = []
    for v in variants:
        vid = str(v["id"])
        st = stats.get((vid, exp["target_metric"]), {"n": 0, "successes": 0, "mean": 0.0, "var": 0.0})
        g = {}
        for gr in exp["guardrails"] or []:
            gs = stats.get((vid, gr["metric"]))
            if gs:
                g[gr["metric"]] = {"successes": int(gs["successes"]), "n": int(gs["n"]), "mean": float(gs["mean"] or 0), "var": float(gs["var"] or 0)}
        vs.append({
            "key": v["key"], "id": vid, "isControl": v["is_control"], "weight": float(v["weight"]), "assigned": assigned.get(vid, 0),
            "exposed": int(st["n"]), "successes": int(st["successes"]), "n": int(st["n"]), "mean": float(st["mean"] or 0), "var": float(st["var"] or 0), "guardrails": g,
        })
    result = experiments.analyze({"metricType": exp["metric_type"], "guardrails": exp["guardrails"] or [], "decision": exp["decision_rules"], "plannedSamplePerVariant": exp["planned_sample_per_variant"]}, vs, seed=int(p.get("seed", 7)))
    allocation = None
    if exp["design"] == "bandit_thompson" and exp["min_exploration_share"] is not None:
        allocation = experiments.thompson_allocation(vs, exp["metric_type"], float(exp["min_exploration_share"]))
    with store.tenant(req["tenant_id"]) as cur:
        cur.execute(
            """insert into experiment_results (tenant_id, experiment_id, request_id, per_variant, prob_best, expected_loss, srm, guardrails, frequentist,
                   recommendation, recommendation_reason) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (req["tenant_id"], exp["id"], req["id"], jsonb(result["perVariant"]), jsonb(result["probBest"]), jsonb(result["expectedLoss"]), jsonb(result["srm"]),
             jsonb(result["guardrails"]), jsonb(result["frequentist"]), result["recommendation"], result["recommendationReason"]),
        )
        rid = cur.fetchone()["id"]
        if allocation:
            by_key = {v["key"]: v["id"] for v in vs}
            alloc_by_id = {by_key[k]: a for k, a in allocation.items()}
            cur.execute(
                """insert into bandit_states (experiment_id, tenant_id, posteriors, allocation, updated_at) values (%s,%s,%s,%s,now())
                   on conflict (experiment_id) do update set posteriors = excluded.posteriors, allocation = excluded.allocation, updated_at = now()""",
                (exp["id"], req["tenant_id"], jsonb({v["key"]: v["posterior"] for v in result["perVariant"]}), jsonb(alloc_by_id)),
            )
        emit(cur, req["tenant_id"], "experiment.result.computed", "experiment", str(exp["id"]), {"resultId": str(rid), "recommendation": result["recommendation"]})
    return str(rid), {"recommendation": result["recommendation"], "probBest": result["probBest"], "srmMismatch": result["srm"]["mismatch"], "allocationUpdated": allocation is not None}


def handle_trends(store: Store, req: dict) -> tuple[str | None, dict]:
    p = req["params"]
    alpha = float(p.get("alpha", 0.05))
    created = []
    for sid in p["seriesIds"]:
        with store.tenant(req["tenant_id"]) as cur:
            s, ts, vals = _series(cur, sid)
        r = trends.detect_trend(vals, [t.isoformat() for t in ts], alpha=alpha)
        if r.get("status") != "ok":
            continue
        with store.tenant(req["tenant_id"]) as cur:
            cur.execute(
                """insert into trends (tenant_id, request_id, series_id, topic, geography, window_start, window_end, baseline, direction, sen_slope,
                       mann_kendall_z, mann_kendall_p, velocity, change_points, confidence, freshness_status, evidence_ids)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'current',%s) returning id""",
                (req["tenant_id"], req["id"], sid, s["name"], s["geography"], ts[0], ts[-1], jsonb(r["baseline"]), r["direction"], r["senSlope"],
                 r["mannKendall"]["z"], r["mannKendall"]["p"], r["velocity"], jsonb(r["changePoints"]), r["confidence"], [s["source_evidence_id"]]),
            )
            tid = cur.fetchone()["id"]
            if r["direction"] != "flat":
                emit(cur, req["tenant_id"], "market.trend.detected", "trend", str(tid), {"seriesId": sid, "direction": r["direction"], "confidence": r["confidence"]})
            created.append(str(tid))
    return (created[0] if created else None), {"trends": created}


def handle_topics(store: Store, req: dict) -> tuple[str | None, dict]:
    p = req["params"]
    since = datetime.now(timezone.utc) - timedelta(days=int(p.get("sinceDays", 30)))
    corpus = p.get("corpus", "conversations")
    with store.tenant(req["tenant_id"]) as cur:
        if corpus == "conversations":
            cur.execute("select id, redacted_text as text from conversation_messages where role = 'customer' and created_at >= %s limit 5000", (since,))
        elif corpus == "social_interactions":
            cur.execute("select id, text from social_interactions where received_at >= %s limit 5000", (since,))
        elif corpus == "search_queries":
            cur.execute("select id, query as text from keyword_metrics where created_at >= %s limit 5000", (since,))
        else:
            raise ValueError(f"unknown corpus {corpus}")
        items = [{"id": str(r["id"]), "text": r["text"] or ""} for r in cur.fetchall()]
    out = topics.cluster_texts(items)
    ids = []
    with store.tenant(req["tenant_id"]) as cur:
        for c in out["clusters"]:
            cur.execute(
                "insert into topic_clusters (tenant_id, request_id, label, terms, size, sample_refs, corpus, window_start, window_end) values (%s,%s,%s,%s,%s,%s,%s,%s,now()) returning id",
                (req["tenant_id"], req["id"], c["label"], c["terms"], c["size"], jsonb(c["sampleRefs"]), corpus, since),
            )
            ids.append(str(cur.fetchone()["id"]))
    return (ids[0] if ids else None), {"status": out["status"], "clusters": len(ids), "k": out.get("k")}


FEATURES = ["events_30d", "sessions_30d", "purchases_90d", "revenue_90d", "days_since_last", "tenure_days"]

FEATURE_SQL = """
select p.id::text as profile_id,
  count(e.*) filter (where e.occurred_at >= %(cut)s - interval '30 days')::int as events_30d,
  count(distinct date_trunc('day', e.occurred_at)) filter (where e.occurred_at >= %(cut)s - interval '30 days')::int as sessions_30d,
  count(e.*) filter (where e.event_name in ('purchase','order_completed') and e.occurred_at >= %(cut)s - interval '90 days')::int as purchases_90d,
  coalesce(sum(e.revenue_micros) filter (where e.occurred_at >= %(cut)s - interval '90 days'), 0)::float8 / 1e6 as revenue_90d,
  coalesce(extract(epoch from (%(cut)s - max(e.occurred_at))) / 86400, 9999)::float8 as days_since_last,
  greatest(extract(epoch from (%(cut)s - p.created_at)) / 86400, 0)::float8 as tenure_days
from customer_profiles p
left join customer_events e on e.profile_id = p.id and e.occurred_at < %(cut)s
where p.deleted_at is null and p.merged_into_id is null and p.created_at < %(cut)s
group by p.id
"""


def handle_propensity(store: Store, req: dict) -> tuple[str | None, dict]:
    p = req["params"]
    horizon = int(p.get("horizonDays", 30))
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=horizon)
    target_events = p.get("targetEvents", ["purchase", "order_completed"])
    with store.tenant(req["tenant_id"]) as cur:
        # Features strictly before the cutoff; label strictly after (no temporal leakage).
        cur.execute(FEATURE_SQL, {"cut": cutoff})
        rows = cur.fetchall()
        cur.execute(
            "select distinct profile_id::text as pid from customer_events where event_name = any(%s) and occurred_at >= %s and occurred_at < %s and profile_id is not null",
            (target_events, cutoff, now),
        )
        positives = {r["pid"] for r in cur.fetchall()}
    for r in rows:
        r["label"] = r["profile_id"] in positives
    model = propensity.train(rows, FEATURES, "label", gates=p.get("gates"))
    drift = None
    current: list[dict] = []
    if model["status"] in ("champion", "candidate") and "coefficients" in model:
        # Training features are taken at the cutoff, serving features now: check the shift.
        with store.tenant(req["tenant_id"]) as cur:
            cur.execute(FEATURE_SQL, {"cut": now})
            current = cur.fetchall()
        drift = propensity.feature_drift(rows, current, FEATURES)
        model["metrics"]["drift"] = drift
        if not drift["ok"]:
            model["status"] = "candidate"  # never champion on drifted features; no scores are served
    with store.tenant(req["tenant_id"]) as cur:
        cur.execute(
            """insert into propensity_models (tenant_id, request_id, target, features, coefficients, standardization, metrics, feature_policy, status, dataset_sha256, code_version)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (
                req["tenant_id"], req["id"], p.get("target", "purchase_next_30d"), FEATURES, jsonb(model.get("coefficients", {})),
                jsonb({**model.get("standardization", {}), "covariance": model.get("covariance")}), jsonb(model.get("metrics", {"reason": model.get("reason")})),
                jsonb(model["featurePolicy"]), model["status"], _sha([[r["profile_id"], r["label"]] for r in rows]), __version__,
            ),
        )
        mid = cur.fetchone()["id"]
        scored = 0
        if drift is not None and drift["ok"]:
            for s in propensity.score(model, current, FEATURES):
                cur.execute(
                    "insert into propensity_scores (tenant_id, model_id, profile_id, score, interval_low, interval_high, reason_codes) values (%s,%s,%s,%s,%s,%s,%s)",
                    (req["tenant_id"], mid, s["profile_id"], s["score"], s["interval_low"], s["interval_high"], jsonb(s["reason_codes"])),
                )
                scored += 1
    if drift is not None and not drift["ok"]:
        with store.tenant(req["tenant_id"]) as cur:
            cur.execute(
                "insert into alerts (tenant_id, kind, severity, message, refs, dedup_key) values (%s,'analytics.propensity_drift','warning',%s,%s,%s) on conflict do nothing",
                (req["tenant_id"], f"Propensity model {mid}: feature drift ({', '.join(drift['drifted'])}); scores withheld", jsonb({"modelId": str(mid), "psi": drift["psi"]}), f"propensity-drift:{mid}"),
            )
    return str(mid), {"status": model["status"], "auc": (model.get("metrics") or {}).get("auc"), "scored": scored, "drifted": (drift or {}).get("drifted", [])}


def handle_anomalies(store: Store, req: dict) -> tuple[str | None, dict]:
    p = req["params"]
    found = 0
    for sid in p["seriesIds"]:
        with store.tenant(req["tenant_id"]) as cur:
            s, ts, vals = _series(cur, sid)
        an = trends.robust_anomalies(vals, SEASON.get(s["granularity"], 1), float(p.get("threshold", 3.5)))
        recent = [a for a in an if a["index"] >= len(vals) - int(p.get("recentPoints", 7))]
        with store.tenant(req["tenant_id"]) as cur:
            for a in recent:
                cur.execute(
                    "insert into alerts (tenant_id, kind, severity, message, refs, dedup_key) values (%s,'analytics.anomaly','warning',%s,%s,%s) on conflict do nothing",
                    (req["tenant_id"], f"Anomalous value {a['value']:.4g} in {s['name']} at {ts[a['index']].isoformat()}", jsonb({"seriesId": sid, **a}), f"anomaly:{sid}:{ts[a['index']].isoformat()}"),
                )
                found += 1
    return None, {"anomalies": found}


HANDLERS = {
    "forecast": handle_forecast,
    "mmm": handle_mmm,
    "experiment_analysis": handle_experiment,
    "trend_detection": handle_trends,
    "topic_clustering": handle_topics,
    "propensity_training": handle_propensity,
    "anomaly_scan": handle_anomalies,
}


def main(argv: list[str] | None = None) -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2
    dsn = secure_dsn(dsn)
    budget = float(os.environ.get("ANALYTICS_MAX_SECONDS", "900"))
    worker = f"analytics:{socket.gethostname()}:{os.getpid()}"
    store = Store(dsn)
    if not store.rls and os.environ.get("NODE_ENV") == "production":
        print("refusing to run: fg_tenant role unavailable (B-004)", file=sys.stderr)
        return 3
    started, processed, failed = time.monotonic(), 0, 0
    try:
        while time.monotonic() - started < budget:
            req = store.claim(worker)
            if not req:
                break
            handler = HANDLERS.get(req["kind"])
            try:
                if handler is None:
                    raise ValueError(f"analytics kind {req['kind']} is not supported by this job version")
                ref, summary = handler(store, req)
                store.complete(req, ref, summary)
                processed += 1
            except Exception as exc:  # noqa: BLE001 - recorded on the request
                failed += 1
                store.fail(req, f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=5)}")
    finally:
        store.close()
    print(dumps({"processed": processed, "failed": failed, "seconds": round(time.monotonic() - started, 1)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
