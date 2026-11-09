"""P3-10: the optional Meridian backend validates, reports requires_compute honestly and never invents estimates."""

import math

from futuregrow_analytics import meridian_backend as mb


def _data(n=60, channels=2):
    kpi = [100 + 10 * math.sin(i / 3) + i for i in range(n)]
    spend = [[50 + (i % 7) * 5 + j * 3 for j in range(channels)] for i in range(n)]
    return kpi, spend, [f"ch{j}" for j in range(channels)]


def _no_meridian(name, *a, **k):
    raise ImportError(name)


def test_requires_an_approved_compute_environment():
    a = mb.availability(env={})
    assert a["status"] == "requires_compute"
    assert any("FG_MERIDIAN_COMPUTE" in r for r in a["reasons"])
    assert a["requirements"]["package"].startswith("google-meridian")


def test_approved_environment_without_the_package_still_requires_compute():
    a = mb.availability(env={"FG_MERIDIAN_COMPUTE": "approved", "FG_MERIDIAN_ALLOW_SMALL_RAM": "1"}, importer=_no_meridian)
    assert a["status"] == "requires_compute"
    assert any("not installed" in r or "Python" in r for r in a["reasons"])


def test_validation_catches_short_misaligned_and_flat_inputs():
    kpi, spend, names = _data(n=20)
    problems = mb.validate_inputs(kpi, spend, names)
    assert any("at least 52" in p for p in problems)
    assert mb.validate_inputs(kpi, spend[:-1], names) == ["20 aligned periods; Meridian needs at least 52 (weekly data, ideally two years)", "spend matrix is not aligned with the KPI periods and channels"]
    kpi, spend, names = _data()
    flat = mb.validate_inputs([5.0] * len(kpi), spend, names)
    assert "the KPI does not vary" in flat
    neg = [row[:] for row in spend]
    neg[3][1] = -1
    assert any("negative or missing spend" in p for p in mb.validate_inputs(kpi, neg, names))
    assert mb.validate_inputs(kpi, spend, names) == []


def test_fit_returns_requires_compute_with_validation_and_no_estimates():
    kpi, spend, names = _data()
    out = mb.fit_meridian(kpi, spend, names, env={}, importer=_no_meridian)
    assert out["status"] == "requires_compute"
    assert out["validation"] == {"passed": True, "problems": []}
    assert out["converged"] is False and out["causalLanguageAllowed"] is False
    assert "channels" not in out
    short = mb.fit_meridian(kpi[:10], spend[:10], names, env={})
    assert short["status"] == "insufficient_data"


def test_serialization_and_comparison_only_between_converged_fits():
    m = mb.serialize_posterior({"ch0": [1.0, 1.2, 1.4, 1.1, 1.3], "ch1": [0.4, 0.5, 0.6, 0.45, 0.55]}, rhat_max=1.01, n_draws=5)
    assert m["converged"] is True and m["channels"]["ch0"]["roi"]["p50"] == 1.2
    native = {"converged": True, "channels": {"ch0": {"roi": {"p05": 1.0, "p50": 1.15, "p95": 1.3}}, "ch1": {"roi": {"p05": 2.0, "p50": 2.5, "p95": 3.0}}}}
    c = mb.compare(native, m)
    assert c["comparable"] is True
    by = {r["channel"]: r for r in c["channels"]}
    assert by["ch0"]["intervalsOverlap"] is True and by["ch1"]["intervalsOverlap"] is False
    assert mb.compare({"converged": False}, m)["comparable"] is False
    bad = mb.serialize_posterior({"ch0": [1.0, 2.0]}, rhat_max=1.3, n_draws=2)
    assert bad["converged"] is False
