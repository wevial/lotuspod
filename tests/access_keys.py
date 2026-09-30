"""Cloudflare Access assertions for tests, signed with the test key.

tests/fixtures/access/test-key.json is a 2048-bit RSA key made for these
tests only and trusted nowhere else; certs.json is its public half as the key
set a team's /cdn-cgi/access/certs lists. `assertion()` signs a token the way
Access does; the keyword arguments bend one part of it at a time.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import random
import time
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "access"
KEY_PATH = FIXTURES / "test-key.json"
CERTS_PATH = FIXTURES / "certs.json"

ISSUER = "https://lotuspod-test.cloudflareaccess.com"
AUDIENCE = "lotuspod-test-audience-0123456789abcdef"
EMAIL = "maintainer@example.com"

_KEY = json.loads(KEY_PATH.read_text(encoding="utf-8"))
KID = _KEY["kid"]
_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _int(text: str) -> int:
    return int.from_bytes(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)), "big")


def _bytes(value: int) -> bytes:
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


# (n, e, d) of the test key.
TEST_KEY = (_int(_KEY["n"]), _int(_KEY["e"]), _int(_KEY["d"]))


def jwk(kid: str = KID, key: tuple[int, int, int] = TEST_KEY) -> dict:
    """The public JWK of key under kid, as Access lists it."""
    n, e, _d = key
    return {"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
            "n": b64url(_bytes(n)), "e": b64url(_bytes(e))}


def key_set(*kids: str, key: tuple[int, int, int] = TEST_KEY) -> dict:
    """A key set listing key under each of kids (the test key id by default)."""
    return {"keys": [jwk(kid, key) for kid in (kids or (KID,))]}


def config_section(certs_url: str | None = None, allowed_emails: str = EMAIL) -> dict:
    """An [access] config section trusting the test key."""
    return {
        "issuer": ISSUER,
        "audience": AUDIENCE,
        "certs_url": certs_url or CERTS_PATH.as_uri(),
        "allowed_emails": allowed_emails,
    }


def config_text(certs_url: str | None = None, allowed_emails: str = EMAIL) -> str:
    """A config file whose [access] section trusts the test key."""
    lines = ["[access]"]
    lines += [f"{k} = {v}" for k, v in config_section(certs_url, allowed_emails).items()]
    return "\n".join(lines) + "\n"


def claims(email: str = EMAIL, *, lifetime: int = 3600, now: float | None = None,
           **overrides) -> dict:
    """Claims as Access writes them; overrides replace (None removes) one."""
    now = int(time.time() if now is None else now)
    body = {
        "aud": [AUDIENCE],
        "email": email,
        "exp": now + lifetime,
        "iat": now,
        "nbf": now,
        "iss": ISSUER,
        "type": "app",
        "sub": "00000000-0000-0000-0000-000000000000",
    }
    for name, value in overrides.items():
        if value is None:
            body.pop(name, None)
        else:
            body[name] = value
    return body


def segment(value: dict) -> str:
    return b64url(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def rs256(signing_input: bytes, key: tuple[int, int, int] = TEST_KEY) -> bytes:
    n, _e, d = key
    size = (n.bit_length() + 7) // 8
    t = _DIGEST_INFO + hashlib.sha256(signing_input).digest()
    block = b"\x00\x01" + b"\xff" * (size - len(t) - 3) + b"\x00" + t
    return pow(int.from_bytes(block, "big"), d, n).to_bytes(size, "big")


def sign(body: dict, *, kid: str = KID, key: tuple[int, int, int] = TEST_KEY,
         header: dict | None = None) -> str:
    """body signed RS256 under kid; header replaces the JOSE header."""
    head = segment(header if header is not None else {"alg": "RS256", "kid": kid, "typ": "JWT"})
    signing_input = f"{head}.{segment(body)}"
    return f"{signing_input}.{b64url(rs256(signing_input.encode('ascii'), key))}"


def assertion(email: str = EMAIL, *, kid: str = KID, lifetime: int = 3600,
              **overrides) -> str:
    """A signed assertion for email; see claims() for overrides."""
    return sign(claims(email, lifetime=lifetime, **overrides), kid=kid)


def hs256_with_public_key(body: dict, kid: str = KID) -> str:
    """body "signed" HS256 with the public key's JWK text as the secret."""
    head = segment({"alg": "HS256", "kid": kid, "typ": "JWT"})
    signing_input = f"{head}.{segment(body)}"
    secret = json.dumps(jwk(kid)).encode("utf-8")
    mac = hmac.new(secret, signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(mac)}"


def unsigned(body: dict, kid: str = KID) -> str:
    """body with alg none and an empty signature."""
    return f"{segment({'alg': 'none', 'kid': kid, 'typ': 'JWT'})}.{segment(body)}."


def _probable_prime(bits: int, rng: random.Random) -> int:
    small = (3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)
    while True:
        p = rng.getrandbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if any(p % q == 0 for q in small):
            continue
        d, r = p - 1, 0
        while d % 2 == 0:
            d, r = d // 2, r + 1
        for _ in range(32):
            x = pow(rng.randrange(2, p - 2), d, p)
            if x in (1, p - 1):
                continue
            for _ in range(r - 1):
                x = pow(x, 2, p)
                if x == p - 1:
                    break
            else:
                break
        else:
            return p


def generate_key(bits: int, seed: int = 0) -> tuple[int, int, int]:
    """A throwaway (n, e, d) of bits bits, for keys the tests must see refused."""
    rng = random.Random(seed)
    e = 65537
    while True:
        p = _probable_prime(bits // 2, rng)
        q = _probable_prime(bits - bits // 2, rng)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            return p * q, e, pow(e, -1, phi)
