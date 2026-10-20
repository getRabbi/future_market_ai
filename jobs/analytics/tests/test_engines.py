import math

import numpy as np
import pytest

from futuregrow_analytics import experiments, forecasting, mmm, propensity, topics, trends


def seasonal_series(n=160, m=7, seed=1, noise=2.0, trend=0.05):
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    return 100 + trend * t + 10 * np.sin(2 * np.pi * t / m) + rng.normal(0, noise, n)


# ----------------------------------------------------------------------------- forecasting


def test_holt_winters_beats_naive_on_seasonal_data():
    y = seasonal_series()
    models = forecasting.candidate_models(7)
    hw = forecasting.rolling_origin(y, 7, 7, 15, models["holt_winters_damped"])
    naive = forecasting.rolling_origin(y, 7, 7, 15, models["naive"])
    assert hw is not None and naive is not None
    assert hw.mase < naive.mase


def test_backtest_has_no_leakage():
    y = seasonal_series()
    seen = []

    def spy(train):
        seen.append(len(train))
        return forecasting.candidate_models(7)["naive"](train)

    forecasting.rolling_origin(y, 7, 7, 10, spy)
    # every fold trains only on data strictly before its forecast origin
    assert max(seen) <= len(y) - 7
    assert seen == sorted(seen)


def test_conformal_intervals_reach_nominal_coverage_on_iid_noise():
    rng = np.random.default_rng(3)
    covered = []
    for _ in range(400):
        res = rng.normal(0, 1, 39)
        qs = forecasting.conformal_quantiles(0.0, res)
        covered.append(qs[0.1] <= rng.normal(0, 1) <= qs[0.9])
    # finite-sample conformal guarantee: coverage >= 0.8 (allow Monte Carlo error)
    assert np.mean(covered) >= 0.76


def test_unconfigured_gates_fall_back_to_baseline():
    y = seasonal_series()
    ts = [f"2026-01-{(i % 28) + 1:02d}" for i in range(len(y))]
    out = forecasting.run_forecast(y.tolist(), ts, [f"f{i}" for i in range(7)], 7, None)
    assert out.status == "fallback_baseline"
    assert out.champion == "seasonal_naive"
    assert "gate_unconfigured" in out.selection_reason
    assert len(out.points) == 7
    p = out.points[0]
    assert p["q025"] <= p["q10"] <= p["q50"] <= p["q90"] <= p["q975"]


def test_configured_gates_select_calibrated_champion():
    y = seasonal_series(n=200)
    ts = [str(i) for i in range(len(y))]
    out = forecasting.run_forecast(y.tolist(), ts, [f"f{i}" for i in range(7)], 7, {"maxMaseRatioToBaseline": 1.0, "intervalCoverageTolerance": 0.15, "minBacktestFolds": 10})
    assert out.status in ("champion_selected", "fallback_baseline")
    if out.status == "champion_selected":
        assert out.calibration["coverage80"] == pytest.approx(0.8, abs=0.15)
    cands = {c["model"] for c in out.candidates}
    assert {"naive", "seasonal_naive", "holt_winters_damped"} <= cands


def test_abstains_on_short_history():
    out = forecasting.run_forecast([1.0] * 10, [str(i) for i in range(10)], ["a", "b"], 7, None)
    assert out.status == "abstained"


def test_cusum_detects_level_shift():
    r = np.concatenate([np.random.default_rng(0).normal(0, 1, 60), np.random.default_rng(1).normal(4, 1, 30)])
    assert forecasting.cusum_drift(r)["detected"] is True
    assert forecasting.cusum_drift(np.random.default_rng(2).normal(0, 1, 90))["detected"] is False


# ----------------------------------------------------------------------------- MMM


def simulate_mmm(T=104, seed=0):
    rng = np.random.default_rng(seed)
    spend = np.column_stack([rng.gamma(4, 250, T), rng.gamma(3, 150, T)])
    true = {"alpha": [0.5, 0.2], "K": [0.4, 0.6], "S": [1.2, 1.0], "beta": [300.0, 120.0]}
    y = np.full(T, 1000.0)
    for c in range(2):
        a = mmm.adstock(spend[:, c] / spend[:, c].max(), true["alpha"][c])
        y += true["beta"][c] * mmm.hill(a, true["K"][c], true["S"][c])
    y += rng.normal(0, 15, T)
    return y, spend, true


def test_adstock_is_normalised_geometric_carryover():
    x = np.zeros(20)
    x[0] = 1.0
    a = mmm.adstock(x, 0.5)
    assert a[0] == pytest.approx(0.5)
    assert a[3] == pytest.approx(0.5 * 0.5**3)
    assert mmm.adstock(np.ones(500), 0.7)[-1] == pytest.approx(1.0, abs=1e-6)  # steady state == spend


@pytest.mark.slow
def test_mmm_recovers_contributions_and_reports_diagnostics():
    y, spend, true = simulate_mmm()
    out = mmm.fit_mmm(y.tolist(), spend.tolist(), ["search", "social"], seed=42)
    assert out["status"] == "ok"
    d = out["diagnostics"]
    assert d["chains"] == 4 and d["maxRhat"] > 0 and d["minEss"] > 0
    # true contribution of channel 0
    a = mmm.adstock(spend[:, 0] / spend[:, 0].max(), true["alpha"][0])
    true_c0 = float((true["beta"][0] * mmm.hill(a, true["K"][0], true["S"][0])).sum())
    c0 = out["channels"]["search"]["contribution"]
    assert c0["q05"] * 0.7 <= true_c0 <= c0["q95"] * 1.3
    assert out["causalLanguageAllowed"] == out["converged"]
    assert out["inferenceKind"] == "mmm_estimate"
    assert out["budgetScenarios"]["optimized"] is not None
    assert out["channels"]["search"]["prior"]["source"] == "default_weakly_informative"


def test_mmm_experiment_prior_is_recorded_with_provenance():
    y, spend, _ = simulate_mmm(seed=3)
    out = mmm.fit_mmm(y.tolist(), spend.tolist(), ["search", "social"], experiment_priors=[{"channel": "social", "liftPerPeriod": 60.0, "se": 10.0, "experimentId": "exp-1"}], n_warm=300, n_draws=300, n_chains=2, seed=1)
    assert out["priors"]["social"]["kind"] == "experiment"
    assert out["priors"]["social"]["source"] == "experiment:exp-1"


def test_mmm_abstains_on_too_little_data():
    out = mmm.fit_mmm([1.0] * 10, [[1.0, 2.0]] * 10, ["a", "b"])
    assert out["status"] == "abstained" and out["causalLanguageAllowed"] is False


def test_rhat_and_ess_detect_non_mixing_chains():
    rng = np.random.default_rng(0)
    good = rng.normal(0, 1, (4, 1000))
    bad = good + np.arange(4)[:, None] * 3
    assert mmm.split_rhat(good) < 1.01
    assert mmm.split_rhat(bad) > 1.5
    assert mmm.bulk_ess(good) > 2000
    ar = np.zeros((4, 1000))
    for c in range(4):
        for t in range(1, 1000):
            ar[c, t] = 0.95 * ar[c, t - 1] + rng.normal()
    assert mmm.bulk_ess(ar) < 400


# ----------------------------------------------------------------------------- experiments


def test_binary_experiment_identifies_winner_only_with_configured_thresholds():
    exp = {"metricType": "binary", "guardrails": [], "decision": None, "plannedSamplePerVariant": None}
    vs = [
        {"key": "control", "isControl": True, "weight": 1, "assigned": 5000, "exposed": 5000, "successes": 500},
        {"key": "b", "isControl": False, "weight": 1, "assigned": 5000, "exposed": 5000, "successes": 600},
    ]
    r = experiments.analyze(exp, vs)
    assert r["probBest"]["b"] > 0.99
    assert r["recommendation"] == "inconclusive"  # thresholds [U]
    exp["decision"] = {"probBestThreshold": 0.95, "maxExpectedLoss": 0.001}
    r2 = experiments.analyze(exp, vs)
    assert r2["recommendation"] == "ship_candidate"
    assert r2["frequentist"]["b"]["pValue"] < 0.01
    assert r2["perVariant"][1]["relativeLift"]["ci95"][0] > 0


def test_srm_invalidates_results():
    exp = {"metricType": "binary", "guardrails": [], "decision": {"probBestThreshold": 0.9, "maxExpectedLoss": 0.01}}
    vs = [
        {"key": "control", "isControl": True, "weight": 1, "assigned": 5000, "exposed": 5000, "successes": 500},
        {"key": "b", "isControl": False, "weight": 1, "assigned": 4200, "exposed": 4200, "successes": 600},
    ]
    r = experiments.analyze(exp, vs)
    assert r["srm"]["mismatch"] is True
    assert r["recommendation"] == "invalid_srm"


def test_guardrail_breach_stops_rollout():
    exp = {
        "metricType": "binary",
        "decision": {"probBestThreshold": 0.9, "maxExpectedLoss": 0.01},
        "guardrails": [{"metric": "unsubscribe", "type": "binary", "direction": "increase_is_bad", "maxRelativeChange": 0.1, "maxBreachProbability": 0.8}],
    }
    vs = [
        {"key": "control", "isControl": True, "weight": 1, "assigned": 4000, "exposed": 4000, "successes": 400, "guardrails": {"unsubscribe": {"successes": 40, "n": 4000}}},
        {"key": "b", "isControl": False, "weight": 1, "assigned": 4000, "exposed": 4000, "successes": 480, "guardrails": {"unsubscribe": {"successes": 90, "n": 4000}}},
    ]
    r = experiments.analyze(exp, vs)
    assert r["recommendation"] == "guardrail_breach"


def test_continuous_metric_and_thompson_allocation():
    exp = {"metricType": "continuous", "guardrails": [], "decision": None}
    vs = [{"key": "a", "isControl": True, "weight": 1, "assigned": 300, "n": 300, "mean": 10.0, "var": 4.0}, {"key": "b", "weight": 1, "assigned": 300, "n": 300, "mean": 10.8, "var": 4.0}]
    r = experiments.analyze(exp, vs)
    assert r["probBest"]["b"] > 0.99
    alloc = experiments.thompson_allocation([{"key": "a", "successes": 50, "exposed": 1000}, {"key": "b", "successes": 80, "exposed": 1000}], "binary", min_share=0.1)
    assert sum(alloc.values()) == pytest.approx(1.0)
    assert alloc["a"] >= 0.1 and alloc["b"] > alloc["a"]


# ----------------------------------------------------------------------------- trends


def test_mann_kendall_and_sen_slope():
    rng = np.random.default_rng(0)
    up = np.arange(60) * 0.5 + rng.normal(0, 1, 60)
    r = trends.detect_trend(up.tolist(), [str(i) for i in range(60)])
    assert r["direction"] == "rising" and r["senSlope"] == pytest.approx(0.5, abs=0.1)
    flat = rng.normal(0, 1, 60)
    assert trends.detect_trend(flat.tolist(), [str(i) for i in range(60)])["direction"] == "flat"
    assert r["inferenceKind"] == "correlation"


def test_change_point_detection():
    rng = np.random.default_rng(4)
    y = np.concatenate([rng.normal(10, 1, 40), rng.normal(15, 1, 40)])
    cps = trends.change_points(y)
    assert any(abs(c - 40) <= 3 for c in cps)


def test_robust_anomalies():
    y = seasonal_series(n=100, noise=0.5)
    y[60] += 40
    an = trends.robust_anomalies(y.tolist(), 7)
    assert any(a["index"] == 60 for a in an)


# ----------------------------------------------------------------------------- propensity


def test_propensity_recovers_signal_and_is_calibrated():
    rng = np.random.default_rng(9)
    n = 3000
    x1, x2 = rng.normal(size=n), rng.normal(size=n)
    p = 1 / (1 + np.exp(-(-1 + 1.5 * x1 - 0.8 * x2)))
    y = rng.random(n) < p
    rows = [{"profile_id": f"p{i}", "events_30d": float(x1[i]), "days_since_last": float(x2[i]), "converted": bool(y[i])} for i in range(n)]
    m = propensity.train(rows, ["events_30d", "days_since_last"], "converted", gates={"minAuc": 0.7, "maxEce": 0.05})
    assert m["status"] == "champion"
    assert m["metrics"]["auc"] > 0.75
    assert m["metrics"]["calibration"]["ece"] < 0.05
    s = propensity.score(m, rows[:5], ["events_30d", "days_since_last"])
    assert all(r["interval_low"] <= r["score"] <= r["interval_high"] for r in s)
    assert len(s[0]["reason_codes"]) == 2


def test_propensity_rejects_sensitive_features():
    rows = [{"profile_id": str(i), "age": i, "converted": i % 2 == 0} for i in range(100)]
    assert propensity.train(rows, ["age"], "converted")["status"] == "rejected"
    assert propensity.feature_policy(["postal_code"])["allowed"] is False


# ----------------------------------------------------------------------------- topics


def test_topic_clustering_separates_themes():
    a = [{"id": f"a{i}", "text": f"refund request order {i} refund money back payment"} for i in range(20)]
    b = [{"id": f"b{i}", "text": f"login password reset account locked sign in {i}"} for i in range(20)]
    out = topics.cluster_texts(a + b)
    assert out["status"] == "ok" and out["k"] >= 2
    labels = [c["label"] for c in out["clusters"]]
    assert any("refund" in l for l in labels) and any(("password" in l) or ("login" in l) or ("account" in l) for l in labels)


def test_mmm_analytic_gradient_matches_finite_differences():
    y, spend, _ = simulate_mmm(seed=5)
    controls = np.random.default_rng(2).normal(size=(len(y), 2))
    m = mmm.MMM(y, spend, controls, ["a", "b"], [mmm.ChannelPrior("half_normal", 0, 0.5, "d"), mmm.ChannelPrior("experiment", 0.1, 0.03, "e")])
    for seed in range(3):
        th = m.initial() + np.random.default_rng(seed).normal(0, 0.3, m.D)
        _, g = m.log_post_grad(th)
        fd = np.array([(m.log_post(th + e) - m.log_post(th - e)) / 2e-6 for e in np.eye(m.D) * 1e-6])
        assert np.max(np.abs(g - fd) / (np.abs(fd) + 1e-3)) < 1e-4


@pytest.mark.slow
def test_mmm_converges_on_simulated_data():
    y, spend, _ = simulate_mmm()
    out = mmm.fit_mmm(y.tolist(), spend.tolist(), ["search", "social"], seed=42)
    d = out["diagnostics"]
    assert d["sampler"] == "nuts"
    assert d["maxRhat"] < 1.02
    assert d["minEss"] > 300


def test_psi_flags_shifted_features_and_accepts_stable_ones():
    from futuregrow_analytics.propensity import feature_drift, psi

    rng = np.random.default_rng(7)
    ref = rng.normal(0, 1, 5000)
    assert psi(ref, rng.normal(0, 1, 5000)) < 0.05
    assert psi(ref, rng.normal(1.5, 1, 5000)) > 0.25
    assert psi(np.zeros(100), np.zeros(80)) == 0.0
    assert psi(np.zeros(100), np.ones(80)) > 0.25
    train = [{"a": float(x), "b": float(x)} for x in rng.normal(0, 1, 2000)]
    serve = [{"a": float(x), "b": float(x) + 2} for x in rng.normal(0, 1, 2000)]
    d = feature_drift(train, serve, ["a", "b"])
    assert d["drifted"] == ["b"] and not d["ok"]
