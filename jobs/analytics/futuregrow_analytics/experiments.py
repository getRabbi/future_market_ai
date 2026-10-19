"""M10 Experimentation & Bayesian bandits.

* binary metrics: Beta(1, 1) prior -> Beta(1 + successes, 1 + failures) posterior;
* continuous metrics: reference prior -> Student-t posterior for the mean;
* P(best), expected loss, relative lift intervals from Monte Carlo posterior draws;
* sample-ratio-mismatch chi-square test (assignment integrity);
* frequentist cross-check (two-proportion z / Welch t);
* guardrails evaluated as posterior probability of breaching a configured tolerance;
* Thompson-sampling allocation (Chapelle & Li 2011) with a configured exploration floor.

Decision thresholds are experiment/tenant configuration ([U]); without them the recommendation is
'inconclusive' rather than an invented ship rule.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import stats

SRM_ALPHA = 0.001  # conventional SRM alarm level (Fabijan et al. 2019)


def _draws_binary(successes: int, trials: int, n: int, rng) -> np.ndarray:
    return rng.beta(1 + successes, 1 + max(trials - successes, 0), size=n)


def _draws_continuous(nobs: int, mean: float, var: float, n: int, rng) -> np.ndarray:
    if nobs < 2:
        return np.full(n, np.nan)
    se = math.sqrt(max(var, 1e-12) / nobs)
    return mean + se * rng.standard_t(nobs - 1, size=n)


def srm_test(observed: list[int], weights: list[float]) -> dict:
    total = sum(observed)
    if total == 0:
        return {"pValue": None, "mismatch": False, "reason": "no assignments"}
    w = np.asarray(weights, dtype=float)
    expected = total * w / w.sum()
    chi2, p = stats.chisquare(observed, expected)
    return {"chi2": float(chi2), "pValue": float(p), "mismatch": bool(p < SRM_ALPHA), "alpha": SRM_ALPHA, "observed": observed, "expected": expected.tolist()}


def analyze(experiment: dict, variants: list[dict], seed: int = 7, draws: int = 40000) -> dict:
    """variants: [{key, isControl, weight, assigned, exposed, successes?, n?, mean?, var?, guardrails: {metric: {...}}}]"""
    rng = np.random.default_rng(seed)
    metric_type = experiment["metricType"]
    keys = [v["key"] for v in variants]
    control = next((v for v in variants if v.get("isControl")), variants[0])
    samples = {}
    per_variant = []
    for v in variants:
        if metric_type == "binary":
            s, n = int(v.get("successes", 0)), int(v.get("exposed", 0))
            d = _draws_binary(s, n, draws, rng)
            per_variant.append({"key": v["key"], "exposed": n, "successes": s, "rate": s / n if n else None, "posterior": {"family": "beta", "alpha": 1 + s, "beta": 1 + max(n - s, 0)}, "ci95": [float(np.quantile(d, 0.025)), float(np.quantile(d, 0.975))]})
        else:
            n, mean, var = int(v.get("n", 0)), float(v.get("mean", 0.0)), float(v.get("var", 0.0))
            d = _draws_continuous(n, mean, var, draws, rng)
            per_variant.append({"key": v["key"], "n": n, "mean": mean, "var": var, "posterior": {"family": "student_t", "df": max(n - 1, 0), "loc": mean, "scale": math.sqrt(var / n) if n > 1 else None}, "ci95": [float(np.nanquantile(d, 0.025)), float(np.nanquantile(d, 0.975))] if n > 1 else None})
        samples[v["key"]] = d

    mat = np.stack([samples[k] for k in keys])
    valid = not np.isnan(mat).any()
    prob_best, expected_loss = {}, {}
    if valid:
        best_idx = np.argmax(mat, axis=0)
        mx = mat.max(axis=0)
        for i, k in enumerate(keys):
            prob_best[k] = float(np.mean(best_idx == i))
            expected_loss[k] = float(np.mean(mx - mat[i]))
        c = samples[control["key"]]
        for pv in per_variant:
            if pv["key"] == control["key"]:
                continue
            rel = (samples[pv["key"]] - c) / np.where(np.abs(c) > 1e-12, np.abs(c), np.nan)
            pv["relativeLift"] = {"mean": float(np.nanmean(rel)), "ci95": [float(np.nanquantile(rel, 0.025)), float(np.nanquantile(rel, 0.975))], "probPositive": float(np.nanmean(rel > 0))}

    srm = srm_test([int(v.get("assigned", 0)) for v in variants], [float(v.get("weight", 1.0)) for v in variants])
    freq = _frequentist(metric_type, control, [v for v in variants if v is not control])
    guardrails = _guardrails(experiment.get("guardrails", []), variants, control, rng, draws)

    decision = experiment.get("decision") or {}
    p_thr, loss_thr = decision.get("probBestThreshold"), decision.get("maxExpectedLoss")
    planned = experiment.get("plannedSamplePerVariant")
    exposed_min = min(int(v.get("exposed", v.get("n", 0))) for v in variants)
    if srm["mismatch"]:
        rec, why = "invalid_srm", f"sample ratio mismatch (p={srm['pValue']:.2e}); results are not trustworthy"
    elif any(g["breached"] for g in guardrails):
        rec, why = "guardrail_breach", "guardrail breach: " + ", ".join(g["metric"] for g in guardrails if g["breached"])
    elif not valid:
        rec, why = "continue", "insufficient observations for a posterior"
    elif planned and exposed_min < planned:
        rec, why = "continue", f"planned sample not reached ({exposed_min}/{planned} per variant)"
    elif p_thr is None or loss_thr is None:
        rec, why = "inconclusive", "decision thresholds unconfigured [U]; no ship/stop rule applied"
    else:
        best = max(prob_best, key=prob_best.get)
        if prob_best[best] >= p_thr and expected_loss[best] <= loss_thr:
            if best == control["key"]:
                rec, why = "stop_rollback", f"control is best with P={prob_best[best]:.3f}"
            else:
                rec, why = "ship_candidate", f"{best} best with P={prob_best[best]:.3f}, expected loss {expected_loss[best]:.5f}"
        else:
            rec, why = "inconclusive", "no variant met the configured decision thresholds"
    return {
        "perVariant": per_variant,
        "probBest": prob_best,
        "expectedLoss": expected_loss,
        "srm": srm,
        "frequentist": freq,
        "guardrails": guardrails,
        "recommendation": rec,
        "recommendationReason": why,
        "inferenceKind": "randomized_test",
    }


def _frequentist(metric_type: str, control: dict, others: list[dict]) -> dict:
    out = {}
    for v in others:
        if metric_type == "binary":
            n1, s1, n2, s2 = int(control.get("exposed", 0)), int(control.get("successes", 0)), int(v.get("exposed", 0)), int(v.get("successes", 0))
            if min(n1, n2) == 0:
                continue
            p1, p2 = s1 / n1, s2 / n2
            p = (s1 + s2) / (n1 + n2)
            se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
            z = (p2 - p1) / se if se else 0.0
            se_diff = math.sqrt(p1 * (1 - p1) / n1 + p2 * (1 - p2) / n2)
            out[v["key"]] = {"test": "two_proportion_z", "z": z, "pValue": float(2 * stats.norm.sf(abs(z))), "diff": p2 - p1, "ci95": [p2 - p1 - 1.96 * se_diff, p2 - p1 + 1.96 * se_diff]}
        else:
            n1, m1, v1 = int(control.get("n", 0)), float(control.get("mean", 0)), float(control.get("var", 0))
            n2, m2, v2 = int(v.get("n", 0)), float(v.get("mean", 0)), float(v.get("var", 0))
            if min(n1, n2) < 2:
                continue
            se = math.sqrt(v1 / n1 + v2 / n2)
            t = (m2 - m1) / se if se else 0.0
            df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1)) if se else n1 + n2 - 2
            out[v["key"]] = {"test": "welch_t", "t": t, "df": df, "pValue": float(2 * stats.t.sf(abs(t), df)), "diff": m2 - m1}
    return out


def _guardrails(configs: list[dict], variants: list[dict], control: dict, rng, draws: int) -> list[dict]:
    """configs: [{metric, type: binary|continuous, direction: increase_is_bad|decrease_is_bad, maxRelativeChange, maxBreachProbability}]"""
    out = []
    for g in configs:
        metric = g["metric"]
        for v in variants:
            if v is control:
                continue
            cg, vg = control.get("guardrails", {}).get(metric), v.get("guardrails", {}).get(metric)
            if not cg or not vg:
                out.append({"metric": metric, "variant": v["key"], "breached": False, "status": "no_data"})
                continue
            if g.get("type", "binary") == "binary":
                dc = _draws_binary(cg["successes"], cg["n"], draws, rng)
                dv = _draws_binary(vg["successes"], vg["n"], draws, rng)
            else:
                dc = _draws_continuous(cg["n"], cg["mean"], cg["var"], draws, rng)
                dv = _draws_continuous(vg["n"], vg["mean"], vg["var"], draws, rng)
            rel = (dv - dc) / np.maximum(np.abs(dc), 1e-12)
            tol = g.get("maxRelativeChange")
            pmax = g.get("maxBreachProbability")
            if tol is None or pmax is None:
                out.append({"metric": metric, "variant": v["key"], "breached": False, "status": "unconfigured"})
                continue
            bad = rel > tol if g.get("direction") == "increase_is_bad" else rel < -tol
            p_breach = float(np.nanmean(bad))
            out.append({"metric": metric, "variant": v["key"], "probBreach": p_breach, "breached": p_breach > pmax, "status": "evaluated", "relativeChangeMean": float(np.nanmean(rel))})
    return out


def thompson_allocation(variants: list[dict], metric_type: str, min_share: float, seed: int = 11, draws: int = 20000) -> dict:
    """Allocation proportional to P(arm is best), floored at `min_share` (bounded exploration)."""
    rng = np.random.default_rng(seed)
    if metric_type == "binary":
        mat = np.stack([_draws_binary(int(v.get("successes", 0)), int(v.get("exposed", 0)), draws, rng) for v in variants])
    else:
        mat = np.stack([_draws_continuous(int(v.get("n", 0)), float(v.get("mean", 0)), float(v.get("var", 0)), draws, rng) for v in variants])
    if np.isnan(mat).any():
        k = len(variants)
        return {v["key"]: 1.0 / k for v in variants}
    p = np.bincount(np.argmax(mat, axis=0), minlength=len(variants)) / draws
    k = len(variants)
    floor = min(max(min_share, 0.0), 1.0 / k)
    alloc = floor + (1 - k * floor) * p
    return {v["key"]: float(a) for v, a in zip(variants, alloc)}
