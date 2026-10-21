"""Encrypted logical backups to object storage, verification and restore drills (M24 backup/restore).

Archive format ``futuregrow-logical-backup`` v1 (a tar file):

* ``manifest.json`` - plaintext: format/version, creation time, server version, applied Drizzle
  migration hashes, and per table the row count plus SHA-256 and size of its stored member. It
  contains no row data.
* ``tables/<name>.csv.gz.enc`` - ``COPY <table> (columns) TO STDOUT (FORMAT csv, HEADER)``, gzip'd,
  then AES-256-GCM encrypted: ``b"FGB1" || nonce(12) || ciphertext+tag`` with AAD
  ``<object key>|<table>`` so members cannot be swapped between tables or archives.

All tables are read in one ``REPEATABLE READ, READ ONLY`` transaction, so the archive is a
consistent snapshot. Generated columns are excluded and recomputed on restore. Encryption happens
per member, which bounds memory to the largest table.

The archive and a sidecar ``<key>.manifest.json`` (with the archive's SHA-256) are uploaded to the
object store (Cloudflare R2 in production). Verification works at two levels: without the key it
checks hashes and the internal manifest; with the key it decrypts every member and counts CSV rows.
``restore`` loads an archive into an empty database that has the same migrations applied.
"""

from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import hmac
import io
import json
import os
import socket
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Protocol

import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg import sql

from .pgtls import secure_dsn

FORMAT = "futuregrow-logical-backup"
VERSION = 1
MAGIC = b"FGB1"
PREFIX = "backups/"
# Reference tables written by migrations themselves; a migrated target already holds them.
MIGRATION_OWNED = frozenset({"action_state_transitions", "fg_security_config"})


# --------------------------------------------------------------------------- object stores


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes, content_type: str) -> None: ...

    def get(self, key: str) -> bytes: ...

    def list(self, prefix: str) -> list[str]: ...


class FilesystemStore:
    """Local directory store for development and tests."""

    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        if ".." in key.split("/"):
            raise ValueError("invalid key")
        return self.root / key

    def put(self, key: str, data: bytes, content_type: str) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def list(self, prefix: str) -> list[str]:
        base = self._path(prefix.rstrip("/")) if prefix else self.root
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)).replace("\\", "/") for p in base.rglob("*") if p.is_file() and not p.name.endswith(".tmp"))


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def sigv4_headers(method: str, url: str, headers: dict[str, str], payload_sha256: str, access_key: str, secret_key: str, region: str, now: datetime, service: str = "s3") -> dict[str, str]:
    """AWS Signature Version 4 (header auth). Returns headers to send, including Authorization."""
    parts = urllib.parse.urlsplit(url)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    day = now.strftime("%Y%m%d")
    h = {k.lower(): " ".join(str(v).strip().split()) for k, v in headers.items()}
    h["host"] = parts.netloc
    h["x-amz-date"] = amz_date
    h["x-amz-content-sha256"] = payload_sha256
    signed = ";".join(sorted(h))
    canonical_headers = "".join(f"{k}:{h[k]}\n" for k in sorted(h))
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    canonical_query = "&".join(f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}" for k, v in sorted(query))
    canonical_uri = urllib.parse.quote(urllib.parse.unquote(parts.path or "/"), safe="/-_.~")
    creq = "\n".join([method, canonical_uri, canonical_query, canonical_headers, signed, payload_sha256])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(creq.encode()).hexdigest()])
    k = _hmac(("AWS4" + secret_key).encode(), day)
    k = _hmac(k, region)
    k = _hmac(k, service)
    k = _hmac(k, "aws4_request")
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    out = {key: value for key, value in h.items() if key != "host"}
    out["authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}"
    return out


class R2Store:
    """Cloudflare R2 through its S3-compatible API (path-style), signed with SigV4."""

    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str = "auto", timeout: float = 120.0):
        if not endpoint.startswith("https://"):
            raise ValueError("R2 endpoint must be https")
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.timeout = timeout

    def _request(self, method: str, path: str, query: dict[str, str] | None = None, body: bytes = b"", extra: dict[str, str] | None = None) -> bytes:
        url = f"{self.endpoint}/{self.bucket}/{urllib.parse.quote(path, safe='/-_.~')}" if path else f"{self.endpoint}/{self.bucket}"
        if query:
            url += "?" + urllib.parse.urlencode(sorted(query.items()))
        payload_hash = hashlib.sha256(body).hexdigest()
        headers = sigv4_headers(method, url, extra or {}, payload_hash, self.access_key, self.secret_key, self.region, datetime.now(timezone.utc))
        req = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None, method=method, headers=headers)
        last: Exception | None = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - https endpoint enforced above
                    return res.read()
            except urllib.error.HTTPError as exc:
                if exc.code < 500 or attempt == 3:
                    raise RuntimeError(f"R2 {method} {path or '/'} failed: HTTP {exc.code} {exc.read()[:300]!r}") from exc
                last = exc
            except urllib.error.URLError as exc:
                last = exc
            time.sleep(0.5 * 2**attempt)
        raise RuntimeError(f"R2 {method} {path or '/'} failed: {last}")

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self._request("PUT", key, body=data, extra={"content-type": content_type})

    def get(self, key: str) -> bytes:
        return self._request("GET", key)

    def list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token: str | None = None
        ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
        while True:
            q = {"list-type": "2", "prefix": prefix}
            if token:
                q["continuation-token"] = token
            root = ET.fromstring(self._request("GET", "", query=q))
            keys += [el.text or "" for el in root.iter(f"{ns}Key")]
            truncated = (root.findtext(f"{ns}IsTruncated") or "false") == "true"
            token = root.findtext(f"{ns}NextContinuationToken")
            if not truncated or not token:
                return sorted(keys)


def store_from_env() -> ObjectStore:
    if os.environ.get("FG_BACKUP_FS_DIR"):
        return FilesystemStore(os.environ["FG_BACKUP_FS_DIR"])
    need = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    missing = [k for k in need if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"object store not configured: missing {', '.join(missing)} (or set FG_BACKUP_FS_DIR for local runs)")
    return R2Store(os.environ["R2_ENDPOINT"], os.environ.get("R2_BACKUP_BUCKET") or os.environ["R2_BUCKET"], os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"])


def load_key(raw: str | None) -> bytes:
    if not raw:
        raise SystemExit("FG_BACKUP_KEY (base64, 32 bytes) is required")
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise SystemExit("FG_BACKUP_KEY must decode to 32 bytes")
    return key


# --------------------------------------------------------------------------- crypto helpers


def encrypt_member(key: bytes, data: bytes, aad: str) -> bytes:
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, data, aad.encode())


def decrypt_member(key: bytes, blob: bytes, aad: str) -> bytes:
    if not blob.startswith(MAGIC) or len(blob) < 4 + 12 + 16:
        raise ValueError("not a FUTUREGROW backup member")
    return AESGCM(key).decrypt(blob[4:16], blob[16:], aad.encode())


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# --------------------------------------------------------------------------- database helpers


def _tables(cur: psycopg.Cursor) -> list[str]:
    cur.execute("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name")
    return [r[0] for r in cur.fetchall()]


def _columns(cur: psycopg.Cursor, table: str) -> list[str]:
    cur.execute(
        "select attname from pg_attribute where attrelid = %s::regclass and attnum > 0 and not attisdropped and attgenerated = '' order by attnum",
        (f'public."{table}"',),
    )
    return [r[0] for r in cur.fetchall()]


def _migrations(cur: psycopg.Cursor) -> list[str]:
    cur.execute("select to_regclass('drizzle.__drizzle_migrations') is not null")
    if not cur.fetchone()[0]:
        return []
    cur.execute("select hash from drizzle.__drizzle_migrations order by id")
    return [r[0] for r in cur.fetchall()]


def _fk_order(cur: psycopg.Cursor, tables: list[str]) -> list[str]:
    """Parents before children (self-references ignored)."""
    cur.execute(
        """select c.relname as child, p.relname as parent from pg_constraint k
           join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
           join pg_class p on p.oid = k.confrelid
           where k.contype = 'f' and n.nspname = 'public'"""
    )
    deps: dict[str, set[str]] = {t: set() for t in tables}
    for child, parent in cur.fetchall():
        if child in deps and parent in deps and child != parent:
            deps[child].add(parent)
    order: list[str] = []
    ready = sorted(t for t, d in deps.items() if not d)
    while ready:
        t = ready.pop(0)
        order.append(t)
        for c, d in deps.items():
            if t in d:
                d.discard(t)
                if not d and c not in order and c not in ready:
                    ready.append(c)
                    ready.sort()
    if len(order) != len(tables):
        cyclic = sorted(set(tables) - set(order))
        raise RuntimeError(f"foreign-key cycle among: {', '.join(cyclic)}")
    return order


def _record(dsn: str, kind: str, status: str, started: datetime, object_key: str | None, archive_sha: str | None, size: int | None, counts: dict, details: dict) -> None:
    try:
        with psycopg.connect(dsn, autocommit=True) as c:
            c.execute(
                "insert into backup_runs (kind, status, object_key, archive_sha256, bytes, table_counts, details, started_at, finished_at) values (%s,%s,%s,%s,%s,%s,%s,%s,now())",
                (kind, status, object_key, archive_sha, size, json.dumps(counts), json.dumps(details, default=str), started),
            )
    except Exception as exc:  # noqa: BLE001 - recording must not mask the operation result
        print(f"warning: could not record backup run: {exc}", file=sys.stderr)


# --------------------------------------------------------------------------- operations


def create_backup(dsn: str, store: ObjectStore, key: bytes, now: datetime | None = None) -> dict:
    started = now or datetime.now(timezone.utc)
    object_key = f"{PREFIX}{started:%Y/%m/%d}/{started:%Y%m%dT%H%M%SZ}-{socket.gethostname()[:20]}.fgb"
    out = io.BytesIO()
    manifest: dict = {"format": FORMAT, "version": VERSION, "createdAt": started.isoformat(), "objectKey": object_key, "tables": {}}
    with psycopg.connect(dsn, autocommit=True, application_name="futuregrow-backup") as conn:
        conn.execute("begin isolation level repeatable read, read only")
        with conn.cursor() as cur:
            cur.execute("show server_version")
            manifest["serverVersion"] = cur.fetchone()[0]
            manifest["migrations"] = _migrations(cur)
            with tarfile.open(fileobj=out, mode="w") as tar:
                for table in _tables(cur):
                    cols = _columns(cur, table)
                    cur.execute(sql.SQL("select count(*) from public.{}").format(sql.Identifier(table)))
                    rows = int(cur.fetchone()[0])
                    raw = io.BytesIO()
                    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
                        copy_sql = sql.SQL("copy public.{} ({}) to stdout (format csv, header)").format(sql.Identifier(table), sql.SQL(", ").join(map(sql.Identifier, cols)))
                        with cur.copy(copy_sql) as cp:
                            for chunk in cp:
                                gz.write(chunk)
                    blob = encrypt_member(key, raw.getvalue(), f"{object_key}|{table}")
                    name = f"tables/{table}.csv.gz.enc"
                    info = tarfile.TarInfo(name)
                    info.size = len(blob)
                    info.mtime = int(started.timestamp())
                    tar.addfile(info, io.BytesIO(blob))
                    manifest["tables"][table] = {"rows": rows, "columns": cols, "member": name, "sha256": sha256(blob), "bytes": len(blob)}
                m = json.dumps(manifest, sort_keys=True, indent=2).encode()
                info = tarfile.TarInfo("manifest.json")
                info.size = len(m)
                info.mtime = int(started.timestamp())
                tar.addfile(info, io.BytesIO(m))
        conn.execute("rollback")
    archive = out.getvalue()
    sidecar = {**manifest, "archiveSha256": sha256(archive), "archiveBytes": len(archive)}
    store.put(object_key, archive, "application/x-tar")
    store.put(object_key + ".manifest.json", json.dumps(sidecar, sort_keys=True, indent=2).encode(), "application/json")
    counts = {t: v["rows"] for t, v in manifest["tables"].items()}
    _record(dsn, "backup", "succeeded", started, object_key, sidecar["archiveSha256"], len(archive), counts, {"tables": len(counts), "migrations": len(manifest["migrations"])})
    return sidecar


def latest_backup_key(store: ObjectStore) -> str | None:
    keys = [k for k in store.list(PREFIX) if k.endswith(".fgb")]
    return keys[-1] if keys else None


def _open_archive(store: ObjectStore, object_key: str) -> tuple[dict, dict, dict[str, bytes], list[str]]:
    problems: list[str] = []
    sidecar = json.loads(store.get(object_key + ".manifest.json"))
    archive = store.get(object_key)
    if sha256(archive) != sidecar.get("archiveSha256"):
        problems.append("archive SHA-256 does not match the sidecar manifest")
    members: dict[str, bytes] = {}
    inner: dict = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r") as tar:
        for m in tar.getmembers():
            if not m.isfile() or m.name.startswith("/") or ".." in m.name.split("/"):
                problems.append(f"unexpected archive member {m.name}")
                continue
            data = tar.extractfile(m).read()  # type: ignore[union-attr]
            if m.name == "manifest.json":
                inner = json.loads(data)
            else:
                members[m.name] = data
    if inner.get("format") != FORMAT or inner.get("version") != VERSION:
        problems.append("unsupported or missing internal manifest")
    if inner.get("tables") != sidecar.get("tables"):
        problems.append("internal and sidecar manifests disagree")
    return sidecar, inner, members, problems


def verify_backup(store: ObjectStore, object_key: str, key: bytes | None) -> dict:
    sidecar, _inner, members, problems = _open_archive(store, object_key)
    counted: dict[str, int] = {}
    for table, meta in sorted(sidecar.get("tables", {}).items()):
        blob = members.get(meta["member"])
        if blob is None:
            problems.append(f"{table}: member missing")
            continue
        if sha256(blob) != meta["sha256"]:
            problems.append(f"{table}: member SHA-256 mismatch")
            continue
        if key is None:
            continue
        try:
            text = gzip.decompress(decrypt_member(key, blob, f"{object_key}|{table}")).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{table}: cannot decrypt/decompress ({type(exc).__name__})")
            continue
        reader = csv.reader(io.StringIO(text, newline=""))
        header = next(reader, None)
        n = sum(1 for _ in reader)
        counted[table] = n
        if header != meta["columns"]:
            problems.append(f"{table}: column header differs from manifest")
        if n != meta["rows"]:
            problems.append(f"{table}: {n} rows in member, manifest says {meta['rows']}")
    return {"objectKey": object_key, "ok": not problems, "problems": problems, "decrypted": key is not None, "tables": len(sidecar.get("tables", {})), "rows": counted, "createdAt": sidecar.get("createdAt")}


def restore_backup(store: ObjectStore, object_key: str, key: bytes, target_dsn: str) -> dict:
    """Load an archive into an EMPTY database migrated to the same schema version."""
    sidecar, _inner, members, problems = _open_archive(store, object_key)
    if problems:
        raise RuntimeError("refusing to restore an archive that fails verification: " + "; ".join(problems))
    with psycopg.connect(target_dsn, application_name="futuregrow-restore") as conn:
        with conn.cursor() as cur:
            if _migrations(cur) != sidecar.get("migrations", []):
                raise RuntimeError("target database migrations differ from the backup; run the same release's migrations first")
            tables = _tables(cur)
            unknown = sorted(set(sidecar["tables"]) - set(tables))
            if unknown:
                raise RuntimeError(f"tables missing in target: {', '.join(unknown)}")
            skipped: list[str] = []
            for t in tables:
                cur.execute(sql.SQL("select exists(select 1 from public.{})").format(sql.Identifier(t)))
                if cur.fetchone()[0]:
                    if t not in MIGRATION_OWNED:
                        raise RuntimeError(f"target table {t} is not empty")
                    skipped.append(t)
            order = [t for t in _fk_order(cur, tables) if t in sidecar["tables"] and t not in skipped]
            # User triggers (append-only guards, outbox enqueue) must not fire for restored history.
            for t in order:
                cur.execute(sql.SQL("alter table public.{} disable trigger user").format(sql.Identifier(t)))
            for t in order:
                meta = sidecar["tables"][t]
                data = gzip.decompress(decrypt_member(key, members[meta["member"]], f"{object_key}|{t}"))
                copy_sql = sql.SQL("copy public.{} ({}) from stdin (format csv, header)").format(sql.Identifier(t), sql.SQL(", ").join(map(sql.Identifier, meta["columns"])))
                with cur.copy(copy_sql) as cp:
                    for i in range(0, len(data), 1 << 20):
                        cp.write(data[i : i + (1 << 20)])
            for t in order:
                cur.execute(sql.SQL("alter table public.{} enable trigger user").format(sql.Identifier(t)))
            # Advance sequences behind restored ids.
            cur.execute(
                """select c.relname, a.attname, pg_get_serial_sequence(format('public.%I', c.relname), a.attname)
                   from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
                     and pg_get_serial_sequence(format('public.%I', c.relname), a.attname) is not null"""
            )
            for table, col, seq in cur.fetchall():
                cur.execute(sql.SQL("select setval(%s, coalesce((select max({}) from public.{}), 1), (select count(*) > 0 from public.{}))").format(sql.Identifier(col), sql.Identifier(table), sql.Identifier(table)), (seq,))
            counts = {}
            for t in order + skipped:
                cur.execute(sql.SQL("select count(*) from public.{}").format(sql.Identifier(t)))
                counts[t] = int(cur.fetchone()[0])
        conn.commit()
    mismatched = {t: (counts.get(t), m["rows"]) for t, m in sidecar["tables"].items() if counts.get(t) != m["rows"]}
    return {"objectKey": object_key, "ok": not mismatched, "mismatched": mismatched, "tables": len(counts), "rows": sum(counts.values()), "skippedMigrationOwned": skipped}


# --------------------------------------------------------------------------- CLI


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m futuregrow_analytics.backup", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("create", help="take an encrypted logical backup")
    v = sub.add_parser("verify", help="verify the latest (or a given) backup; non-zero exit on failure")
    v.add_argument("--key", dest="object_key")
    v.add_argument("--restore-into", help="also restore into this EMPTY, migrated database URL (restore drill)")
    r = sub.add_parser("restore", help="restore a backup into an empty, migrated database")
    r.add_argument("--key", dest="object_key")
    r.add_argument("--into", required=True)
    args = ap.parse_args(list(argv) if argv is not None else None)

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2
    dsn = secure_dsn(dsn)
    store = store_from_env()
    key = load_key(os.environ.get("FG_BACKUP_KEY"))
    started = datetime.now(timezone.utc)

    if args.cmd == "create":
        try:
            res = create_backup(dsn, store, key)
        except Exception as exc:  # noqa: BLE001
            _record(dsn, "backup", "failed", started, None, None, None, {}, {"error": f"{type(exc).__name__}: {exc}"})
            raise
        print(json.dumps({"objectKey": res["objectKey"], "archiveSha256": res["archiveSha256"], "bytes": res["archiveBytes"], "tables": len(res["tables"])}))
        return 0

    object_key = args.object_key or latest_backup_key(store)
    if not object_key:
        _record(dsn, "verification", "failed", started, None, None, None, {}, {"error": "no backups found"})
        print(json.dumps({"ok": False, "problems": ["no backups found"]}))
        return 1
    if args.cmd == "verify":
        res = verify_backup(store, object_key, key)
        if res["ok"] and args.restore_into:
            drill = restore_backup(store, object_key, key, secure_dsn(args.restore_into))
            res["restoreDrill"] = drill
            res["ok"] = drill["ok"]
            _record(dsn, "restore_drill", "succeeded" if drill["ok"] else "failed", started, object_key, None, None, {}, drill)
        _record(dsn, "verification", "succeeded" if res["ok"] else "failed", started, object_key, None, None, res.get("rows", {}), {"problems": res["problems"], "decrypted": res["decrypted"]})
        print(json.dumps(res, default=str))
        return 0 if res["ok"] else 1
    res = restore_backup(store, object_key, key, secure_dsn(args.into))
    print(json.dumps(res, default=str))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
