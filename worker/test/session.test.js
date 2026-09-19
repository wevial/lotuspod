import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { identify } from "../src/access.js";
import { issueCsrf, verifyCsrf } from "../src/csrf.js";
import worker from "../src/index.js";

const ORIGIN = "https://pages.example.com";
const ISSUER = `https://${env.ACCESS_TEAM_DOMAIN}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const HOUR = 60 * 60 * 1000;

function base64Url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function generateSigner(kid) {
  const pair = await crypto.subtle.generateKey(
    { ...ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

async function sign(claims) {
  const head = encodeJson({ alg: "RS256", typ: "JWT", kid: signer.kid });
  const signed = `${head}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    signer.privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${base64Url(signature)}`;
}

function baseClaims(extra) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: [env.ACCESS_AUD], iat: now - 10, exp: now + 300, ...extra };
}

function userClaims(extra) {
  return baseClaims({ email: env.ALLOWED_EMAIL, sub: "fixture-user", type: "app", ...extra });
}

function machineClaims() {
  return baseClaims({ common_name: env.MACHINE_CLIENT_ID, sub: "", type: "app" });
}

function sessionRequest(accessToken, init = {}) {
  const headers = accessToken ? { "Cf-Access-Jwt-Assertion": accessToken } : {};
  return new Request(`${ORIGIN}/api/session`, { ...init, headers });
}

// A write as the maintainer's own page would send it, unless overridden.
// A null header value leaves that header out.
function write(csrf, headers = {}) {
  const all = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Lotuspod-Csrf": csrf, ...headers };
  const present = Object.entries(all).filter(([, value]) => value !== null);
  return new Request(`${ORIGIN}/api/anything`, { method: "POST", headers: Object.fromEntries(present) });
}

function changeOneCharacter(token, index) {
  const replacement = token[index] === "A" ? "B" : "A";
  return token.slice(0, index) + replacement + token.slice(index + 1);
}

let signer;

beforeAll(async () => {
  signer = await generateSigner("fixture-key-1");
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CERTS_URL) throw new Error(`unexpected fetch of ${url}`);
    return Response.json({ keys: [signer.jwk] });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expectRefused(response, status) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");
}

describe("GET /api/session", () => {
  it("answers the verified maintainer with their address, a token and an expiry", async () => {
    const assets = { fetch: vi.fn() };
    const accessToken = await sign(userClaims());
    const before = Date.now();
    const response = await worker.fetch(sessionRequest(accessToken), { ...env, ASSETS: assets });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(assets.fetch).not.toHaveBeenCalled();
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["actor", "csrf", "expiresAt"]);
    expect(body.actor).toBe(env.ALLOWED_EMAIL);
    expect(body.csrf).toMatch(/^[\w-]+\.[\w-]+$/);
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + HOUR);
    // The token it hands out is one verifyCsrf accepts for that session.
    const who = await identify(sessionRequest(accessToken), env);
    expect(await verifyCsrf(write(body.csrf), who, env)).toBe(true);
  });

  it("refuses the machine identity", async () => {
    await expectRefused(await worker.fetch(sessionRequest(await sign(machineClaims())), env), 403);
  });

  it("refuses no identity", async () => {
    await expectRefused(await worker.fetch(sessionRequest(null), env), 403);
  });

  it("allows the maintainer no other method", async () => {
    const accessToken = await sign(userClaims());
    const response = await worker.fetch(sessionRequest(accessToken, { method: "POST" }), env);
    await expectRefused(response, 405);
  });
});

describe("verifyCsrf", () => {
  const who = { kind: "user", email: env.ALLOWED_EMAIL, iat: 1_790_000_000 };

  it("passes a same-origin request under the identity the token was issued to", async () => {
    const { token } = await issueCsrf(who, env);
    expect(await verifyCsrf(write(token), who, env)).toBe(true);
    // Sec-Fetch-Site is only checked when the browser sends it.
    expect(await verifyCsrf(write(token, { "Sec-Fetch-Site": null }), who, env)).toBe(true);
  });

  it("refuses a token issued to another address", async () => {
    const { token } = await issueCsrf(who, env);
    const other = { ...who, email: "someone-else@example.org" };
    expect(await verifyCsrf(write(token), other, env)).toBe(false);
  });

  it("refuses a token issued to an earlier Access session", async () => {
    const { token } = await issueCsrf(who, env);
    expect(await verifyCsrf(write(token), { ...who, iat: who.iat + 1 }, env)).toBe(false);
  });

  it("refuses a token past its expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { token, expiresAt } = await issueCsrf(who, env);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + HOUR);
    vi.setSystemTime(expiresAt - 1);
    expect(await verifyCsrf(write(token), who, env)).toBe(true);
    vi.setSystemTime(expiresAt);
    expect(await verifyCsrf(write(token), who, env)).toBe(false);
  });

  it("refuses a token with any one character changed", async () => {
    const { token } = await issueCsrf(who, env);
    for (let index = 0; index < token.length; index += 1) {
      const tampered = changeOneCharacter(token, index);
      expect(await verifyCsrf(write(tampered), who, env), `character ${index}`).toBe(false);
    }
  });

  it("refuses a request with no token", async () => {
    expect(await verifyCsrf(write(null), who, env)).toBe(false);
  });

  it("refuses the machine identity", async () => {
    const { token } = await issueCsrf(who, env);
    const machine = { kind: "machine", id: env.MACHINE_CLIENT_ID };
    expect(await issueCsrf(machine, env)).toBe(null);
    expect(await verifyCsrf(write(token), machine, env)).toBe(false);
  });

  it("refuses another site's Origin", async () => {
    const { token } = await issueCsrf(who, env);
    const request = write(token, { Origin: "https://elsewhere.example.net", "Sec-Fetch-Site": null });
    expect(await verifyCsrf(request, who, env)).toBe(false);
  });

  it("refuses an absent Origin", async () => {
    const { token } = await issueCsrf(who, env);
    expect(await verifyCsrf(write(token, { Origin: null }), who, env)).toBe(false);
  });

  it("refuses Sec-Fetch-Site: cross-site", async () => {
    const { token } = await issueCsrf(who, env);
    expect(await verifyCsrf(write(token, { "Sec-Fetch-Site": "cross-site" }), who, env)).toBe(false);
  });
});

describe("CSRF_SECRET unset", () => {
  it("answers the maintainer 503 with no token", async () => {
    const accessToken = await sign(userClaims());
    for (const value of [undefined, ""]) {
      const response = await worker.fetch(sessionRequest(accessToken), { ...env, CSRF_SECRET: value });
      await expectRefused(response, 503);
    }
  });

  it("makes verifyCsrf refuse every request", async () => {
    const who = { kind: "user", email: env.ALLOWED_EMAIL, iat: 1_790_000_000 };
    const { token } = await issueCsrf(who, env);
    expect(await verifyCsrf(write(token), who, env)).toBe(true);
    for (const value of [undefined, ""]) {
      const without = { ...env, CSRF_SECRET: value };
      expect(await issueCsrf(who, without)).toBe(null);
      expect(await verifyCsrf(write(token), who, without)).toBe(false);
    }
  });
});
