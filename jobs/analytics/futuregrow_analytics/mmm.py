"""M09 Causal Measurement & MMM: Bayesian media-mix model.

    y_t = intercept + trend * t' + sum_c beta_c * Hill(adstock_c(t); K_c, S_c) + sum_j gamma_j z_j(t) + eps_t

* geometric adstock (normalised, steady state == spend) with decay alpha_c ~ Beta(2, 2);
* Hill saturation on max-normalised adstock with K_c ~ LogNormal(log 0.5, 0.6), S_c ~ LogNormal(log 1.5, 0.4);
* the effect size is parametrised as rho_c, the incremental mean-scaled KPI per period at average
  spend, with rho_c ~ HalfNormal(0.5) or an experiment-calibrated truncated Normal prior (lift
  measured in a randomized holdout) - Meridian-style ROI calibration;
* posterior sampled with the No-U-Turn Sampler (Hoffman & Gelman 2014) using an analytic gradient,
  dual-averaging step size and a dense mass matrix adapted over two warm-up windows (the adstock/
  saturation/coefficient parameters are strongly correlated, which a diagonal metric cannot absorb); 4 chains start near
  the MAP. Split-R-hat and bulk ESS (Vehtari et al. 2021) gate whether results may be described
  causally.

Outputs are labelled `mmm_estimate`; they are model-based estimates under stated assumptions, not
measured truth (product plan causality boundary).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.linalg import cholesky, solve_triangular
from scipy.optimize import minimize
from scipy.signal import lfilter
from scipy.special import expit, logit

DEFAULT_GATES = {"maxRhat": 1.01, "minEss": 400.0}  # methodological convention (Vehtari et al. 2021)


@dataclass
class ChannelPrior:
    kind: str  # half_normal | experiment
    mean: float
    sd: float
    source: str


def adstock(x: np.ndarray, alpha: float) -> np.ndarray:
    """Normalised geometric adstock a_t = (1-alpha) x_t + alpha a_{t-1}, computed as an IIR filter."""
    return lfilter([1.0 - alpha], [1.0, -alpha], x)


def hill(a: np.ndarray, k: float, s: float) -> np.ndarray:
    a = np.maximum(a, 0.0)
    return a**s / (a**s + k**s)


class MMM:
    """Unconstrained parameter layout:
    intercept, trend, gamma[J], log rho[C], logit alpha[C], log K[C], log S[C], log sigma

    rho_c is the channel's incremental (mean-scaled) KPI per period at its average spend, so the
    effect size is sampled separately from the saturation shape: beta_c = rho_c / Hill(xbar_c; K_c, S_c).
    This removes most of the beta/K/S correlation that makes the naive parametrisation hard to sample.
    """

    def __init__(self, y: np.ndarray, spend: np.ndarray, controls: np.ndarray | None, channel_names: list[str], priors: list[ChannelPrior]):
        self.T, self.C = spend.shape
        self.y_scale = float(np.mean(y)) or 1.0
        self.y = y / self.y_scale
        self.spend = spend
        self.spend_scale = np.maximum(spend.max(axis=0), 1e-9)  # per-channel normaliser
        self.x = spend / self.spend_scale
        self.x_ref = np.maximum(self.x.mean(axis=0), 1e-6)  # steady-state adstock at average spend
        self.Z = (controls - controls.mean(axis=0)) / np.maximum(controls.std(axis=0), 1e-9) if controls is not None and controls.size else np.zeros((self.T, 0))
        self.J = self.Z.shape[1]
        self.t = np.linspace(-0.5, 0.5, self.T)
        self.names = channel_names
        self.priors = priors
        self.D = 2 + self.J + 4 * self.C + 1

    def unpack(self, th: np.ndarray):
        C, J = self.C, self.J
        o = 2 + J
        intercept, trend = th[0], th[1]
        gamma = th[2:o]
        rho = np.exp(th[o : o + C])
        alpha = expit(th[o + C : o + 2 * C])
        k = np.exp(th[o + 2 * C : o + 3 * C])
        s = np.exp(th[o + 3 * C : o + 4 * C])
        sigma = math.exp(th[-1])
        href = hill(self.x_ref, k, s)
        beta = rho / np.maximum(href, 1e-12)
        return intercept, trend, gamma, beta, alpha, k, s, sigma

    def rho(self, th: np.ndarray) -> np.ndarray:
        o = 2 + self.J
        return np.exp(th[o : o + self.C])

    def media_terms(self, alpha: np.ndarray, k: np.ndarray, s: np.ndarray) -> np.ndarray:
        out = np.empty((self.T, self.C))
        for c in range(self.C):
            out[:, c] = hill(adstock(self.x[:, c], alpha[c]), k[c], s[c])
        return out

    def log_post(self, th: np.ndarray) -> float:
        return self.log_post_grad(th)[0]

    def log_post_grad(self, th: np.ndarray) -> tuple[float, np.ndarray]:
        """Log posterior and its analytic gradient in the unconstrained space."""
        C, J, T = self.C, self.J, self.T
        o = 2 + J
        intercept, trend, gamma, beta, alpha, k, s, sigma = self.unpack(th)
        rho = self.rho(th)
        if not (np.all(np.isfinite(beta)) and np.all(np.isfinite(rho)) and np.isfinite(sigma)) or sigma <= 1e-6:
            return -np.inf, np.zeros(self.D)
        H = np.empty((T, C))
        dH_dalpha = np.empty((T, C))
        dH_dk = np.empty((T, C))
        dH_ds = np.empty((T, C))
        for c in range(C):
            x = self.x[:, c]
            a = adstock(x, alpha[c])
            a_prev = np.concatenate([[0.0], a[:-1]])
            # d a_t / d alpha = (a_{t-1} - x_t) + alpha * d a_{t-1} / d alpha
            da = lfilter([1.0], [1.0, -alpha[c]], a_prev - x)
            a = np.maximum(a, 1e-12)
            aS, kS = a ** s[c], k[c] ** s[c]
            den = aS + kS
            h = aS / den
            H[:, c] = h
            dH_dalpha[:, c] = s[c] * a ** (s[c] - 1) * kS / den**2 * da
            dH_dk[:, c] = -s[c] * k[c] ** (s[c] - 1) * aS / den**2
            dH_ds[:, c] = h * (1 - h) * (np.log(a) - math.log(k[c]))
        mu = intercept + trend * self.t + H @ beta + (self.Z @ gamma if J else 0.0)
        r = self.y - mu
        rss = float(r @ r)
        g = np.zeros(self.D)
        w = r / sigma**2  # d loglik / d mu
        ll = -T * math.log(sigma) - 0.5 * rss / sigma**2
        g[0] = w.sum() - (intercept - 1.0)
        g[1] = float(w @ self.t) - trend / 0.25
        lp = -0.5 * (intercept - 1.0) ** 2 - 0.5 * (trend / 0.5) ** 2
        if J:
            g[2:o] = self.Z.T @ w - gamma
            lp += -0.5 * float(gamma @ gamma)
        for c, pr in enumerate(self.priors):
            b, rh, al, kc, sc = beta[c], rho[c], alpha[c], k[c], s[c]
            xr = self.x_ref[c]
            xS, kS = xr**sc, kc**sc
            href = xS / (xS + kS)
            dhref_dk = -sc * kc ** (sc - 1) * xS / (xS + kS) ** 2
            dhref_ds = href * (1 - href) * (math.log(xr) - math.log(kc))
            wH = float(w @ H[:, c])
            # log rho
            g[o + c] = wH * b
            if pr.kind == "experiment":
                lp += -0.5 * ((rh - pr.mean) / pr.sd) ** 2
                g[o + c] += -((rh - pr.mean) / pr.sd**2) * rh
            else:
                lp += -0.5 * (rh / pr.sd) ** 2
                g[o + c] += -(rh / pr.sd**2) * rh
            lp += math.log(rh)
            g[o + c] += 1.0
            # logit alpha (Beta(2,2) prior + logit Jacobian)
            g[o + C + c] = float(w @ dH_dalpha[:, c]) * b * al * (1 - al) + 2 * (1 - 2 * al)
            lp += 2 * (math.log(al) + math.log1p(-al))
            # log K and log S: beta also depends on them through href
            lk, ls = th[o + 2 * C + c], th[o + 3 * C + c]
            g[o + 2 * C + c] = b * kc * (float(w @ dH_dk[:, c]) - wH * dhref_dk / href) - (lk - math.log(0.5)) / 0.36
            g[o + 3 * C + c] = b * sc * (float(w @ dH_ds[:, c]) - wH * dhref_ds / href) - (ls - math.log(1.5)) / 0.16
            lp += -0.5 * ((lk - math.log(0.5)) / 0.6) ** 2 - 0.5 * ((ls - math.log(1.5)) / 0.4) ** 2
        g[-1] = -T + rss / sigma**2 - sigma**2 / 0.25 + 1.0
        lp += -0.5 * (sigma / 0.5) ** 2 + math.log(sigma)
        v = ll + lp
        if not math.isfinite(v) or not np.all(np.isfinite(g)):
            return -np.inf, np.zeros(self.D)
        return v, g

    def initial(self) -> np.ndarray:
        th = np.zeros(self.D)
        th[0] = 1.0
        C, J = self.C, self.J
        o = 2 + J
        th[o : o + C] = math.log(0.05)
        th[o + C : o + 2 * C] = 0.0
        th[o + 2 * C : o + 3 * C] = math.log(0.5)
        th[o + 3 * C : o + 4 * C] = math.log(1.5)
        th[-1] = math.log(max(float(np.std(self.y)), 0.05))
        return th


def _map(model: MMM, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    best = None
    for attempt in range(4):
        x0 = model.initial() + (rng.normal(0, 0.3, model.D) if attempt else 0)
        def f(th):
            v, g = model.log_post_grad(th)
            return (1e12, np.zeros_like(th)) if not math.isfinite(v) else (-v, -g)

        res = minimize(f, x0, jac=True, method="L-BFGS-B", options={"maxiter": 3000})
        if best is None or res.fun < best.fun:
            best = res
    hess_inv = best.hess_inv.todense() if hasattr(best.hess_inv, "todense") else np.eye(model.D) * 0.01
    cov = np.asarray(hess_inv, dtype=float)
    cov = 0.5 * (cov + cov.T)
    w, v = np.linalg.eigh(cov)
    cov = (v * np.clip(w, 1e-6, 1.0)) @ v.T
    return best.x, cov


class _NUTS:
    """No-U-Turn Sampler with dual averaging (Hoffman & Gelman 2014, Algorithms 3 and 5)."""

    def __init__(self, model: MMM, rng: np.random.Generator, max_depth: int = 8):
        self.m = model
        self.rng = rng
        self.max_depth = max_depth
        self.set_metric(np.eye(model.D))  # dense inverse mass matrix
        self.n_grad = 0
        self.divergences = 0

    def set_metric(self, minv: np.ndarray) -> None:
        self.minv = minv
        self.chol = cholesky(minv, lower=True)

    def momentum(self, d: int) -> np.ndarray:
        # r ~ N(0, M) with M = Minv^-1 = L^-T L^-1
        return solve_triangular(self.chol.T, self.rng.standard_normal(d), lower=False)

    def lpg(self, th):
        self.n_grad += 1
        return self.m.log_post_grad(th)

    def leapfrog(self, th, r, g, eps):
        r = r + 0.5 * eps * g
        th = th + eps * (self.minv @ r)
        lp, g = self.lpg(th)
        r = r + 0.5 * eps * g
        return th, r, g, lp

    def joint(self, lp, r):
        return lp - 0.5 * float(r @ self.minv @ r)

    def find_eps(self, th, lp, g):
        eps = 0.1
        r = self.momentum(len(th))
        _, r1, _, lp1 = self.leapfrog(th, r, g, eps)
        ratio = self.joint(lp1, r1) - self.joint(lp, r)
        a = 1.0 if (math.isfinite(ratio) and ratio > math.log(0.5)) else -1.0
        for _ in range(60):
            if math.isfinite(ratio) and a * ratio <= -a * math.log(2):
                break
            if not math.isfinite(ratio) and a > 0:
                break
            eps *= 2.0**a
            _, r1, _, lp1 = self.leapfrog(th, r, g, eps)
            ratio = self.joint(lp1, r1) - self.joint(lp, r)
        return float(np.clip(eps, 1e-6, 2.0))

    def build(self, th, r, g, log_u, v, j, eps, h0):
        if j == 0:
            th1, r1, g1, lp1 = self.leapfrog(th, r, g, v * eps)
            h1 = self.joint(lp1, r1)
            n1 = 1 if log_u <= h1 else 0
            s1 = 1 if log_u < h1 + 1000 else 0
            if not s1:
                self.divergences += 1
            acc = min(1.0, math.exp(min(0.0, h1 - h0))) if math.isfinite(h1) else 0.0
            return th1, r1, g1, th1, r1, g1, th1, lp1, g1, n1, s1, acc, 1
        tm, rm, gm, tp, rp, gp, t1, lp1, g1, n1, s1, a1, na1 = self.build(th, r, g, log_u, v, j - 1, eps, h0)
        if s1:
            if v == -1:
                tm, rm, gm, _, _, _, t2, lp2, g2, n2, s2, a2, na2 = self.build(tm, rm, gm, log_u, v, j - 1, eps, h0)
            else:
                _, _, _, tp, rp, gp, t2, lp2, g2, n2, s2, a2, na2 = self.build(tp, rp, gp, log_u, v, j - 1, eps, h0)
            if n1 + n2 > 0 and self.rng.random() < n2 / (n1 + n2):
                t1, lp1, g1 = t2, lp2, g2
            a1 += a2
            na1 += na2
            dth = tp - tm
            s1 = s2 if (float(dth @ (self.minv @ rm)) >= 0 and float(dth @ (self.minv @ rp)) >= 0) else 0
            n1 += n2
        return tm, rm, gm, tp, rp, gp, t1, lp1, g1, n1, s1, a1, na1

    def step(self, th, lp, g, eps):
        r0 = self.momentum(len(th))
        h0 = self.joint(lp, r0)
        log_u = h0 + math.log(self.rng.random())
        tm = tp = th
        rm = rp = r0
        gm = gp = g
        cur, cur_lp, cur_g = th, lp, g
        n, s, j = 1, 1, 0
        acc, nacc = 0.0, 1
        while s and j < self.max_depth:
            v = 1 if self.rng.random() < 0.5 else -1
            if v == -1:
                tm, rm, gm, _, _, _, t1, lp1, g1, n1, s1, acc, nacc = self.build(tm, rm, gm, log_u, v, j, eps, h0)
            else:
                _, _, _, tp, rp, gp, t1, lp1, g1, n1, s1, acc, nacc = self.build(tp, rp, gp, log_u, v, j, eps, h0)
            if s1 and self.rng.random() < min(1.0, n1 / n):
                cur, cur_lp, cur_g = t1, lp1, g1
            n += n1
            dth = tp - tm
            s = s1 if (float(dth @ (self.minv @ rm)) >= 0 and float(dth @ (self.minv @ rp)) >= 0) else 0
            j += 1
        return cur, cur_lp, cur_g, acc / max(nacc, 1), j


def _chain(model: MMM, start: np.ndarray, n_warm: int, n_draws: int, rng: np.random.Generator, target_accept: float = 0.9):
    """One NUTS chain. Warm-up: step-size adaptation, one diagonal mass-matrix window, then
    step-size re-adaptation (a reduced version of Stan's schedule)."""
    sampler = _NUTS(model, rng)
    th = start.copy()
    lp, g = sampler.lpg(th)
    if not math.isfinite(lp):
        raise ValueError("invalid starting point")

    def dual_avg_init(eps):
        return {"mu": math.log(10 * eps), "hbar": 0.0, "logeps_bar": 0.0, "t": 0}

    eps = sampler.find_eps(th, lp, g)
    da = dual_avg_init(eps)
    # Two metric windows: [15%, 40%) gives a first estimate, [40%, 85%) refines it.
    windows = [(int(0.15 * n_warm), int(0.40 * n_warm)), (int(0.40 * n_warm), int(0.85 * n_warm))]
    window: list[np.ndarray] = []
    samples = np.empty((n_draws, model.D))
    accs, depths = [], []
    for it in range(n_warm + n_draws):
        th, lp, g, acc, depth = sampler.step(th, lp, g, eps)
        if it < n_warm:
            da["t"] += 1
            t = da["t"]
            da["hbar"] = (1 - 1 / (t + 10)) * da["hbar"] + (target_accept - acc) / (t + 10)
            logeps = da["mu"] - math.sqrt(t) / 0.05 * da["hbar"]
            eta = t**-0.75
            da["logeps_bar"] = eta * logeps + (1 - eta) * da["logeps_bar"]
            eps = float(np.clip(math.exp(logeps), 1e-6, 2.0))
            if any(a <= it < b for a, b in windows):
                window.append(th.copy())
            if any(it == b - 1 for _, b in windows) and len(window) > model.D + 2:
                W = np.asarray(window)
                n = len(W)
                cov = np.cov(W.T)
                # Stan-style regularisation toward a small multiple of the identity.
                minv = (n / (n + 5.0)) * cov + 1e-3 * (5.0 / (n + 5.0)) * np.eye(model.D)
                sampler.set_metric(0.5 * (minv + minv.T))
                window = []
                eps = sampler.find_eps(th, lp, g)
                da = dual_avg_init(eps)
            if it == n_warm - 1:
                eps = float(np.clip(math.exp(da["logeps_bar"]), 1e-6, 2.0))
                sampler.divergences = 0
        else:
            samples[it - n_warm] = th
            accs.append(acc)
            depths.append(depth)
    info = {
        "stepSize": eps,
        "meanTreeDepth": float(np.mean(depths)) if depths else 0.0,
        "gradientEvaluations": sampler.n_grad,
        "divergences": sampler.divergences,
    }
    return samples, float(np.mean(accs)) if accs else 0.0, info


def split_rhat(chains: np.ndarray) -> float:
    """chains: (M, N). Split-R-hat (Gelman et al. BDA3)."""
    M, N = chains.shape
    half = N // 2
    sp = np.concatenate([chains[:, :half], chains[:, half : 2 * half]], axis=0)
    m, n = sp.shape
    means = sp.mean(axis=1)
    W = float(np.mean(sp.var(axis=1, ddof=1)))
    B = float(n * np.var(means, ddof=1))
    var_plus = (n - 1) / n * W + B / n
    return math.sqrt(var_plus / W) if W > 0 else float("inf")


def bulk_ess(chains: np.ndarray) -> float:
    """Multi-chain ESS with Geyer's initial monotone sequence (Vehtari et al. 2021, non-rank form)."""
    M, N = chains.shape
    x = chains - chains.mean(axis=1, keepdims=True)
    W = float(np.mean(chains.var(axis=1, ddof=1)))
    var_plus = (N - 1) / N * W + float(np.var(chains.mean(axis=1), ddof=1)) if M > 1 else W
    if var_plus <= 0:
        return float(M * N)
    nfft = 1 << (2 * N - 1).bit_length()
    acov = np.zeros(N)
    for chain in x:
        f = np.fft.rfft(chain, nfft)
        ac = np.fft.irfft(f * np.conj(f))[:N] / N
        acov += ac
    acov /= M
    rho = 1.0 - (W - acov) / var_plus
    rho[0] = 1.0
    tau = -1.0
    t = 0
    prev_pair = math.inf
    while t + 1 < N:
        pair = rho[t] + rho[t + 1]
        if pair < 0:
            break
        pair = min(pair, prev_pair)  # monotone
        tau += 2 * pair
        prev_pair = pair
        t += 2
    return float(M * N / max(tau, 1e-9))


def _q(a: np.ndarray, lo=0.05, hi=0.95) -> dict:
    return {"mean": float(np.mean(a)), "sd": float(np.std(a)), "q05": float(np.quantile(a, lo)), "q50": float(np.quantile(a, 0.5)), "q95": float(np.quantile(a, hi))}


def fit_mmm(
    y: list[float],
    spend: list[list[float]],
    channel_names: list[str],
    controls: list[list[float]] | None = None,
    experiment_priors: list[dict] | None = None,
    gates: dict | None = None,
    seed: int = 20261019,
    n_chains: int = 4,
    n_warm: int = 800,
    n_draws: int = 1000,
    total_budget: float | None = None,
) -> dict:
    Y = np.asarray(y, dtype=float)
    X = np.asarray(spend, dtype=float)
    if X.ndim != 2 or X.shape[0] != len(Y):
        raise ValueError("spend must be T x C")
    T, C = X.shape
    Z = np.asarray(controls, dtype=float) if controls else None
    min_T = max(20, 3 * (2 + 4 * C + (Z.shape[1] if Z is not None else 0) + 1))
    if T < min_T:
        return {"status": "abstained", "reason": f"insufficient data: {T} periods < {min_T} required for {C} channels", "converged": False, "causalLanguageAllowed": False}
    if np.any(X < 0):
        raise ValueError("spend cannot be negative")

    priors: list[ChannelPrior] = []
    exp_by_channel = {p["channel"]: p for p in (experiment_priors or [])}
    y_scale = float(np.mean(Y)) or 1.0
    for c, name in enumerate(channel_names):
        e = exp_by_channel.get(name)
        if e:
            # A randomized holdout measures incremental KPI per period at (approximately) the channel's
            # average spend, which is exactly the rho parameter; only the KPI scaling is applied.
            mean = float(e["liftPerPeriod"]) / y_scale
            sd = max(float(e["se"]) / y_scale, 1e-4)
            priors.append(ChannelPrior("experiment", max(mean, 0.0), sd, f"experiment:{e.get('experimentId', 'unknown')}"))
        else:
            # Weakly informative: incremental KPI at average spend up to ~half the mean KPI.
            priors.append(ChannelPrior("half_normal", 0.0, 0.5, "default_weakly_informative"))

    model = MMM(Y, X, Z, channel_names, priors)
    rng = np.random.default_rng(seed)
    start, cov = _map(model, rng)
    chains = []
    acc = []
    sampler_info = []
    for m in range(n_chains):
        s0 = start + rng.multivariate_normal(np.zeros(model.D), cov * 0.1)
        samples, a, info = _chain(model, s0, n_warm, n_draws, np.random.default_rng(seed + 1000 * (m + 1)))
        chains.append(samples)
        acc.append(a)
        sampler_info.append(info)
    draws = np.stack(chains)  # (M, N, D)
    rhats = [split_rhat(draws[:, :, d]) for d in range(model.D)]
    esss = [bulk_ess(draws[:, :, d]) for d in range(model.D)]
    g = gates or DEFAULT_GATES
    divergences = sum(i["divergences"] for i in sampler_info)
    converged = max(rhats) <= g["maxRhat"] and min(esss) >= g["minEss"] and divergences == 0

    flat = draws.reshape(-1, model.D)
    # Thin for downstream summaries.
    idx = np.linspace(0, len(flat) - 1, min(1000, len(flat))).astype(int)
    sub = flat[idx]
    contrib = np.zeros((len(sub), C))
    beta_s = np.zeros((len(sub), C))
    alpha_s = np.zeros((len(sub), C))
    k_s = np.zeros((len(sub), C))
    s_s = np.zeros((len(sub), C))
    for i, th in enumerate(sub):
        _, _, _, beta, alpha, k, s, _ = model.unpack(th)
        media = model.media_terms(alpha, k, s)
        contrib[i] = (media * beta).sum(axis=0) * y_scale
        beta_s[i], alpha_s[i], k_s[i], s_s[i] = beta, alpha, k, s

    total_kpi = float(Y.sum())
    channels = {}
    for c, name in enumerate(channel_names):
        sp = float(X[:, c].sum())
        channels[name] = {
            "contribution": _q(contrib[:, c]),
            "shareOfKpi": _q(contrib[:, c] / total_kpi),
            "roi": _q(contrib[:, c] / sp) if sp > 0 else None,
            "beta": _q(beta_s[:, c]),
            "adstockDecay": _q(alpha_s[:, c]),
            "halfSaturation": _q(k_s[:, c] * model.spend_scale[c]),
            "hillSlope": _q(s_s[:, c]),
            "totalSpend": sp,
            "prior": {"parameter": "incremental_kpi_per_period_at_average_spend (mean-scaled)", "kind": priors[c].kind, "mean": priors[c].mean, "sd": priors[c].sd, "source": priors[c].source},
        }

    # Steady-state response curves: constant spend per period -> incremental KPI per period.
    curves = {}
    for c, name in enumerate(channel_names):
        avg = float(X[:, c].mean())
        grid = np.linspace(0, max(2 * avg, 1e-9), 21)
        resp = np.array([[beta_s[i, c] * hill(np.array([g_ / model.spend_scale[c]]), k_s[i, c], s_s[i, c])[0] * y_scale for g_ in grid] for i in range(len(sub))])
        curves[name] = {"spend": grid.tolist(), "mean": resp.mean(axis=0).tolist(), "q05": np.quantile(resp, 0.05, axis=0).tolist(), "q95": np.quantile(resp, 0.95, axis=0).tolist()}

    budget = _budget_scenarios(X, model, beta_s, k_s, s_s, y_scale, total_budget)
    assumptions = [
        "Media effects are additive across channels after adstock and saturation transformations.",
        "Geometric adstock and Hill saturation adequately describe carryover and diminishing returns.",
        "Spend is not driven by unobserved shocks to the KPI beyond the included controls (no unmeasured confounding).",
        "Effects are stationary over the modelling window.",
        "Priors as recorded; experiment-calibrated priors assume the experiment population matches the modelled population.",
    ]
    return {
        "status": "ok",
        "converged": bool(converged),
        "causalLanguageAllowed": bool(converged),
        "inferenceKind": "mmm_estimate",
        "diagnostics": {
            "maxRhat": float(max(rhats)),
            "minEss": float(min(esss)),
            "rhat": dict(zip(_param_names(model), map(float, rhats))),
            "acceptance": [float(a) for a in acc],
            "sampler": "nuts",
            "samplerInfo": sampler_info,
            "divergences": divergences,
            "chains": n_chains,
            "drawsPerChain": n_draws,
            "warmup": n_warm,
            "gates": {**g, "source": "tenant" if gates else "literature_default"},
        },
        "priors": {name: channels[name]["prior"] for name in channel_names},
        "channels": channels,
        "responseCurves": curves,
        "budgetScenarios": budget,
        "assumptions": assumptions,
    }


def _param_names(model: MMM) -> list[str]:
    n = ["intercept", "trend"] + [f"gamma[{j}]" for j in range(model.J)]
    for p in ("log_beta", "logit_alpha", "log_K", "log_S"):
        n += [f"{p}[{c}]" for c in model.names]
    return n + ["log_sigma"]


def _budget_scenarios(X, model: MMM, beta_s, k_s, s_s, y_scale, total_budget):
    current = X.mean(axis=0)
    B = float(total_budget if total_budget is not None else current.sum())
    C = X.shape[1]

    def resp_draws(alloc: np.ndarray) -> np.ndarray:
        x = alloc / model.spend_scale
        return np.array([sum(beta_s[i, c] * hill(np.array([x[c]]), k_s[i, c], s_s[i, c])[0] for c in range(C)) * y_scale for i in range(len(beta_s))])

    def neg_mean(alloc: np.ndarray) -> float:
        x = alloc / model.spend_scale
        bm, km, sm = beta_s.mean(axis=0), np.median(k_s, axis=0), np.median(s_s, axis=0)
        return -float(sum(bm[c] * hill(np.array([x[c]]), km[c], sm[c])[0] for c in range(C)) * y_scale)

    bounds = [(0.0, max(2 * current[c], B)) for c in range(C)]
    cons = [{"type": "eq", "fun": lambda a: float(a.sum() - B)}]
    best = None
    starts = [current * (B / max(current.sum(), 1e-9)), np.full(C, B / C)]
    for x0 in starts:
        res = minimize(neg_mean, x0, method="SLSQP", bounds=bounds, constraints=cons, options={"maxiter": 500})
        if res.success and (best is None or res.fun < best.fun):
            best = res
    cur_d = resp_draws(current * (B / max(current.sum(), 1e-9)))
    out = {"totalBudgetPerPeriod": B, "current": {"allocation": (current * (B / max(current.sum(), 1e-9))).tolist(), "kpi": _q(cur_d)}}
    if best is not None:
        opt_d = resp_draws(best.x)
        out["optimized"] = {"allocation": best.x.tolist(), "kpi": _q(opt_d), "probBetterThanCurrent": float(np.mean(opt_d > cur_d)), "incrementalKpi": _q(opt_d - cur_d)}
    else:
        out["optimized"] = None
    return out
