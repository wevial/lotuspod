// The request-forgery token: minted for one maintainer and one Access
// session, short lived, and checked together with the request's origin.
// Neither the token nor the secret is ever logged.

import { decodeBase64Url, setting } from "./access.js";

const HEADER = "X-Lotuspod-Csrf";
const ALGORITHM = { name: "HMAC", hash: "SHA-256" };
const LIFETIME_SECONDS = 60 * 60;

function encodeBase64Url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importSecret(env, usage) {
  const secret = setting(env, "CSRF_SECRET");
  if (!secret) return null;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), ALGORITHM, false, [
    usage,
  ]);
}

function isBindable(identity) {
  return (
    identity?.kind === "user" &&
    typeof identity.email === "string" &&
    Number.isFinite(identity.iat)
  );
}

// { token, expiresAt } for a verified maintainer, expiresAt in epoch
// milliseconds. Null when the secret is unset or there is no maintainer
// session to bind to.
export async function issueCsrf(identity, env) {
  if (!isBindable(identity)) return null;
  const key = await importSecret(env, "sign");
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + LIFETIME_SECONDS;
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ actor: identity.email, iat: identity.iat, exp })),
  );
  const signature = await crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(payload));
  return { token: `${payload}.${encodeBase64Url(signature)}`, expiresAt: exp * 1000 };
}

function isSameOrigin(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return false;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin";
}

async function isGenuine(token, identity, env) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const key = await importSecret(env, "verify");
  if (!key) return false;
  const signature = decodeBase64Url(parts[1]);
  // One signature has one spelling: spare bits in the last character count.
  if (encodeBase64Url(signature) !== parts[1]) return false;
  const signed = new TextEncoder().encode(parts[0]);
  if (!(await crypto.subtle.verify(ALGORITHM, key, signature, signed))) return false;
  const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
  if (payload.actor !== identity.email || payload.iat !== identity.iat) return false;
  return typeof payload.exp === "number" && payload.exp * 1000 > Date.now();
}

// Whether a write may proceed: a same-origin request carrying a token
// minted for this maintainer and this Access session, not yet expired.
// Anything missing, malformed or failing on the way is a refusal.
export async function verifyCsrf(request, identity, env) {
  if (!isBindable(identity) || !isSameOrigin(request)) return false;
  const token = request.headers.get(HEADER);
  if (!token) return false;
  try {
    return await isGenuine(token, identity, env);
  } catch {
    return false;
  }
}
