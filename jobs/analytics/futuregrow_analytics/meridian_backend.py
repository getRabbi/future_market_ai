"""Optional Google Meridian backend for M09 (P3-10).

FUTUREGROW's own Bayesian MMM (mmm.py) stays the default. Meridian
(https://developers.google.com/meridian, package ``google-meridian``, Python 3.11/3.12, JAX backend,
at least one GPU recommended, tested with 16 GB RAM) runs only in a compute environment the owner
has approved. Without it the backend reports ``requires_compute`` with the exact requirements and
never pretends to have fitted anything. Data validation, alignment, result serialization and the
comparison with the native engine do not depend on Meridian being installed.
"""

from __future__ import annotations

import math
import os
import sys

REQUIREMENTS = {
    "package": "google-meridian (pip install 'google-meridian[and-cuda]' on Linux GPU hosts)",
    "python": "3.11 or 3.12",
    "backend": "JAX (default; the TensorFlow backend is deprecated upstream)",
    "compute": "at least 1 GPU recommended (tested upstream on V100/T4) and 16 GB RAM",
    "approval": "FG_MERIDIAN_COMPUTE=approved on the job's environment, set by the owner for a paid or dedicated compute environment",
    "docs": "https://developers.google.com/meridian/docs/user-guide/installing",
}

MIN_PERIODS = 52
MIN_RAM_BYTES = 16 * 1024**3


def _ram_bytes() -> int | None:
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, AttributeError):
        return None


def availability(env: dict | None = None, importer=None) -> dict:
    """Whether Meridian can run here, and every reason it cannot. Imports nothing heavy when not approved."""
    env = os.environ if env is None else env
    reasons: list[str] = []
    version = None
    if env.get("FG_MERIDIAN_COMPUTE") != "approved":
        reasons.append("no approved Meridian compute environment (FG_MERIDIAN_COMPUTE is not 'approved')")
    if sys.version_info[:2] not in ((3, 11), (3, 12)):
        reasons.append(f"Python {sys.version_info[0]}.{sys.version_info[1]} is not supported by Meridian (3.11 or 3.12)")
    if not reasons:
        try:
            mod = (importer or __import__)("meridian")
            version = getattr(mod, "__version__", "unknown")
        except ImportError:
            reasons.append("google-meridian is not installed in this job image")
    ram = _ram_bytes()
    if ram is not None and ram < MIN_RAM_BYTES and env.get("FG_MERIDIAN_ALLOW_SMALL_RAM") != "1":
        reasons.append(f"{ram / 1024**3:.1f} GB RAM is below the 16 GB Meridian was tested with")
    return {"status": "available" if not reasons else "requires_compute", "reasons": reasons, "meridianVersion": version, "requirements": REQUIREMENTS}


def validate_inputs(kpi: list[float], spend: list[list[float]], names: list[str], controls: list[list[float]] | None = None) -> list[str]:
    """Data checks before any fit: aligned, finite, non-negative spend, enough history and variation."""
    problems: list[str] = []
    n = len(kpi)
    if n < MIN_PERIODS:
        problems.append(f"{n} aligned periods; Meridian needs at least {MIN_PERIODS} (weekly data, ideally two years)")
    if not names:
        problems.append("no media channels")
    if any(len(row) != len(names) for row in spend) or len(spend) != n:
        problems.append("spend matrix is not aligned with the KPI periods and channels")
        return problems
    if any(not math.isfinite(v) for v in kpi):
        problems.append("the KPI has missing or non-finite values")
    for j, name in enumerate(names):
        col = [row[j] for row in spend]
        if any((not math.isfinite(v)) or v < 0 for v in col):
            problems.append(f"channel {name} has negative or missing spend")
        elif sum(1 for v in col if v > 0) < max(4, n // 10):
            problems.append(f"channel {name} has spend in too few periods to estimate")
    if n and max(kpi) == min(kpi):
        problems.append("the KPI does not vary")
    if names and n < 5 * len(names):
        problems.append(f"{len(names)} channels need at least {5 * len(names)} periods")
    if controls is not None and len(controls) != n:
        problems.append("controls are not aligned with the KPI periods")
    return problems


def serialize_posterior(roi_draws: dict[str, list[float]], rhat_max: float, n_draws: int) -> dict:
    """Meridian posterior summaries in the native engine's result shape (channels, diagnostics)."""
    def q(xs: list[float]) -> dict:
        s = sorted(xs)
        pick = lambda p: s[min(len(s) - 1, max(0, int(round(p * (len(s) - 1)))))]
        return {"p05": pick(0.05), "p50": pick(0.5), "p95": pick(0.95), "mean": sum(s) / len(s)}

    converged = rhat_max < 1.05
    return {
        "channels": {name: {"roi": q(draws)} for name, draws in roi_draws.items() if draws},
        "diagnostics": {"backend": "meridian", "rhatMax": rhat_max, "draws": n_draws, "converged": converged},
        "converged": converged,
    }


def compare(native: dict, meridian: dict) -> dict:
    """Side-by-side ROI medians per channel, only when both fits converged (otherwise says why)."""
    if not native.get("converged") or not meridian.get("converged"):
        return {"comparable": False, "reason": "both engines must converge before their estimates are compared"}
    rows = []
    for name, m in meridian.get("channels", {}).items():
        nat = native.get("channels", {}).get(name, {})
        n_roi = (nat.get("roi") or {}).get("p50")
        m_roi = (m.get("roi") or {}).get("p50")
        rows.append({"channel": name, "nativeRoiP50": n_roi, "meridianRoiP50": m_roi, "intervalsOverlap": _overlap(nat.get("roi"), m.get("roi"))})
    return {"comparable": True, "channels": rows, "note": "Different priors and model structure; disagreement is a reason to review assumptions, not to average the two."}


def _overlap(a: dict | None, b: dict | None) -> bool | None:
    if not a or not b:
        return None
    return not (a["p95"] < b["p05"] or b["p95"] < a["p05"])


def fit_meridian(kpi: list[float], spend: list[list[float]], names: list[str], controls=None, seed: int = 20261019, env: dict | None = None, importer=None) -> dict:
    """Validates, checks compute, and only then fits with Meridian. Never returns invented estimates."""
    problems = validate_inputs(kpi, spend, names, controls)
    avail = availability(env, importer)
    base = {"backend": "meridian", "validation": {"passed": not problems, "problems": problems}, "availability": avail, "converged": False, "causalLanguageAllowed": False}
    if problems:
        return {**base, "status": "insufficient_data", "reason": "; ".join(problems)}
    if avail["status"] != "available":
        return {**base, "status": "requires_compute", "reason": "; ".join(avail["reasons"])}
    return {**base, **_run(kpi, spend, names, controls, seed)}  # pragma: no cover - needs approved GPU compute


def _run(kpi, spend, names, controls, seed):  # pragma: no cover - executed only with google-meridian installed
    import numpy as np
    import pandas as pd
    from meridian.data import data_frame_input_data_builder as dfb
    from meridian.model import model as mmodel
    from meridian.model import spec as mspec

    n = len(kpi)
    times = pd.date_range("2020-01-06", periods=n, freq="W-MON").strftime("%Y-%m-%d")
    df = pd.DataFrame({"time": times, "kpi": kpi, **{f"{c}_spend": [row[j] for row in spend] for j, c in enumerate(names)}})
    builder = dfb.DataFrameInputDataBuilder(kpi_type="non_revenue")
    builder = builder.with_kpi(df, kpi_col="kpi", time_col="time").with_media(df, media_cols=[f"{c}_spend" for c in names], media_spend_cols=[f"{c}_spend" for c in names], media_channels=names, time_col="time")
    data = builder.build()
    m = mmodel.Meridian(input_data=data, model_spec=mspec.ModelSpec())
    m.sample_prior(500, seed=seed)
    m.sample_posterior(n_chains=4, n_adapt=500, n_burnin=500, n_keep=1000, seed=seed)
    post = m.inference_data.posterior
    roi = post["roi_m"].values.reshape(-1, len(names))
    rhat = float(np.nanmax([float(v) for v in np.asarray(__import__("arviz").rhat(m.inference_data)["roi_m"])]))
    out = serialize_posterior({c: roi[:, j].tolist() for j, c in enumerate(names)}, rhat, roi.shape[0])
    return {**out, "status": "ok" if out["converged"] else "not_converged"}
