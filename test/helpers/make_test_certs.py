"""Throwaway TLS material for the PostgreSQL TLS tests (never used outside tests).

Usage: python make_test_certs.py <out-dir>
Writes ca.pem (trusted test CA), rogue-ca.pem (an unrelated CA), server.pem + server.key
(signed by ca.pem, SAN DNS:localhost only, so connecting to 127.0.0.1 must fail verify-full).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _ca(cn: str):
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name(cn))
        .issuer_name(_name(cn))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    ca_key, ca = _ca("FUTUREGROW test CA")
    _, rogue = _ca("Unrelated CA")
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    server = (
        x509.CertificateBuilder()
        .subject_name(_name("localhost"))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=2))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    pem = serialization.Encoding.PEM
    (out / "ca.pem").write_bytes(ca.public_bytes(pem))
    (out / "rogue-ca.pem").write_bytes(rogue.public_bytes(pem))
    (out / "server.pem").write_bytes(server.public_bytes(pem))
    key_path = out / "server.key"
    key_path.write_bytes(key.private_bytes(pem, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    key_path.chmod(0o600)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
