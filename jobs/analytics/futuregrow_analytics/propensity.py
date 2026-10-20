"""M11 Audience & Propensity Engine: calibrated, explainable propensity scores.

L2-regularised logistic regression fitted by Newton-Raphson (IRLS) on standardised features.
Score uncertainty comes from the Laplace approximation (posterior covariance = inverse Hessian),
propagated to each profile with the delta method. Reason codes are the largest signed feature
contributions. Sensitive attributes and known proxies are rejected before training.
"""

from __future__ import annotations

import hashlib
import math

import numpy as np

FORBIDDEN_FEATURE_PATTERNS = (
    "age", "gender", "sex", "race", "ethnic", "religion", "health", "disab", "pregnan", "sexual",
    "political", "union", "biometric", "genetic", "zip", "postal", "postcode", "nationality", "immigration",
)


def feature_policy(features: list[str]) -> dict:
    banned = [f for f in features if any(p in f.lower() for p in FORBIDDEN_FEATURE_PATTERNS)]
    return {"allowed": not banned, "rejected": banned, "patterns": list(FORBIDDEN_FEATURE_PATTERNS)}


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1.0, max_iter: int = 100, tol: float = 1e-8):
    n, d = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    w = np.zeros(d + 1)
    reg = np.full(d + 1, l2)
    reg[0] = 1e-6  # (almost) unpenalised intercept
    for _ in range(max_iter):
        p = _sigmoid(Xb @ w)
        grad = Xb.T @ (p - y) + reg * w
        W = p * (1 - p)
        H = (Xb * W[:, None]).T @ Xb + np.diag(reg)
        step = np.linalg.solve(H, grad)
        w -= step
        if float(np.max(np.abs(step))) < tol:
            break
    p = _sigmoid(Xb @ w)
    H = (Xb * (p * (1 - p))[:, None]).T @ Xb + np.diag(reg)
    cov = np.linalg.inv(H)
    return w, cov


def auc(y: np.ndarray, s: np.ndarray) -> float:
    """Mann-Whitney AUC with average ranks for ties."""
    pos, neg = int(y.sum()), int(len(y) - y.sum())
    if pos == 0 or neg == 0:
        return float("nan")
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i : j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def calibration(y: np.ndarray, p: np.ndarray, bins: int = 10) -> dict:
    edges = np.linspace(0, 1, bins + 1)
    table, ece = [], 0.0
    for b in range(bins):
        mask = (p >= edges[b]) & (p < edges[b + 1] if b < bins - 1 else p <= edges[b + 1])
        if not mask.any():
            continue
        conf, acc = float(p[mask].mean()), float(y[mask].mean())
        ece += mask.mean() * abs(conf - acc)
        table.append({"bin": b, "count": int(mask.sum()), "meanPredicted": conf, "observedRate": acc})
    return {"ece": float(ece), "bins": table}


def _split(ids: list[str], test_fraction: float) -> np.ndarray:
    """Deterministic hash split by profile id (reproducible, no leakage between runs)."""
    return np.array([int(hashlib.sha256(i.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < test_fraction for i in ids])


def train(rows: list[dict], features: list[str], target: str, l2: float = 1.0, gates: dict | None = None, test_fraction: float = 0.25) -> dict:
    policy = feature_policy(features)
    if not policy["allowed"]:
        return {"status": "rejected", "reason": f"forbidden/sensitive features: {policy['rejected']}", "featurePolicy": policy}
    if len(rows) < 50:
        return {"status": "rejected", "reason": f"insufficient training rows ({len(rows)} < 50)", "featurePolicy": policy}
    ids = [r["profile_id"] for r in rows]
    X = np.array([[float(r.get(f) or 0.0) for f in features] for r in rows])
    y = np.array([1.0 if r.get(target) else 0.0 for r in rows])
    if y.sum() < 5 or (len(y) - y.sum()) < 5:
        return {"status": "rejected", "reason": "fewer than 5 examples in a class", "featurePolicy": policy}
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd[sd == 0] = 1.0
    Xs = (X - mu) / sd
    test = _split(ids, test_fraction)
    if test.all() or (~test).all():
        test = np.arange(len(ids)) % 4 == 0
    w, cov = fit_logistic(Xs[~test], y[~test], l2=l2)
    p_test = _sigmoid(np.hstack([np.ones((test.sum(), 1)), Xs[test]]) @ w)
    yt = y[test]
    base = float(y[~test].mean())
    metrics = {
        "auc": auc(yt, p_test),
        "brier": float(np.mean((p_test - yt) ** 2)),
        "brierBaseline": float(np.mean((base - yt) ** 2)),
        "logLoss": float(-np.mean(yt * np.log(np.clip(p_test, 1e-12, 1)) + (1 - yt) * np.log(np.clip(1 - p_test, 1e-12, 1)))),
        "baseRate": base,
        "nTrain": int((~test).sum()),
        "nTest": int(test.sum()),
        "calibration": calibration(yt, p_test),
    }
    if gates and gates.get("minAuc") is not None and gates.get("maxEce") is not None:
        promote = (metrics["auc"] >= gates["minAuc"]) and (metrics["calibration"]["ece"] <= gates["maxEce"]) and metrics["brier"] < metrics["brierBaseline"]
        status = "champion" if promote else "candidate"
    else:
        status = "candidate"  # [U] promotion gates unconfigured
    return {
        "status": status,
        "coefficients": {"intercept": float(w[0]), **{f: float(c) for f, c in zip(features, w[1:])}},
        "covariance": cov.tolist(),
        "standardization": {"mean": dict(zip(features, map(float, mu))), "sd": dict(zip(features, map(float, sd)))},
        "metrics": metrics,
        "featurePolicy": policy,
    }


PSI_DRIFT_THRESHOLD = 0.25  # conventional "significant population shift" level


def psi(reference: np.ndarray, current: np.ndarray, bins: int = 10, eps: float = 1e-4) -> float:
    """Population stability index of `current` against `reference` on reference-quantile bins."""
    if reference.size == 0 or current.size == 0:
        return float("inf")
    edges = np.unique(np.quantile(reference, np.linspace(0, 1, bins + 1)))
    if edges.size < 2:  # constant reference: any change in value is a full shift
        same = np.isclose(current, edges[0]).mean()
        return 0.0 if same == 1.0 else float(np.log((1 - same + eps) / eps))
    inner = edges[1:-1]
    ref_p = np.bincount(np.searchsorted(inner, reference, side="right"), minlength=edges.size - 1) / reference.size
    cur_p = np.bincount(np.searchsorted(inner, current, side="right"), minlength=edges.size - 1) / current.size
    ref_p, cur_p = np.clip(ref_p, eps, None), np.clip(cur_p, eps, None)
    return float(np.sum((cur_p - ref_p) * np.log(cur_p / ref_p)))


def feature_drift(train_rows: list[dict], serve_rows: list[dict], features: list[str], threshold: float = PSI_DRIFT_THRESHOLD) -> dict:
    """Training-vs-serving feature drift. Scores from a drifted model are not served."""
    values = {f: psi(np.array([float(r.get(f) or 0.0) for r in train_rows]), np.array([float(r.get(f) or 0.0) for r in serve_rows])) for f in features}
    drifted = sorted(f for f, v in values.items() if v > threshold)
    return {"method": "psi", "threshold": threshold, "psi": values, "drifted": drifted, "ok": not drifted}


def score(model: dict, rows: list[dict], features: list[str]) -> list[dict]:
    coef = model["coefficients"]
    w = np.array([coef["intercept"]] + [coef[f] for f in features])
    cov = np.array(model["covariance"])
    mu = np.array([model["standardization"]["mean"][f] for f in features])
    sd = np.array([model["standardization"]["sd"][f] for f in features])
    out = []
    for r in rows:
        x = (np.array([float(r.get(f) or 0.0) for f in features]) - mu) / sd
        xb = np.concatenate([[1.0], x])
        z = float(xb @ w)
        se = math.sqrt(max(float(xb @ cov @ xb), 0.0))
        contrib = sorted(((f, float(c * xi)) for f, c, xi in zip(features, w[1:], x)), key=lambda t: -abs(t[1]))[:3]
        out.append(
            {
                "profile_id": r["profile_id"],
                "score": float(_sigmoid(np.array([z]))[0]),
                "interval_low": float(_sigmoid(np.array([z - 1.96 * se]))[0]),
                "interval_high": float(_sigmoid(np.array([z + 1.96 * se]))[0]),
                "reason_codes": [{"feature": f, "contribution": c, "direction": "increases" if c > 0 else "decreases"} for f, c in contrib],
            }
        )
    return out
