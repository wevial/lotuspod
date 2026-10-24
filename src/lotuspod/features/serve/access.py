"""Cloudflare Access: who the reader is, known only from a verified assertion.

Access signs every request it lets through with a JSON Web Token in the
Cf-Access-Jwt-Assertion header. The plain Cf-Access-Authenticated-User-Email
header proves nothing at the origin (any local process can send it), so it is
never read: the reader is taken from the claims of an assertion whose RS256
signature verifies against the team's published key set, and whose issuer,
audience, times and email are the ones configured.

Standard library only: an RS256 check is a modular exponentiation and a
comparison of the whole re-encoded PKCS#1 v1.5 block.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import http.client
import json
import math
import re
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Mapping

ASSERTION_HEADER = "Cf-Access-Jwt-Assertion"

# Seconds a fetched key set is trusted, and the shortest gap between two
# refetches caused by an unknown key id.
KEYS_TTL = 3600
UNKNOWN_KID_REFETCH = 60
# Seconds after a failed fetch before the key set is fetched again.
FAILED_FETCH_RETRY = 60
# Seconds of clock skew allowed on exp, nbf and iat.
LEEWAY = 60
MIN_KEY_BITS = 2048

_FETCH_TIMEOUT = 10
_MAX_KEY_SET_BYTES = 1 << 20
_MAX_ASSERTION_BYTES = 16 << 10
_CERTS_SCHEMES = ("https", "http", "file")

# DER of DigestInfo for SHA-256, up to the digest itself (RFC 8017, 9.2).
_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")
_B64URL = re.compile(r"[A-Za-z0-9_-]*")


class AccessError(Exception):
    """A refusal: the HTTP status and the error word the API answers with."""

    status = 401
    error = "invalid_assertion"


class SignedOut(AccessError):
    status = 401
    error = "signed_out"


class InvalidAssertion(AccessError):
    status = 401
    error = "invalid_assertion"


class Forbidden(AccessError):
    status = 403
    error = "forbidden"


class Unavailable(AccessError):
    status = 503
    error = "access_unavailable"


@dataclass(frozen=True)
class AccessConfig:
    issuer: str
    audience: str
    certs_url: str
    allowed_emails: frozenset[str]
    # The readers who may archive a page from the browser; none by default.
    owners: frozenset[str] = frozenset()


def parse_config(section: Mapping[str, str]) -> AccessConfig:
    """An [access] config section as AccessConfig; ValueError naming what is wrong.

    allowed_emails is a list separated by commas or white space; emails are
    compared lower-cased. owners, optional, is such a list too.
    """
    values = {key: (section.get(key) or "").strip()
              for key in ("issuer", "audience", "certs_url", "allowed_emails")}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise ValueError(f"[access] needs {', '.join(missing)}")
    scheme = urllib.parse.urlsplit(values["certs_url"]).scheme.lower()
    if scheme not in _CERTS_SCHEMES:
        raise ValueError("[access] certs_url must be an https:, http: or file: URL")
    return AccessConfig(
        issuer=values["issuer"],
        audience=values["audience"],
        certs_url=values["certs_url"],
        allowed_emails=_emails(values["allowed_emails"]),
        owners=_emails((section.get("owners") or "").strip()),
    )


def _emails(text: str) -> frozenset[str]:
    """A list separated by commas or white space, lower-cased."""
    return frozenset(email.lower() for email in re.split(r"[\s,]+", text) if email)


def _b64url(text: str) -> bytes:
    """Strict unpadded base64url; ValueError on anything else."""
    if not isinstance(text, str) or not _B64URL.fullmatch(text) or len(text) % 4 == 1:
        raise ValueError("not base64url")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except binascii.Error:
        raise ValueError("not base64url") from None


def _unique_object(pairs: list) -> dict:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate member")
    return dict(pairs)


def _no_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _json_object(data: bytes) -> dict:
    # NaN and Infinity are not JSON, though Python's decoder takes them.
    value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                       parse_constant=_no_constant)
    if not isinstance(value, dict):
        raise ValueError("not a JSON object")
    return value


def _rsa_key(jwk: object) -> tuple[str, int, int] | None:
    """(kid, n, e) of a usable RS256 signing key; None for anything else."""
    if not isinstance(jwk, dict):
        return None
    kid = jwk.get("kid")
    if not isinstance(kid, str) or not kid or jwk.get("kty") != "RSA":
        return None
    if jwk.get("alg", "RS256") != "RS256" or jwk.get("use", "sig") != "sig":
        return None
    try:
        n = int.from_bytes(_b64url(jwk.get("n")), "big")
        e = int.from_bytes(_b64url(jwk.get("e")), "big")
    except ValueError:
        return None
    if n.bit_length() < MIN_KEY_BITS or e < 3 or e % 2 == 0 or e >= n:
        return None
    return kid, n, e


def fetch_key_set(url: str) -> dict[str, tuple[int, int]]:
    """The usable keys of the key set at url, by key id; Unavailable when it
    cannot be fetched or is not a key set."""
    try:
        with urllib.request.urlopen(url, timeout=_FETCH_TIMEOUT) as response:
            data = response.read(_MAX_KEY_SET_BYTES + 1)
        if len(data) > _MAX_KEY_SET_BYTES:
            raise ValueError("key set too large")
        listed = _json_object(data).get("keys")
        if not isinstance(listed, list):
            raise ValueError("no keys list")
    # http.client's protocol errors (a truncated chunked body, a bad status
    # line) are not OSErrors; they fail closed like any other failed fetch.
    except (OSError, http.client.HTTPException, ValueError, RecursionError) as exc:
        raise Unavailable(f"cannot fetch the Access key set: {exc}") from None
    keys: dict[str, tuple[int, int]] = {}
    for jwk in listed:
        key = _rsa_key(jwk)
        if key is not None:
            kid, n, e = key
            keys[kid] = (n, e)
    return keys


class KeySet:
    """The team's keys: fetched on first need and kept for KEYS_TTL seconds.

    An unknown key id refetches at most once every UNKNOWN_KID_REFETCH
    seconds. A fetch that fails drops the keys held, so the guard fails
    closed until a fetch succeeds, and no fetch is tried again for
    FAILED_FETCH_RETRY seconds: until then every lookup is Unavailable.
    """

    def __init__(self, url: str, *, clock: Callable[[], float] = time.monotonic,
                 fetch: Callable[[str], dict] = fetch_key_set) -> None:
        self.url = url
        self._clock = clock
        self._fetch = fetch
        self._lock = threading.Lock()
        self._keys: dict[str, tuple[int, int]] | None = None
        self._fetched_at = 0.0
        self._miss_fetched_at: float | None = None
        self._failed_at: float | None = None

    def _refresh(self, now: float) -> None:
        self._keys = None
        try:
            self._keys = self._fetch(self.url)
        except Unavailable:
            self._failed_at = now
            raise
        self._failed_at = None
        self._fetched_at = now

    def key(self, kid: str) -> tuple[int, int] | None:
        """(n, e) of the key named kid, or None when the set does not hold it."""
        with self._lock:
            now = self._clock()
            fresh = False
            if self._keys is None or now - self._fetched_at >= KEYS_TTL:
                if self._failed_at is not None and now - self._failed_at < FAILED_FETCH_RETRY:
                    raise Unavailable("the Access key set could not be fetched")
                self._refresh(now)
                fresh = True
            key = self._keys.get(kid)
            if key is None and not fresh and (
                self._miss_fetched_at is None
                or now - self._miss_fetched_at >= UNKNOWN_KID_REFETCH
            ):
                self._miss_fetched_at = now
                self._refresh(now)
                key = self._keys.get(kid)
            return key


def rs256_verifies(key: tuple[int, int], signing_input: bytes, signature: bytes) -> bool:
    """Whether signature is the RSASSA-PKCS1-v1_5 SHA-256 signature of
    signing_input under key: the expected block is built whole and compared
    whole, never parsed out of the decrypted one."""
    n, e = key
    size = (n.bit_length() + 7) // 8
    if len(signature) != size:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    block = pow(s, e, n).to_bytes(size, "big")
    t = _SHA256_DIGEST_INFO + hashlib.sha256(signing_input).digest()
    if size < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (size - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(block, expected)


def _number(value: object) -> bool:
    """Whether value is a finite number: every comparison with NaN is false,
    and a literal such as 1e400 still decodes to infinity."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return isinstance(value, int) or math.isfinite(value)


class Verifier:
    """Checks assertions against one AccessConfig and its team's key set."""

    def __init__(self, config: AccessConfig, *, keys: KeySet | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.config = config
        self.keys = keys if keys is not None else KeySet(config.certs_url)
        self._clock = clock

    def reader(self, assertion: str | None) -> str:
        """The lower-cased email of the reader the assertion names.

        Raises SignedOut with no assertion, InvalidAssertion for one that
        does not verify, Forbidden for a verified one whose email is not
        allowed, and Unavailable when the key set cannot be fetched.
        """
        if not assertion:
            raise SignedOut("no assertion")
        if len(assertion) > _MAX_ASSERTION_BYTES:
            raise InvalidAssertion("assertion too long")
        parts = assertion.split(".")
        if len(parts) != 3:
            raise InvalidAssertion("not a signed token")
        try:
            header = _json_object(_b64url(parts[0]))
            claims = _json_object(_b64url(parts[1]))
            signature = _b64url(parts[2])
        except (ValueError, RecursionError):
            raise InvalidAssertion("malformed token") from None
        kid = header.get("kid")
        if header.get("alg") != "RS256" or "crit" in header:
            raise InvalidAssertion("not an RS256 token")
        if not isinstance(kid, str) or not kid:
            raise InvalidAssertion("no key id")
        key = self.keys.key(kid)
        if key is None:
            raise InvalidAssertion("unknown key id")
        signing_input = f"{parts[0]}.{parts[1]}".encode("ascii")
        if not rs256_verifies(key, signing_input, signature):
            raise InvalidAssertion("bad signature")
        self._check_claims(claims)
        email = claims.get("email")
        if not isinstance(email, str) or email.lower() not in self.config.allowed_emails:
            raise Forbidden("email not allowed")
        return email.lower()

    def _check_claims(self, claims: dict) -> None:
        if claims.get("iss") != self.config.issuer:
            raise InvalidAssertion("wrong issuer")
        aud = claims.get("aud")
        audiences = [aud] if isinstance(aud, str) else aud if isinstance(aud, list) else []
        if self.config.audience not in [a for a in audiences if isinstance(a, str)]:
            raise InvalidAssertion("wrong audience")
        now = self._clock()
        exp, iat, nbf = claims.get("exp"), claims.get("iat"), claims.get("nbf", 0)
        if not (_number(exp) and _number(iat) and _number(nbf)):
            raise InvalidAssertion("missing times")
        if exp <= now - LEEWAY:
            raise InvalidAssertion("expired")
        if nbf > now + LEEWAY or iat > now + LEEWAY:
            raise InvalidAssertion("not yet valid")
