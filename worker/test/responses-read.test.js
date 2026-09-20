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

// A stored row, written straight to D1 so the tests choose its timestamp.
async function store(id, createdAt, extra = {}) {
  const row = {
    id,
    idempotencyKey: `stored-key-${id}`,
    page: "some-page",
    question: "next-step",
    version: CURRENT,
    selected: JSON.stringify(["ship", "revise"]),
    note: "Ship it, then <b>revise</b> the intro; DROP TABLE responses;--",
    actor: env.ALLOWED_EMAIL,
    createdAt,
    ackedAt: null,
    ackedBy: null,
    ...extra,
  };
  const names = Object.keys(row);
  await env.DB.prepare(`INSERT INTO responses (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
  return row;
}

// The row as the list returns it.
function listed(row) {
  const { id, page, question, version, note, actor, createdAt } = row;
  return { id, page, question, version, selected: JSON.parse(row.selected), note, actor, createdAt };
}

// A null token leaves the Access header out.
function as(token, path, init = {}) {
  const headers = token === null ? {} : { "Cf-Access-Jwt-Assertion": token };
  return new Request(`${ORIGIN}${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

function list(query = "?status=pending", token = machineToken) {
  return worker.fetch(as(token, `/api/responses${query}`), env);
}

function ack(id, token = machineToken) {
  return worker.fetch(as(token, `/api/responses/${id}/ack`, { method: "POST" }), env);
}

async function rows() {
  const { results } = await env.DB.prepare("SELECT * FROM responses ORDER BY rowid").all();
  return results;
}

async function expectError(response, status, error) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error });
}

async function expectRefused(response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");
}

let signer;
let userToken;
let machineToken;
let otherMachineToken;
let csrf;

beforeAll(async () => {
  signer = await generateSigner("fixture-key-1");
  userToken = await sign(baseClaims({ email: env.ALLOWED_EMAIL, sub: "fixture-user", type: "app" }));
  machineToken = await sign(baseClaims({ common_name: env.MACHINE_CLIENT_ID, sub: "", type: "app" }));
  otherMachineToken = await sign(baseClaims({ common_name: "other.access", sub: "", type: "app" }));
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

describe("GET /api/responses?status=pending", () => {
  it("lists the rows not yet acknowledged, in submission order", async () => {
    // Stored out of order, so the order returned is the query's own.
    const second = await store("bbbb", "2026-09-02T00:00:00.000Z", { note: null, selected: "[]" });
    await store("cccc", "2026-09-01T12:00:00.000Z", {
      ackedAt: "2026-09-03T00:00:00.000Z",
      ackedBy: env.MACHINE_CLIENT_ID,
    });
    const first = await store("aaaa", "2026-09-01T00:00:00.000Z");
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ responses: [listed(first), listed(second)] });
  });

  it("returns the note as the string it was stored as", async () => {
    const row = await store("aaaa", "2026-09-01T00:00:00.000Z");
    const { responses } = await (await list()).json();
    expect(responses[0].note).toBe(row.note);
  });

  it("answers an empty list when nothing is pending", async () => {
    expect(await (await list()).json()).toEqual({ responses: [] });
  });

  it("pages through every row exactly once, in order, by the next cursor", async () => {
    // Three rows share a timestamp: the cursor must tell them apart by id.
    const stored = [
      await store("id-1", "2026-09-01T00:00:00.000Z"),
      await store("id-3", "2026-09-02T00:00:00.000Z"),
      await store("id-2", "2026-09-02T00:00:00.000Z"),
      await store("id-4", "2026-09-02T00:00:00.000Z"),
      await store("id-5", "2026-09-03T00:00:00.000Z"),
    ];
    const pages = [];
    let query = "?status=pending&limit=2";
    for (;;) {
      const response = await list(query);
      expect(response.status).toBe(200);
      const body = await response.json();
      pages.push(body.responses.map((row) => row.id));
      if (!("next" in body)) break;
      expect(body.next).toMatch(/^[A-Za-z0-9_-]+$/);
      query = `?status=pending&limit=2&after=${body.next}`;
    }
    expect(pages).toEqual([["id-1", "id-2"], ["id-3", "id-4"], ["id-5"]]);
    expect(stored.length).toBe(pages.flat().length);
  });

  it("caps the limit at 100", async () => {
    const statements = [];
    for (let n = 0; n < 101; n += 1) {
      const id = `id-${String(n).padStart(3, "0")}`;
      statements.push(
        env.DB.prepare(
          "INSERT INTO responses (id, idempotencyKey, page, question, version, selected, actor, createdAt) VALUES (?, ?, 'p', 'q', 'v', '[]', 'a', '2026-09-01T00:00:00.000Z')",
        ).bind(id, `stored-key-${id}`),
      );
    }
    await env.DB.batch(statements);
    for (const query of ["?status=pending", "?status=pending&limit=5000"]) {
      const body = await (await list(query)).json();
      expect(body.responses.length).toBe(100);
      const rest = await (await list(`?status=pending&after=${body.next}`)).json();
      expect(rest.responses.map((row) => row.id)).toEqual(["id-100"]);
      expect("next" in rest).toBe(false);
    }
  });

  it("refuses any status but pending", async () => {
    for (const query of ["", "?status=acked", "?status=", "?status=PENDING"]) {
      await expectError(await list(query), 400, "invalid_status");
    }
  });

  it("refuses a limit that is not a count", async () => {
    for (const limit of ["0", "-1", "two", "1.5", ""]) {
      await expectError(await list(`?status=pending&limit=${limit}`), 400, "invalid_limit");
    }
  });

  it("refuses a cursor it did not issue", async () => {
    for (const after of ["", "not*base64", "bm90LWpzb24", encodeJson({ createdAt: "x" }), encodeJson(["only-one"])]) {
      await expectError(await list(`?status=pending&after=${after}`), 400, "invalid_cursor");
    }
  });
});

describe("POST /api/responses/ID/ack", () => {
  it("records when and by whom, once, and the row stops listing as pending", async () => {
    await store("aaaa", "2026-09-01T00:00:00.000Z");
    const kept = await store("bbbb", "2026-09-02T00:00:00.000Z");
    const before = Date.now();
    const response = await ack("aaaa");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ id: "aaaa", ackedAt: body.ackedAt, ackedBy: env.MACHINE_CLIENT_ID });
    expect(Date.parse(body.ackedAt)).toBeGreaterThanOrEqual(before);
    expect(await (await list()).json()).toEqual({ responses: [listed(kept)] });

    // A retry, as after a crash, changes nothing and hears the same answer.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      const again = await ack("aaaa");
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(body);
    } finally {
      vi.useRealTimers();
    }
    const [acked, untouched] = await rows();
    expect(acked).toMatchObject({ id: "aaaa", ackedAt: body.ackedAt, ackedBy: env.MACHINE_CLIENT_ID });
    expect(untouched).toMatchObject({ id: "bbbb", ackedAt: null, ackedBy: null });
  });

  it("answers 404 for an id that does not exist", async () => {
    await store("aaaa", "2026-09-01T00:00:00.000Z");
    await expectError(await ack("no-such-id"), 404, "unknown_response");
    expect((await rows())[0]).toMatchObject({ ackedAt: null, ackedBy: null });
  });

  it("answers only to POST", async () => {
    await store("aaaa", "2026-09-01T00:00:00.000Z");
    const response = await worker.fetch(as(machineToken, "/api/responses/aaaa/ack"), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect((await rows())[0].ackedAt).toBe(null);
  });
});

describe("the machine's routes", () => {
  it("are refused to the maintainer, to nobody and to another service token", async () => {
    await store("aaaa", "2026-09-01T00:00:00.000Z");
    const before = await rows();
    for (const token of [userToken, null, otherMachineToken]) {
      await expectRefused(await list("?status=pending", token));
      await expectRefused(await ack("aaaa", token));
    }
    // The maintainer's request token opens nothing here either.
    const headers = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "X-Lotuspod-Csrf": csrf };
    await expectRefused(await worker.fetch(as(userToken, "/api/responses/aaaa/ack", { method: "POST", headers }), env));
    expect(await rows()).toEqual(before);
  });
});

describe("the machine identity", () => {
  it("cannot submit a response", async () => {
    const submission = {
      idempotencyKey: "machine-key-0123456789",
      page: "some-page",
      question: "next-step",
      version: CURRENT,
      selected: ["ship"],
      note: null,
    };
    const headers = {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-Lotuspod-Csrf": csrf,
    };
    const request = as(machineToken, "/api/responses", { method: "POST", headers, body: JSON.stringify(submission) });
    await expectRefused(await worker.fetch(request, env));
    expect(await rows()).toEqual([]);
  });

  it("cannot read a page or the session", async () => {
    for (const path of ["/", "/some-page.html", "/api/session"]) {
      await expectRefused(await worker.fetch(as(machineToken, path), env));
    }
  });
});
