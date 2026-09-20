import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { submitResponse } from "../../src/lotuspod/_theme/lotuspod-form.js";
import definitions from "./fixtures/assets/_lotuspod/forms.json";

// The page script driven against the real routes: what it resolves to is
// held against what D1 holds.

const ORIGIN = "https://pages.example.com";
const ISSUER = `https://${env.ACCESS_TEAM_DOMAIN}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const IAT = Math.floor(Date.now() / 1000) - 10;
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

// What the form would read from the page: two choices and a note.
function payload(extra = {}) {
  return {
    page: "some-page",
    question: "next-step",
    version: CURRENT,
    selected: ["ship", "revise"],
    note: "Ship it, then <b>revise</b> the intro.",
    ...extra,
  };
}

// A fetch as the browser would perform it from the maintainer's page: the
// script's own method, headers and body, plus what the browser and Access
// add. With no token it is a browser Access has not signed in. Every call
// is recorded as the script made it.
function boundFetch(token, calls = []) {
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input, init });
    const headers = new Headers(init.headers);
    if (token) headers.set("Cf-Access-Jwt-Assertion", token);
    if (init.method === "POST") headers.set("Origin", ORIGIN);
    headers.set("Sec-Fetch-Site", "same-origin");
    const request = new Request(new URL(input, ORIGIN), {
      method: init.method,
      headers,
      body: init.body,
    });
    return worker.fetch(request, env);
  };
  return fetchImpl;
}

async function rows() {
  const { results } = await env.DB.prepare("SELECT * FROM responses ORDER BY rowid").all();
  return results;
}

let signer;
let userToken;

beforeAll(async () => {
  signer = await generateSigner("fixture-key-1");
  userToken = await sign({
    iss: ISSUER,
    aud: [env.ACCESS_AUD],
    iat: IAT,
    exp: IAT + 300,
    email: env.ALLOWED_EMAIL,
    sub: "fixture-user",
    type: "app",
  });
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

describe("submitResponse", () => {
  it("resolves as saved with the stored id and time once the row exists", async () => {
    const calls = [];
    const state = {};
    const result = await submitResponse(boundFetch(userToken, calls), payload(), state);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(result).toEqual({ status: "saved", id: stored[0].id, createdAt: stored[0].createdAt });
    expect(stored[0]).toMatchObject({
      page: "some-page",
      question: "next-step",
      version: CURRENT,
      selected: JSON.stringify(["ship", "revise"]),
      note: payload().note,
      actor: env.ALLOWED_EMAIL,
    });
    expect(stored[0].idempotencyKey).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

    expect(calls.map((call) => [call.input, call.init.method ?? "GET"])).toEqual([
      ["/api/session", "GET"],
      ["/api/responses", "POST"],
    ]);
    expect(calls[0].init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    // A save spends the key: the next answer is a new submission.
    expect(state.idempotencyKey).toBe(null);
  });

  it("retries a dropped response with the same key and never stores a second row", async () => {
    const calls = [];
    const inner = boundFetch(userToken, calls);
    let dropped = 0;
    // The Worker handles the first POST in full; its response never arrives.
    const dropping = async (input, init) => {
      const response = await inner(input, init);
      if (init?.method === "POST" && dropped === 0) {
        dropped += 1;
        expect(response.status).toBe(201);
        throw new TypeError("network connection lost");
      }
      return response;
    };
    const state = {};

    const first = await submitResponse(dropping, payload(), state);
    expect(first.status).toBe("failed");
    expect(first.message).toEqual(expect.any(String));
    expect(dropped).toBe(1);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(state.idempotencyKey).toBe(stored[0].idempotencyKey);

    const second = await submitResponse(dropping, payload(), state);
    expect(second).toEqual({ status: "saved", id: stored[0].id, createdAt: stored[0].createdAt });
    expect(await rows()).toEqual(stored);

    const keys = calls
      .filter((call) => call.init.method === "POST")
      .map((call) => JSON.parse(call.init.body).idempotencyKey);
    expect(keys).toEqual([stored[0].idempotencyKey, stored[0].idempotencyKey]);
  });

  it("resolves as stale with the reload message when the page has changed", async () => {
    const result = await submitResponse(boundFetch(userToken), payload({ version: "0badc0de" }), {});
    expect(result.status).toBe("stale");
    expect(result.message).toMatch(/reload/i);
    expect(await rows()).toEqual([]);
  });

  it("resolves as signed_out when the session request answers 403", async () => {
    const calls = [];
    const result = await submitResponse(boundFetch(null, calls), payload(), {});
    expect(result.status).toBe("signed_out");
    expect(result.message).toEqual(expect.any(String));
    // Nothing was posted without a session.
    expect(calls.map((call) => call.input)).toEqual(["/api/session"]);
    expect(await rows()).toEqual([]);
  });
});
