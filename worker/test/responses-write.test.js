import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { issueCsrf } from "../src/csrf.js";
import worker from "../src/index.js";
import definitions from "./fixtures/assets/_lotuspod/forms.json";

const ORIGIN = "https://pages.example.com";
const ISSUER = `https://${env.ACCESS_TEAM_DOMAIN}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const IAT = Math.floor(Date.now() / 1000) - 10;
const KEY = "retry-key-0123456789";
const OTHER_KEY = "another-key-0123456789";
const CURRENT = definitions["some-page"]["next-step"].version;

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
  return { iss: ISSUER, aud: [env.ACCESS_AUD], iat: IAT, exp: IAT + 300, ...extra };
}

// A submission the fixture definitions accept, unless overridden.
function submission(extra = {}) {
  return {
    idempotencyKey: KEY,
    page: "some-page",
    question: "next-step",
    version: CURRENT,
    selected: ["ship", "revise"],
    note: "Ship it, then <b>revise</b> the intro; DROP TABLE responses;--",
    ...extra,
  };
}

// The POST as the maintainer's own page would send it, unless overridden.
// A null header value leaves that header out.
function post(body, headers = {}) {
  const all = {
    "Cf-Access-Jwt-Assertion": userToken,
    "Content-Type": "application/json",
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "X-Lotuspod-Csrf": csrf,
    ...headers,
  };
  const present = Object.entries(all).filter(([, value]) => value !== null);
  return new Request(`${ORIGIN}/api/responses`, {
    method: "POST",
    headers: Object.fromEntries(present),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rows() {
  const { results } = await env.DB.prepare("SELECT * FROM responses ORDER BY rowid").all();
  return results;
}

async function expectError(response, status, error) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  if (error) expect(await response.json()).toEqual({ error });
}

let signer;
let userToken;
let machineToken;
let csrf;

beforeAll(async () => {
  signer = await generateSigner("fixture-key-1");
  userToken = await sign(baseClaims({ email: env.ALLOWED_EMAIL, sub: "fixture-user", type: "app" }));
  machineToken = await sign(baseClaims({ common_name: env.MACHINE_CLIENT_ID, sub: "", type: "app" }));
  csrf = (await issueCsrf({ kind: "user", email: env.ALLOWED_EMAIL, iat: IAT }, env)).token;
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM responses").run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== CERTS_URL) throw new Error(`unexpected fetch of ${url}`);
    return Response.json({ keys: [signer.jwk] });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/responses", () => {
  it("stores the maintainer's choices and note as one row", async () => {
    const before = Date.now();
    const response = await worker.fetch(post(submission()), env);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["createdAt", "id"]);
    expect(body.id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    const stored = await rows();
    expect(stored).toEqual([
      {
        id: body.id,
        idempotencyKey: KEY,
        page: "some-page",
        question: "next-step",
        version: CURRENT,
        selected: JSON.stringify(["ship", "revise"]),
        note: submission().note,
        actor: env.ALLOWED_EMAIL,
        createdAt: body.createdAt,
        supersedes: null,
        ackedAt: null,
        ackedBy: null,
      },
    ]);
    const createdAt = Date.parse(stored[0].createdAt);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });

  it("never takes the id, actor or timestamp from the client", async () => {
    const extra = { id: "chosen-by-client", actor: "someone-else@example.org", createdAt: "2000-01-01T00:00:00.000Z" };
    await expectError(await worker.fetch(post(submission(extra)), env), 400, "invalid_body");
    expect(await rows()).toEqual([]);
  });

  it("stores a submission with no note and no choices ticked", async () => {
    const { note, ...body } = submission({ selected: [] });
    expect((await worker.fetch(post(body), env)).status).toBe(201);
    const [row] = await rows();
    expect(row.selected).toBe("[]");
    expect(row.note).toBe(null);
  });
});

describe("a stored response", () => {
  let first;

  beforeEach(async () => {
    const response = await worker.fetch(post(submission()), env);
    expect(response.status).toBe(201);
    first = await response.json();
  });

  it("answers a retry with the same key and body from the original row", async () => {
    const stored = await rows();
    const response = await worker.fetch(post(submission()), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(first);
    // The same boxes ticked in another order are the same answer.
    const reordered = await worker.fetch(post(submission({ selected: ["revise", "ship"] })), env);
    expect(reordered.status).toBe(200);
    expect(await rows()).toEqual(stored);
  });

  it("refuses the same key with different choices and leaves the row unchanged", async () => {
    const stored = await rows();
    const response = await worker.fetch(post(submission({ selected: ["drop"] })), env);
    await expectError(response, 409, "idempotency_conflict");
    const noted = await worker.fetch(post(submission({ note: "another note" })), env);
    await expectError(noted, 409, "idempotency_conflict");
    expect(await rows()).toEqual(stored);
  });

  it("stores a new key's answer to the same question as superseding the first", async () => {
    const response = await worker.fetch(post(submission({ idempotencyKey: OTHER_KEY, selected: ["drop"] })), env);
    expect(response.status).toBe(201);
    const second = await response.json();
    expect(second.id).not.toBe(first.id);
    const stored = await rows();
    expect(stored.map((row) => [row.id, row.supersedes])).toEqual([
      [first.id, null],
      [second.id, first.id],
    ]);
    expect(stored[1].selected).toBe(JSON.stringify(["drop"]));
  });
});

describe("a submission that fails validation", () => {
  afterEach(async () => {
    expect(await rows()).toEqual([]);
  });

  it("is refused as stale when its version is not the current one", async () => {
    await expectError(await worker.fetch(post(submission({ version: "0badc0de" })), env), 409, "stale_page");
  });

  it("gets 404 for an unknown page or question", async () => {
    for (const extra of [{ page: "no-such-page" }, { question: "no-such-question" }, { page: "__proto__" }, { question: "constructor" }]) {
      await expectError(await worker.fetch(post(submission(extra)), env), 404, "unknown_question");
    }
  });

  it("gets 400 for a choice the question does not allow", async () => {
    await expectError(await worker.fetch(post(submission({ selected: ["ship", "burn"] })), env), 400, "invalid_choice");
  });

  it("gets 400 for a note over 4000 characters", async () => {
    await expectError(await worker.fetch(post(submission({ note: "n".repeat(4001) })), env), 400, "invalid_body");
  });

  it("gets 400 for a body over 16 KiB", async () => {
    // Valid in every other respect: only its size refuses it.
    const padded = JSON.stringify(submission()).replace(/^\{/, `{${" ".repeat(16 * 1024)}`);
    expect(JSON.parse(padded)).toEqual(submission());
    await expectError(await worker.fetch(post(padded), env), 400, "body_too_large");
  });

  it("gets 400 for a content type other than JSON", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const response = await worker.fetch(post(submission(), { "Content-Type": type }), env);
      await expectError(response, 400, type === null ? undefined : "invalid_content_type");
    }
  });

  it("gets 400 for a malformed idempotency key", async () => {
    for (const idempotencyKey of ["too-short", "k".repeat(65), "spaces are not allowed", 1234567890123456, undefined]) {
      await expectError(await worker.fetch(post(submission({ idempotencyKey })), env), 400, "invalid_body");
    }
  });

  it("gets 400 for a body that is not the expected shape", async () => {
    for (const body of ["{not json", "[]", "null", JSON.stringify(submission({ selected: "ship" })), JSON.stringify(submission({ selected: ["ship", "ship"] }))]) {
      await expectError(await worker.fetch(post(body), env), 400, "invalid_body");
    }
  });
});

describe("a submission that fails the gate", () => {
  async function expectRefused(response) {
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(await rows()).toEqual([]);
  }

  it("is refused with no request token", async () => {
    await expectRefused(await worker.fetch(post(submission(), { "X-Lotuspod-Csrf": null }), env));
  });

  it("is refused with a token that fails verifyCsrf", async () => {
    const other = await issueCsrf({ kind: "user", email: env.ALLOWED_EMAIL, iat: IAT - 1 }, env);
    await expectRefused(await worker.fetch(post(submission(), { "X-Lotuspod-Csrf": other.token }), env));
    const elsewhere = { Origin: "https://elsewhere.example.net", "Sec-Fetch-Site": "cross-site" };
    await expectRefused(await worker.fetch(post(submission(), elsewhere), env));
  });

  it("is refused for the machine identity", async () => {
    await expectRefused(await worker.fetch(post(submission(), { "Cf-Access-Jwt-Assertion": machineToken }), env));
  });

  it("is refused with no identity", async () => {
    await expectRefused(await worker.fetch(post(submission(), { "Cf-Access-Jwt-Assertion": null }), env));
  });
});

describe("the definitions file", () => {
  it("is never served, whichever identity asks", async () => {
    for (const token of [userToken, machineToken]) {
      const headers = { "Cf-Access-Jwt-Assertion": token };
      const response = await worker.fetch(new Request(`${ORIGIN}/_lotuspod/forms.json`, { headers }), env);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    // Nobody at all is refused before any path is looked at.
    const response = await worker.fetch(new Request(`${ORIGIN}/_lotuspod/forms.json`), env);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("when absent from the assets, makes a valid submission a 404", async () => {
    const assets = { fetch: vi.fn(async () => new Response(null, { status: 404 })) };
    const response = await worker.fetch(post(submission()), { ...env, ASSETS: assets });
    await expectError(response, 404, "unknown_question");
    expect(new URL(assets.fetch.mock.calls[0][0]).pathname).toBe("/_lotuspod/forms.json");
    expect(await rows()).toEqual([]);
  });
});
