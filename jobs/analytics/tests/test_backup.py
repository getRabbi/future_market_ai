"""Unit tests for the backup module (no database): SigV4, member encryption, local store."""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest
from cryptography.exceptions import InvalidTag

from futuregrow_analytics.backup import FilesystemStore, decrypt_member, encrypt_member, sigv4_headers

EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_sigv4_matches_the_published_aws_s3_get_object_example():
    # AWS docs, "Signature calculations for the Authorization header", Example: GET Object.
    h = sigv4_headers(
        "GET",
        "https://examplebucket.s3.amazonaws.com/test.txt",
        {"Range": "bytes=0-9"},
        EMPTY_SHA,
        "AKIAIOSFODNN7EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "us-east-1",
        datetime(2013, 5, 24, tzinfo=timezone.utc),
    )
    assert h["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )
    assert "host" not in h


def test_sigv4_matches_aws4fetch_for_an_r2_list_request():
    # Same inputs signed by aws4fetch 1.x (used by the TypeScript storage package).
    h = sigv4_headers("GET", "https://acct.r2.cloudflarestorage.com/fg-backups?list-type=2&prefix=backups%2F", {}, "UNSIGNED-PAYLOAD", "AK", "SK", "auto", datetime(2026, 10, 20, 1, 2, 3, tzinfo=timezone.utc))
    assert h["authorization"].endswith("Signature=e82319250b8ef27bc59ead89d865b2d30df11db8ab5c7a9212be8ee04b1b7d58")


def test_members_are_bound_to_archive_and_table():
    key = os.urandom(32)
    blob = encrypt_member(key, b"id,name\n1,a\n", "backups/x.fgb|customers")
    assert blob.startswith(b"FGB1")
    assert decrypt_member(key, blob, "backups/x.fgb|customers") == b"id,name\n1,a\n"
    with pytest.raises(InvalidTag):
        decrypt_member(key, blob, "backups/x.fgb|audit_log")  # swapped table
    with pytest.raises(InvalidTag):
        decrypt_member(os.urandom(32), blob, "backups/x.fgb|customers")  # wrong key
    tampered = blob[:-1] + bytes([blob[-1] ^ 1])
    with pytest.raises(InvalidTag):
        decrypt_member(key, tampered, "backups/x.fgb|customers")


def test_filesystem_store_lists_and_rejects_traversal(tmp_path):
    s = FilesystemStore(str(tmp_path))
    s.put("backups/2026/10/20/a.fgb", b"x", "application/x-tar")
    s.put("backups/2026/10/20/a.fgb.manifest.json", b"{}", "application/json")
    assert s.list("backups/") == ["backups/2026/10/20/a.fgb", "backups/2026/10/20/a.fgb.manifest.json"]
    assert s.get("backups/2026/10/20/a.fgb") == b"x"
    with pytest.raises(ValueError):
        s.put("backups/../../escape", b"x", "text/plain")
