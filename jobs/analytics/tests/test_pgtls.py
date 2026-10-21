import os

import pytest
from psycopg.conninfo import conninfo_to_dict

from futuregrow_analytics.pgtls import DbTlsConfigError, secure_dsn

REMOTE = "postgresql://u:p@db.internal.example:5432/app"


def params(dsn: str) -> dict:
    return conninfo_to_dict(dsn)


def test_require_becomes_verify_full_with_an_explicit_ca(tmp_path):
    ca = tmp_path / "ca.pem"
    ca.write_text("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
    p = params(secure_dsn(f"{REMOTE}?sslmode=require&application_name=x", {"DATABASE_SSL_CA": str(ca)}))
    assert p["sslmode"] == "verify-full"
    assert p["sslrootcert"] == str(ca)
    assert p["host"] == "db.internal.example" and p["application_name"] == "x"


def test_pem_text_is_written_to_a_private_file():
    pem = "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----"
    p = params(secure_dsn(REMOTE, {"DATABASE_SSL": "true", "DATABASE_SSL_CA": pem}))
    with open(p["sslrootcert"], encoding="utf-8") as f:
        assert f.read().startswith("-----BEGIN CERTIFICATE-----\nMIIB")
    if os.name == "posix":
        assert oct(os.stat(p["sslrootcert"]).st_mode & 0o777) == "0o600"


def test_system_bundle_when_no_ca_is_configured():
    p = params(secure_dsn(f"{REMOTE}?sslmode=verify-full", {}))
    assert p["sslmode"] == "verify-full"
    assert p["sslrootcert"] == "system" or os.path.isfile(p["sslrootcert"])


def test_modes_that_skip_verification_are_refused():
    for mode in ("allow", "no-verify"):
        with pytest.raises(DbTlsConfigError):
            secure_dsn(f"{REMOTE}?sslmode={mode}", {})
    with pytest.raises(DbTlsConfigError, match="conflicts"):
        secure_dsn(f"{REMOTE}?sslmode=disable", {"DATABASE_SSL": "true"})
    with pytest.raises(DbTlsConfigError, match="true or false"):
        secure_dsn(REMOTE, {"DATABASE_SSL": "yes"})


def test_production_defaults_to_tls_and_refuses_remote_plaintext():
    assert params(secure_dsn(REMOTE, {"NODE_ENV": "production"}))["sslmode"] == "verify-full"
    assert params(secure_dsn(REMOTE, {}))["sslmode"] == "disable"
    with pytest.raises(DbTlsConfigError, match="unencrypted"):
        secure_dsn(f"{REMOTE}?sslmode=disable", {"NODE_ENV": "production"})
    with pytest.raises(DbTlsConfigError, match="unencrypted"):
        secure_dsn(REMOTE, {"NODE_ENV": "production", "DATABASE_SSL": "false"})
    # Loopback without TLS is acceptable (sidecar / local tests).
    assert params(secure_dsn("postgresql://u:p@localhost:5432/app", {"NODE_ENV": "production", "DATABASE_SSL": "false"}))["sslmode"] == "disable"


def test_unreadable_ca_fails_before_connecting():
    with pytest.raises(DbTlsConfigError, match="cannot read CA file"):
        secure_dsn(REMOTE, {"DATABASE_SSL": "true", "DATABASE_SSL_CA": "/nonexistent/ca.pem"})
