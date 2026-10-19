"""M04 customer-language clustering: TF-IDF + k-means++ with silhouette-selected k (NumPy only)."""

from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np

STOPWORDS = set(
    """a about above after again against all am an and any are as at be because been before being below between both but by can
cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself
his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours
ourselves out over own same she should so some such than that the their theirs them themselves then there these they this
those through to too under until up very was we were what when where which while who whom why will with would you your yours
yourself yourselves hi hello thanks thank please get got also can't don't i'm it's im dont cant""".split()
)

TOKEN_RE = re.compile(r"[a-z][a-z0-9'+-]{1,30}")


def tokenize(text: str) -> list[str]:
    return [t for t in TOKEN_RE.findall(text.lower()) if t not in STOPWORDS]


def tfidf(docs: list[list[str]], max_features: int = 2000, min_df: int = 2):
    df = Counter(t for d in docs for t in set(d))
    vocab = [t for t, c in df.most_common() if c >= min_df][:max_features]
    index = {t: i for i, t in enumerate(vocab)}
    n = len(docs)
    idf = np.array([math.log((1 + n) / (1 + df[t])) + 1 for t in vocab])
    X = np.zeros((n, len(vocab)))
    for i, d in enumerate(docs):
        for t, c in Counter(d).items():
            j = index.get(t)
            if j is not None:
                X[i, j] = c
    X = X * idf
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return X / norms, vocab


def kmeans(X: np.ndarray, k: int, rng: np.random.Generator, iters: int = 100):
    n = len(X)
    centers = [X[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min(((X[:, None, :] - np.array(centers)[None]) ** 2).sum(-1), axis=1)
        probs = d2 / d2.sum() if d2.sum() > 0 else np.full(n, 1 / n)
        centers.append(X[rng.choice(n, p=probs)])
    C = np.array(centers)
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        dist = ((X[:, None, :] - C[None]) ** 2).sum(-1)
        new = dist.argmin(1)
        if np.array_equal(new, labels) and _ > 0:
            break
        labels = new
        for j in range(k):
            if (labels == j).any():
                C[j] = X[labels == j].mean(0)
    return labels, C


def silhouette(X: np.ndarray, labels: np.ndarray) -> float:
    D = np.sqrt(np.maximum(((X[:, None, :] - X[None]) ** 2).sum(-1), 0))
    scores = []
    for i in range(len(X)):
        same = labels == labels[i]
        if same.sum() <= 1:
            continue
        a = D[i, same].sum() / (same.sum() - 1)
        b = min(D[i, labels == c].mean() for c in set(labels.tolist()) if c != labels[i])
        scores.append((b - a) / max(a, b) if max(a, b) > 0 else 0.0)
    return float(np.mean(scores)) if scores else -1.0


def cluster_texts(items: list[dict], k_range=(2, 8), seed: int = 5, top_terms: int = 8) -> dict:
    """items: [{id, text}] -> clusters with labels (top terms), sizes and sample ids."""
    docs = [tokenize(i["text"]) for i in items]
    keep = [i for i, d in enumerate(docs) if len(d) >= 2]
    if len(keep) < 10:
        return {"status": "insufficient_data", "n": len(keep), "clusters": []}
    X, vocab = tfidf([docs[i] for i in keep])
    if X.shape[1] < 2:
        return {"status": "insufficient_vocabulary", "n": len(keep), "clusters": []}
    rng = np.random.default_rng(seed)
    sample = X if len(X) <= 1500 else X[rng.choice(len(X), 1500, replace=False)]
    best = None
    for k in range(k_range[0], min(k_range[1], len(keep) - 1) + 1):
        labels, C = kmeans(sample, k, np.random.default_rng(seed + k))
        if len(set(labels.tolist())) < 2:
            continue
        s = silhouette(sample, labels)
        if best is None or s > best[0]:
            best = (s, k)
    if best is None:
        return {"status": "no_structure", "n": len(keep), "clusters": []}
    k = best[1]
    labels, C = kmeans(X, k, np.random.default_rng(seed + k))
    clusters = []
    for j in range(k):
        idx = np.where(labels == j)[0]
        if not len(idx):
            continue
        terms = [vocab[t] for t in np.argsort(-C[j])[:top_terms]]
        clusters.append({"label": " / ".join(terms[:3]), "terms": terms, "size": int(len(idx)), "sampleRefs": [items[keep[i]]["id"] for i in idx[:10]]})
    clusters.sort(key=lambda c: -c["size"])
    return {"status": "ok", "k": k, "silhouette": best[0], "n": len(keep), "clusters": clusters}
