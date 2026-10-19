"""M04 Market & Trend Intelligence: trend detection on signal series.

A trend object states window, baseline, direction, Sen's slope, Mann-Kendall significance and
change points. It is labelled `correlation` and never asserts business impact (product plan M04 AC).
"""

from __future__ import annotations

import math

import numpy as np
from scipy import stats


def mann_kendall(y: np.ndarray) -> dict:
    """Mann-Kendall trend test with tie-corrected variance (Kendall 1975)."""
    n = len(y)
    if n < 8:
        return {"s": 0, "z": 0.0, "p": 1.0, "n": n}
    s = 0
    for i in range(n - 1):
        s += int(np.sum(np.sign(y[i + 1 :] - y[i])))
    _, counts = np.unique(y, return_counts=True)
    ties = counts[counts > 1]
    var = (n * (n - 1) * (2 * n + 5) - float(np.sum(ties * (ties - 1) * (2 * ties + 5)))) / 18.0
    if var <= 0:
        return {"s": s, "z": 0.0, "p": 1.0, "n": n}
    z = (s - 1) / math.sqrt(var) if s > 0 else (s + 1) / math.sqrt(var) if s < 0 else 0.0
    return {"s": int(s), "z": float(z), "p": float(2 * stats.norm.sf(abs(z))), "n": n}


def sens_slope(y: np.ndarray) -> float:
    n = len(y)
    slopes = [(y[j] - y[i]) / (j - i) for i in range(n - 1) for j in range(i + 1, n)]
    return float(np.median(slopes)) if slopes else 0.0


def _seg_cost(cum: np.ndarray, cum2: np.ndarray, a: int, b: int) -> float:
    n = b - a
    s = cum[b] - cum[a]
    s2 = cum2[b] - cum2[a]
    return float(s2 - s * s / n)


def change_points(y: np.ndarray, min_size: int = 6, max_cps: int = 3) -> list[int]:
    """Binary segmentation for mean shifts with a BIC penalty (sigma estimated by MAD of diffs)."""
    n = len(y)
    if n < 2 * min_size:
        return []
    sigma = float(np.median(np.abs(np.diff(y))) / (0.6745 * math.sqrt(2))) or float(np.std(y)) or 1.0
    penalty = 2 * sigma**2 * math.log(n)  # BIC-style
    cum = np.concatenate([[0.0], np.cumsum(y)])
    cum2 = np.concatenate([[0.0], np.cumsum(y * y)])
    cps: list[int] = []
    segments = [(0, n)]
    while segments and len(cps) < max_cps:
        best = None
        for a, b in segments:
            if b - a < 2 * min_size:
                continue
            base = _seg_cost(cum, cum2, a, b)
            for t in range(a + min_size, b - min_size + 1):
                gain = base - _seg_cost(cum, cum2, a, t) - _seg_cost(cum, cum2, t, b)
                if best is None or gain > best[0]:
                    best = (gain, t, a, b)
        if best is None or best[0] <= penalty:
            break
        _, t, a, b = best
        cps.append(t)
        segments.remove((a, b))
        segments += [(a, t), (t, b)]
    return sorted(cps)


def detect_trend(values: list[float], timestamps: list[str], alpha: float = 0.05) -> dict:
    y = np.asarray(values, dtype=float)
    n = len(y)
    if n < 8:
        return {"status": "insufficient_data", "n": n}
    mk = mann_kendall(y)
    slope = sens_slope(y)
    half = max(n // 2, 1)
    base_mean, base_sd = float(np.mean(y[:half])), float(np.std(y[:half], ddof=1)) if half > 1 else 0.0
    level = float(np.mean(np.abs(y))) or 1.0
    cps = change_points(y)
    shifts = []
    for cp in cps:
        before, after = y[max(0, cp - 12) : cp], y[cp : cp + 12]
        if len(before) >= 3 and len(after) >= 3:
            t = stats.ttest_ind(after, before, equal_var=False)
            shifts.append({"index": cp, "ts": timestamps[cp], "meanBefore": float(before.mean()), "meanAfter": float(after.mean()), "pValue": float(t.pvalue)})
    sig_shift = [s for s in shifts if s["pValue"] < alpha]
    if mk["p"] < alpha:
        direction = "rising" if slope > 0 else "falling"
    elif sig_shift:
        last = sig_shift[-1]
        direction = "shift_up" if last["meanAfter"] > last["meanBefore"] else "shift_down"
    else:
        direction = "flat"
    p_used = mk["p"] if direction in ("rising", "falling") else (sig_shift[-1]["pValue"] if sig_shift else mk["p"])
    return {
        "status": "ok",
        "direction": direction,
        "senSlope": slope,
        "velocity": slope / level,
        "mannKendall": mk,
        "changePoints": shifts,
        "baseline": {"mean": base_mean, "sd": base_sd, "window": [timestamps[0], timestamps[half - 1]]},
        "confidence": float(max(0.0, min(1.0, 1 - p_used))),
        "alpha": alpha,
        "inferenceKind": "correlation",
    }


def robust_anomalies(values: list[float], season_length: int, threshold: float = 3.5) -> list[dict]:
    """Robust z-scores (Iglewicz & Hoaglin modified z) of seasonal-naive residuals."""
    y = np.asarray(values, dtype=float)
    m = season_length if season_length >= 2 and len(y) > 2 * season_length else 1
    r = y[m:] - y[:-m]
    if len(r) < 8:
        return []
    med = float(np.median(r))
    mad = float(np.median(np.abs(r - med)))
    if mad == 0:
        return []
    z = 0.6745 * (r - med) / mad
    return [{"index": int(i + m), "value": float(y[i + m]), "modifiedZ": float(z[i])} for i in np.where(np.abs(z) > threshold)[0]]
