"""M08 Forecasting & Scenario Engine.

Every forecast is a predictive distribution, not a point guess:

* candidate models: naive, seasonal naive, drift, simple exponential smoothing, damped Holt,
  damped additive Holt-Winters (parameters fitted by SSE minimisation);
* rolling-origin backtests (no temporal leakage: each fold only sees data before its origin);
* split-conformal prediction intervals calibrated *per horizon step* from backtest residuals,
  so nominal coverage is empirically checked rather than assumed;
* champion/challenger selection against the seasonal-naive baseline with tenant gates; failing
  calibration falls back to the baseline or abstains (product plan M08 AC).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit

QUANTILES = (0.025, 0.1, 0.5, 0.9, 0.975)


# --------------------------------------------------------------------------- models


@dataclass
class Fitted:
    name: str
    forecast: Callable[[int], np.ndarray]
    in_sample_residuals: np.ndarray
    params: dict[str, float] = field(default_factory=dict)


def _naive(y: np.ndarray, m: int) -> Fitted:
    last = y[-1]
    return Fitted("naive", lambda h: np.full(h, last), np.diff(y))


def _seasonal_naive(y: np.ndarray, m: int) -> Fitted:
    if m < 2 or len(y) < 2 * m:
        f = _naive(y, m)
        f.name = "seasonal_naive"
        return f
    season = y[-m:]
    return Fitted("seasonal_naive", lambda h: np.array([season[i % m] for i in range(h)]), y[m:] - y[:-m])


def _drift(y: np.ndarray, m: int) -> Fitted:
    n = len(y)
    slope = (y[-1] - y[0]) / max(n - 1, 1)
    return Fitted("drift", lambda h: y[-1] + slope * np.arange(1, h + 1), np.diff(y) - slope, {"slope": float(slope)})


def _hw_filter(y: np.ndarray, m: int, alpha: float, beta: float, gamma: float, phi: float, trend: bool, seasonal: bool):
    """Damped additive Holt-Winters recursions. Returns one-step-ahead errors and final state."""
    n = len(y)
    if seasonal:
        level = float(np.mean(y[:m]))
        b = float((np.mean(y[m : 2 * m]) - np.mean(y[:m])) / m) if trend and n >= 2 * m else 0.0
        s = list(y[:m] - level)
        start = m
    else:
        level = float(y[0])
        b = float(y[1] - y[0]) if trend and n > 1 else 0.0
        s = []
        start = 1
    errors = np.zeros(n - start)
    for t in range(start, n):
        season = s[t - m] if seasonal else 0.0
        pred = level + (phi * b if trend else 0.0) + season
        e = y[t] - pred
        errors[t - start] = e
        new_level = alpha * (y[t] - season) + (1 - alpha) * (level + (phi * b if trend else 0.0))
        if trend:
            b = beta * (new_level - level) + (1 - beta) * phi * b
        if seasonal:
            s.append(gamma * (y[t] - new_level) + (1 - gamma) * season)
        level = new_level
    return errors, level, b, s


def _fit_hw(y: np.ndarray, m: int, trend: bool, seasonal: bool, name: str, quick: bool = False) -> Fitted | None:
    if seasonal and (m < 2 or len(y) < 2 * m + 2):
        return None
    if len(y) < 4:
        return None

    def unpack(p: np.ndarray):
        alpha, beta, gamma, phi = expit(p)
        phi = 0.8 + 0.18 * phi  # damping in [0.8, 0.98]
        return float(alpha), float(beta * alpha), float(gamma * (1 - alpha)), float(phi)

    def sse(p: np.ndarray) -> float:
        a, b, g, ph = unpack(p)
        e, *_ = _hw_filter(y, m, a, b, g, ph, trend, seasonal)
        v = float(np.dot(e, e))
        return v if math.isfinite(v) else 1e300

    best = None
    starts = (np.array([0.0, -1.0, -1.0, 1.0]),) if quick else (np.array([0.0, -1.0, -1.0, 1.0]), np.array([-1.5, -2.0, -2.0, 2.0]), np.array([1.0, 0.0, 0.0, 0.0]))
    for x0 in starts:
        res = minimize(sse, x0, method="Nelder-Mead", options={"maxiter": 250 if quick else 800, "xatol": 1e-4, "fatol": 1e-8})
        if best is None or res.fun < best.fun:
            best = res
    a, b, g, ph = unpack(best.x)
    errors, level, slope, s = _hw_filter(y, m, a, b, g, ph, trend, seasonal)
    n = len(y)

    def fc(h: int) -> np.ndarray:
        out = np.zeros(h)
        for k in range(1, h + 1):
            damp = sum(ph**i for i in range(1, k + 1)) if trend else 0.0
            season = s[n - m + ((k - 1) % m)] if seasonal else 0.0
            out[k - 1] = level + damp * slope + season
        return out

    return Fitted(name, fc, errors, {"alpha": a, "beta": b, "gamma": g, "phi": ph})


def candidate_models(m: int, quick: bool = False) -> dict[str, Callable[[np.ndarray], Fitted | None]]:
    """Model factories. `quick` uses a single optimiser start (backtest refits on small CPUs)."""
    return {
        "naive": lambda y: _naive(y, m),
        "seasonal_naive": lambda y: _seasonal_naive(y, m),
        "drift": lambda y: _drift(y, m),
        "ses": lambda y: _fit_hw(y, m, trend=False, seasonal=False, name="ses", quick=quick),
        "holt_damped": lambda y: _fit_hw(y, m, trend=True, seasonal=False, name="holt_damped", quick=quick),
        "holt_winters_damped": lambda y: _fit_hw(y, m, trend=True, seasonal=True, name="holt_winters_damped", quick=quick),
    }


# --------------------------------------------------------------------------- metrics


def mase_scale(y: np.ndarray, m: int) -> float:
    lag = m if m >= 2 and len(y) > m else 1
    d = np.abs(y[lag:] - y[:-lag])
    scale = float(np.mean(d)) if len(d) else 0.0
    return scale if scale > 0 else 1.0


def smape(actual: np.ndarray, pred: np.ndarray) -> float:
    denom = np.abs(actual) + np.abs(pred)
    mask = denom > 0
    return float(np.mean(2 * np.abs(actual[mask] - pred[mask]) / denom[mask])) if mask.any() else 0.0


def pinball(actual: float, q: float, value: float) -> float:
    diff = actual - value
    return max(q * diff, (q - 1) * diff)


def crps_from_quantiles(actual: float, qs: dict[float, float]) -> float:
    """Quantile-score approximation of CRPS (average pinball over quantile levels, x2)."""
    return 2 * float(np.mean([pinball(actual, q, v) for q, v in qs.items()]))


# --------------------------------------------------------------------------- backtest + conformal


@dataclass
class BacktestResult:
    model: str
    folds: int
    mase: float
    smape: float
    rmse: float
    coverage80: float
    coverage95: float
    pinball: float
    crps: float
    residuals_by_step: list[list[float]]


def rolling_origin(y: np.ndarray, m: int, horizon: int, folds: int, fit: Callable[[np.ndarray], Fitted | None]) -> BacktestResult | None:
    """Expanding-window evaluation with step-1 origins (time-series cross-validation).

    Fold k trains on y[:origin_k] only (no leakage) and forecasts the next `horizon` points, so
    every horizon step collects `folds` genuinely out-of-sample residuals for conformal calibration.
    """
    n = len(y)
    min_train = max(2 * m + 2 if m >= 2 else 8, 8)
    origins = [o for o in range(n - horizon - folds + 1, n - horizon + 1) if o >= min_train]
    if len(origins) < 2:
        return None
    scale = mase_scale(y[: origins[0]], m)
    residuals: list[list[float]] = [[] for _ in range(horizon)]
    errs, sm, preds_all, act_all = [], [], [], []
    fold_preds: list[np.ndarray] = []
    for o in origins:
        f = fit(y[:o])
        if f is None:
            return None
        p = f.forecast(horizon)
        fold_preds.append(p)
        a = y[o : o + horizon]
        for k in range(horizon):
            residuals[k].append(float(a[k] - p[k]))
        errs.extend(np.abs(a - p) / scale)
        sm.append(smape(a, p))
        preds_all.extend(p)
        act_all.extend(a)
    # Leave-one-fold-out conformal check of interval calibration.
    cov80, cov95, pin, crps = [], [], [], []
    for i, o in enumerate(origins):
        p = fold_preds[i]
        a = y[o : o + horizon]
        for k in range(horizon):
            others = [r for j, r in enumerate(residuals[k]) if j != i]
            if len(others) < 2:
                continue
            qs = conformal_quantiles(p[k], np.array(others))
            cov80.append(qs[0.1] <= a[k] <= qs[0.9])
            cov95.append(qs[0.025] <= a[k] <= qs[0.975])
            pin.append(np.mean([pinball(a[k], q, v) for q, v in qs.items()]) / scale)
            crps.append(crps_from_quantiles(a[k], qs) / scale)
    pa, aa = np.array(preds_all), np.array(act_all)
    return BacktestResult(
        model=fit.__name__ if hasattr(fit, "__name__") else "model",
        folds=len(origins),
        mase=float(np.mean(errs)),
        smape=float(np.mean(sm)),
        rmse=float(np.sqrt(np.mean((aa - pa) ** 2))),
        coverage80=float(np.mean(cov80)) if cov80 else float("nan"),
        coverage95=float(np.mean(cov95)) if cov95 else float("nan"),
        pinball=float(np.mean(pin)) if pin else float("nan"),
        crps=float(np.mean(crps)) if crps else float("nan"),
        residuals_by_step=residuals,
    )


def conformal_quantiles(point: float, residuals: np.ndarray) -> dict[float, float]:
    """Split-conformal predictive quantiles from exchangeable out-of-sample residuals.

    Uses the finite-sample corrected order statistic ceil((n+1)p)/n for each tail, so an interval
    built from n residuals has coverage >= its nominal level when n is large enough, and is honestly
    wider (clipped to the residual extremes) when n is small.
    """
    r = np.sort(np.asarray(residuals, dtype=float))
    n = len(r)
    out: dict[float, float] = {}
    for q in QUANTILES:
        if q == 0.5:
            lvl = 0.5
        elif q > 0.5:
            lvl = min(1.0, math.ceil((n + 1) * q) / n)
        else:
            lvl = max(0.0, 1.0 - min(1.0, math.ceil((n + 1) * (1 - q)) / n))
        out[q] = float(point + np.quantile(r, lvl, method="linear"))
    return out


# --------------------------------------------------------------------------- drift


def cusum_drift(residuals: np.ndarray, k: float = 0.5, h: float = 5.0) -> dict:
    """Two-sided standardised CUSUM on one-step residuals (Page 1954). Thresholds in sigma units."""
    if len(residuals) < 8:
        return {"detected": False, "reason": "insufficient residuals"}
    med = float(np.median(residuals))
    mad = float(np.median(np.abs(residuals - med))) * 1.4826 or float(np.std(residuals)) or 1.0
    z = (residuals - med) / mad
    pos = neg = 0.0
    for i, v in enumerate(z):
        pos = max(0.0, pos + v - k)
        neg = min(0.0, neg + v + k)
        if pos > h or neg < -h:
            return {"detected": True, "index": i, "direction": "up" if pos > h else "down", "k": k, "h": h}
    return {"detected": False, "k": k, "h": h}


# --------------------------------------------------------------------------- orchestration


@dataclass
class ForecastOutput:
    status: str  # champion_selected | fallback_baseline | abstained
    champion: str
    baseline: str
    selection_reason: str
    candidates: list[dict]
    gate: dict
    calibration: dict
    drift: dict
    points: list[dict]


def run_forecast(y: list[float], timestamps: list[str], future_timestamps: list[str], season_length: int, gates: dict | None, folds: int = 20) -> ForecastOutput:
    arr = np.asarray(y, dtype=float)
    h = len(future_timestamps)
    if h == 0:
        raise ValueError("horizon must be positive")
    if len(arr) < max(2 * season_length + 2, 8) + h + max(folds // 2, 4):
        return ForecastOutput(
            "abstained", "none", "seasonal_naive", f"insufficient history: {len(arr)} points for horizon {h}", [], {"configured": gates is not None}, {}, {}, []
        )
    models = candidate_models(season_length)
    quick = candidate_models(season_length, quick=True)
    results: dict[str, BacktestResult] = {}
    for name, fit in quick.items():
        bt = rolling_origin(arr, season_length, h, folds, fit)
        if bt is not None:
            bt.model = name
            results[name] = bt
    baseline = "seasonal_naive" if "seasonal_naive" in results else "naive"
    if baseline not in results:
        return ForecastOutput("abstained", "none", baseline, "baseline could not be backtested", [], {"configured": gates is not None}, {}, {}, [])
    base = results[baseline]

    min_folds = (gates or {}).get("minBacktestFolds", 2)
    max_ratio = (gates or {}).get("maxMaseRatioToBaseline")
    tol = (gates or {}).get("intervalCoverageTolerance")

    def calibrated(r: BacktestResult) -> bool:
        if tol is None or math.isnan(r.coverage80):
            return False
        return abs(r.coverage80 - 0.8) <= tol and abs(r.coverage95 - 0.95) <= tol

    ranked = sorted(results.values(), key=lambda r: (r.mase, r.crps if not math.isnan(r.crps) else 1e9))
    champion = ranked[0]
    gate = {"configured": gates is not None, "maxMaseRatioToBaseline": max_ratio, "intervalCoverageTolerance": tol, "minBacktestFolds": min_folds}

    if gates is None:
        # [U] gates unconfigured: never promote a challenger over the baseline automatically.
        chosen, status, reason = base, "fallback_baseline", "deployment gates unconfigured; baseline used (gate_unconfigured)"
    elif champion.folds < min_folds:
        chosen, status, reason = base, "fallback_baseline", f"champion has {champion.folds} folds < {min_folds}"
    elif champion.model != baseline and champion.mase > max_ratio * base.mase:
        chosen, status, reason = base, "fallback_baseline", f"champion MASE {champion.mase:.3f} not within {max_ratio}x baseline {base.mase:.3f}"
    elif not calibrated(champion):
        if calibrated(base):
            chosen, status, reason = base, "fallback_baseline", "champion intervals failed calibration; baseline is calibrated"
        else:
            return ForecastOutput(
                "abstained", champion.model, baseline, "no model passed interval calibration", [_bt_dict(r) for r in results.values()], gate, _calib(champion), {}, []
            )
    else:
        chosen, status, reason = champion, "champion_selected", f"{champion.model} beat baseline (MASE {champion.mase:.3f} vs {base.mase:.3f}) and passed calibration"

    final = models[chosen.model](arr)
    point = final.forecast(h)
    drift = cusum_drift(final.in_sample_residuals)
    points = []
    for k in range(h):
        qs = conformal_quantiles(point[k], np.array(chosen.residuals_by_step[k]))
        points.append({"ts": future_timestamps[k], "mean": float(point[k]), "q025": qs[0.025], "q10": qs[0.1], "q50": qs[0.5], "q90": qs[0.9], "q975": qs[0.975]})
    return ForecastOutput(status, chosen.model, baseline, reason, [_bt_dict(r) for r in results.values()], gate, _calib(chosen), drift, points)


def _calib(r: BacktestResult) -> dict:
    return {"model": r.model, "coverage80": r.coverage80, "coverage95": r.coverage95, "folds": r.folds}


def _bt_dict(r: BacktestResult) -> dict:
    return {"model": r.model, "folds": r.folds, "mase": r.mase, "smape": r.smape, "rmse": r.rmse, "coverage80": r.coverage80, "coverage95": r.coverage95, "pinball": r.pinball, "crps": r.crps}
