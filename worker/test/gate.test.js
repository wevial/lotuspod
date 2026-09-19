import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import worker from "../src/index.js";
import indexHtml from "./fixtures/assets/index.html?raw";
import somePageHtml from "./fixtures/assets/some-page.html?raw";

const TEAM_DOMAIN = env.ACCESS_TEAM_DOMAIN;
const ISSUER = `https://${TEAM_DOMAIN}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

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

async function sign(signer, claims) {
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

function machineClaims(extra) {
  return baseClaims({ common_name: env.MACHINE_CLIENT_ID, sub: "", type: "app", ...extra });
}

function request(path, token, init = {}) {
  const headers = token ? { "Cf-Access-Jwt-Assertion": token } : {};
  return new Request(`https://pages.example.com${path}`, { ...init, headers });
}

let signer;
let stranger;
let certsFetch;

beforeAll(async () => {
  signer = await generateSigner("fixture-key-1");
  // Same key id, different key: only the signature can tell them apart.
  stranger = await generateSigner("fixture-key-1");
});

beforeEach(() => {
  certsFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CERTS_URL) throw new Error(`unexpected fetch of ${url}`);
    return Response.json({ keys: [signer.jwk] });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectRefused(response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");
}

describe("the verified maintainer", () => {
  it("is served the index at /", async () => {
    const response = await worker.fetch(request("/", await sign(signer, userClaims())), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(indexHtml);
  });

  it("is served a page", async () => {
    const token = await sign(signer, userClaims());
    const response = await worker.fetch(request("/some-page.html", token), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(somePageHtml);
  });

  it("is matched by email without regard to case", async () => {
    const token = await sign(signer, userClaims({ email: env.ALLOWED_EMAIL.toUpperCase() }));
    const response = await worker.fetch(request("/", token), env);
    expect(response.status).toBe(200);
  });

  it("may not POST to a page", async () => {
    const token = await sign(signer, userClaims());
    const response = await worker.fetch(
      request("/some-page.html", token, { method: "POST", body: "x" }),
      env,
    );
    expect(response.status).toBe(405);
    expect(await response.text()).toBe("");
  });

  it("gets 404 for an unknown /api/ path without the assets binding being consulted", async () => {
    const assets = { fetch: vi.fn(env.ASSETS.fetch.bind(env.ASSETS)) };
    const token = await sign(signer, userClaims());
    const response = await worker.fetch(request("/api/unknown", token), { ...env, ASSETS: assets });
    expect(response.status).toBe(404);
    expect(assets.fetch).not.toHaveBeenCalled();
    // The spy does see a granted request, so its silence above means something.
    await worker.fetch(request("/", token), { ...env, ASSETS: assets });
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });

  it("gets 404 under /_lotuspod/, however the path is spelled", async () => {
    const assets = { fetch: vi.fn() };
    const token = await sign(signer, userClaims());
    for (const path of ["/_lotuspod/state.json", "/_lotuspod/", "/%5Flotuspod/state.json", "//_lotuspod/x"]) {
      const response = await worker.fetch(request(path, token), { ...env, ASSETS: assets });
      expect(response.status, path).toBe(404);
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

describe("everyone else", () => {
  const paths = ["/", "/some-page.html", "/api/unknown", "/_lotuspod/state.json"];

  async function expectRefusedEverywhere(token) {
    const assets = { fetch: vi.fn() };
    for (const path of paths) {
      await expectRefused(await worker.fetch(request(path, token), { ...env, ASSETS: assets }));
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  }

  it("is refused with no token", async () => {
    await expectRefusedEverywhere(null);
  });

  it("is refused with a token signed by a different key", async () => {
    await expectRefusedEverywhere(await sign(stranger, userClaims()));
  });

  it("is refused with an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    await expectRefusedEverywhere(await sign(signer, userClaims({ exp: past })));
  });

  it("is refused with a wrong audience", async () => {
    await expectRefusedEverywhere(await sign(signer, userClaims({ aud: ["another-audience-tag"] })));
  });

  it("is refused with a wrong issuer", async () => {
    await expectRefusedEverywhere(
      await sign(signer, userClaims({ iss: "https://other-team.example.com" })),
    );
  });

  it("is refused with an email one character or only a domain away", async () => {
    await expectRefusedEverywhere(await sign(signer, userClaims({ email: "maintainor@example.org" })));
    await expectRefusedEverywhere(await sign(signer, userClaims({ email: "maintainer@example.net" })));
  });

  it("is refused with a genuine token that names nobody", async () => {
    await expectRefusedEverywhere(await sign(signer, baseClaims({ sub: "fixture-user" })));
    await expectRefusedEverywhere(await sign(signer, machineClaims({ common_name: "other.access" })));
  });

  it("is refused with an unknown key id after the key set is refetched once", async () => {
    const unknown = await generateSigner("fixture-key-unknown");
    const token = await sign(unknown, userClaims());
    await worker.fetch(request("/", await sign(signer, userClaims())), env);
    const before = certsFetch.mock.calls.length;
    await expectRefused(await worker.fetch(request("/", token), env));
    expect(certsFetch.mock.calls.length).toBe(before + 1);
  });
});

describe("the machine identity", () => {
  it("is recognized but allowed no page", async () => {
    const token = await sign(signer, machineClaims());
    for (const path of ["/", "/some-page.html"]) {
      await expectRefused(await worker.fetch(request(path, token), env));
    }
  });
});

describe("a missing setting", () => {
  for (const name of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ALLOWED_EMAIL"]) {
    it(`${name} refuses an otherwise valid token`, async () => {
      const token = await sign(signer, userClaims());
      expect((await worker.fetch(request("/", token), env)).status).toBe(200);
      for (const value of [undefined, ""]) {
        await expectRefused(await worker.fetch(request("/", token), { ...env, [name]: value }));
      }
    });
  }
});

describe("wrangler.toml", () => {
  const config = inject("wranglerConfig");
  const text = inject("wranglerConfigText");

  it("closes the side doors and runs the Worker first", () => {
    expect(config.name).toBe("lotuspod");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.assets).toEqual({
      directory: "../publish",
      binding: "ASSETS",
      run_worker_first: true,
    });
  });

  it("holds no account id, database id, route, hostname or environment", () => {
    expect(Object.keys(config).sort()).toEqual(
      ["assets", "compatibility_date", "main", "name", "preview_urls", "workers_dev"].sort(),
    );
    // Nothing shaped like an id or a hostname in any value, settings included.
    const values = text.replace(/#.*$/gm, "");
    expect(values).not.toMatch(/[0-9a-f]{32}/i);
    expect(values).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(values).not.toMatch(/[a-z0-9-]+\.(com|org|net|dev|app|io)\b/i);
    expect(values).not.toMatch(/@/);
  });
});
