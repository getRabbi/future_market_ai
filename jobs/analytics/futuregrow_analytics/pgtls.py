"""PostgreSQL TLS policy for the Python jobs (same rules as packages/db/src/tls.ts).

libpq's ``sslmode=require`` encrypts but does NOT verify the server certificate, so a DATABASE_URL
that works for the Node services (where node-postgres verifies) would silently skip verification
here. ``secure_dsn`` rewrites the DSN so every TLS connection is ``verify-full`` (chain and host
name) against an explicit CA file:

* ``sslmode=require|verify-ca|verify-full|prefer`` or ``DATABASE_SSL=true`` enable TLS; unset in
  production (``NODE_ENV=production``) also means TLS.
* ``sslmode=allow|no-verify`` are refused; ``sslmode=disable`` / ``DATABASE_SSL=false`` are refused
  in production unless the server is on loopback or a Unix socket.
* CA: ``DATABASE_SSL_CA`` (PEM text or a path), else ``PGSSLROOTCERT``, else ``sslrootcert`` in the
  URL, else the system bundle.
"""

from __future__ import annotations

import os
import ssl
import tempfile
from typing import Mapping

from psycopg.conninfo import conninfo_to_dict, make_conninfo

TLS_ON = {"require", "verify-ca", "verify-full", "prefer"}
TLS_KEYS = ("sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "sslcrl", "sslcrldir", "sslsni", "sslnegotiation", "sslcompression", "ssl_min_protocol_version", "ssl_max_protocol_version", "requiressl")
SYSTEM_BUNDLES = ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem")

_pem_files: dict[str, str] = {}


class DbTlsConfigError(ValueError):
    pass


def _is_local(hosts: list[str]) -> bool:
    return all(h == "" or h.startswith("/") or h in ("localhost", "::1") or h.startswith("127.") for h in hosts)


def _pem_to_file(pem: str) -> str:
    if pem not in _pem_files:
        fd, path = tempfile.mkstemp(prefix="fg-pg-ca-", suffix=".pem")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(pem.replace("\\n", "\n"))
        os.chmod(path, 0o600)
        _pem_files[pem] = path
    return _pem_files[pem]


def _ca_file(value: str, origin: str) -> str:
    value = value.strip()
    path = _pem_to_file(value) if "-----BEGIN" in value else value
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as exc:
        raise DbTlsConfigError(f"{origin}: cannot read CA file {path} ({exc})") from exc
    if "-----BEGIN CERTIFICATE-----" not in text:
        raise DbTlsConfigError(f"{origin}: no PEM certificate found")
    return path


def system_ca_bundle() -> str:
    paths = ssl.get_default_verify_paths()
    for p in (paths.cafile, paths.openssl_cafile, *SYSTEM_BUNDLES):
        if p and os.path.isfile(p):
            return p
    # libpq >= 16 resolves "system" to OpenSSL's default store.
    return "system"


def _flag(environ: Mapping[str, str]) -> bool | None:
    raw = (environ.get("DATABASE_SSL") or "").strip().lower()
    if raw in ("true", "1"):
        return True
    if raw in ("false", "0"):
        return False
    if raw:
        raise DbTlsConfigError("DATABASE_SSL must be true or false")
    return None


def secure_dsn(dsn: str, environ: Mapping[str, str] | None = None) -> str:
    env = os.environ if environ is None else environ
    params = {k: v for k, v in conninfo_to_dict(dsn).items() if v is not None}
    sslmode = (params.get("sslmode") or "").lower() or None
    rootcert = params.get("sslrootcert")
    for k in TLS_KEYS:
        params.pop(k, None)
    flag = _flag(env)
    production = env.get("NODE_ENV") == "production"
    hosts = [h.strip() for h in str(params.get("host") or params.get("hostaddr") or "").split(",")]

    if sslmode in ("allow", "no-verify"):
        raise DbTlsConfigError(f"sslmode={sslmode} disables certificate verification, which FUTUREGROW does not allow; use sslmode=verify-full")
    if sslmode and sslmode != "disable" and sslmode not in TLS_ON:
        raise DbTlsConfigError(f"unknown sslmode={sslmode}")
    if sslmode == "disable" and flag is True:
        raise DbTlsConfigError("DATABASE_SSL=true conflicts with sslmode=disable in DATABASE_URL")

    want_tls = flag is True or (sslmode in TLS_ON) or (flag is None and sslmode is None and production)
    if not want_tls:
        if production and not _is_local(hosts):
            raise DbTlsConfigError(f"refusing an unencrypted database connection to {','.join(hosts)} in production")
        return make_conninfo(**params, sslmode="disable")
    if any(h.startswith("/") for h in hosts):
        raise DbTlsConfigError("TLS was requested for a Unix-socket connection")

    if (env.get("DATABASE_SSL_CA") or "").strip():
        ca = _ca_file(env["DATABASE_SSL_CA"], "DATABASE_SSL_CA")
    elif (env.get("PGSSLROOTCERT") or "").strip() and env["PGSSLROOTCERT"].strip() != "system":
        ca = _ca_file(env["PGSSLROOTCERT"], "PGSSLROOTCERT")
    elif rootcert and rootcert != "system":
        ca = _ca_file(rootcert, "sslrootcert")
    else:
        ca = system_ca_bundle()
    return make_conninfo(**params, sslmode="verify-full", sslrootcert=ca)


def dsn_from_env(environ: Mapping[str, str] | None = None) -> str | None:
    env = os.environ if environ is None else environ
    dsn = env.get("DATABASE_URL")
    return secure_dsn(dsn, env) if dsn else None
