// The write half of the answer channel: one immutable D1 row per deliberate
// submission by the verified maintainer, to a question as it currently
// reads. The note is data: stored as given and never interpreted here.

const DEFINITIONS_PATH = "/_lotuspod/forms.json";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NOTE_LENGTH = 4000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const FIELDS = ["idempotencyKey", "page", "question", "version", "selected", "note"];

function answer(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function isJson(request) {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

// The body's bytes, or null once it proves larger than the limit.
async function readLimited(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isText(value) {
  return typeof value === "string" && value !== "";
}

// The submission if the body has exactly the expected shape, else null.
function parseSubmission(bytes) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !FIELDS.includes(key))) return null;
  const { idempotencyKey, page, question, version, selected } = body;
  const note = body.note ?? null;
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) return null;
  if (!isText(page) || !isText(question) || !isText(version)) return null;
  if (!Array.isArray(selected) || !selected.every(isText)) return null;
  if (new Set(selected).size !== selected.length) return null;
  if (note !== null && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) return null;
  return { idempotencyKey, page, question, version, selected, note };
}

// The definitions that ship with the exported site, read afresh each time:
// a stale copy would defeat the version check. Null when absent or unusable.
async function readDefinitions(request, env) {
  try {
    const response = await env.ASSETS.fetch(new URL(DEFINITIONS_PATH, request.url));
    if (response.status !== 200) return null;
    const definitions = await response.json();
    return definitions !== null && typeof definitions === "object" ? definitions : null;
  } catch {
    return null;
  }
}

function findQuestion(definitions, page, question) {
  if (!Object.hasOwn(definitions, page)) return null;
  const questions = definitions[page];
  if (questions === null || typeof questions !== "object") return null;
  if (!Object.hasOwn(questions, question)) return null;
  const found = questions[question];
  if (found === null || typeof found !== "object") return null;
  return typeof found.version === "string" && Array.isArray(found.choices) ? found : null;
}

function findByKey(env, idempotencyKey) {
  return env.DB.prepare(
    "SELECT id, page, question, version, selected, note, actor, createdAt FROM responses WHERE idempotencyKey = ?",
  )
    .bind(idempotencyKey)
    .first();
}

// A retry is the stored submission again: the same answer in every respect,
// the choices compared as a set.
function isSameSubmission(row, submission, actor) {
  let stored;
  try {
    stored = JSON.parse(row.selected);
  } catch {
    return false;
  }
  return (
    row.page === submission.page &&
    row.question === submission.question &&
    row.version === submission.version &&
    row.note === submission.note &&
    row.actor === actor &&
    Array.isArray(stored) &&
    JSON.stringify([...stored].sort()) === JSON.stringify([...submission.selected].sort())
  );
}

function replay(row, submission, actor) {
  if (!isSameSubmission(row, submission, actor)) return answer(409, { error: "idempotency_conflict" });
  return answer(200, { id: row.id, createdAt: row.createdAt });
}

// POST /api/responses, for a maintainer the route and verifyCsrf have
// already passed. Nothing is written until every check has held, and the
// browser hears "saved" only after D1 has the row.
export async function storeResponse(request, who, env) {
  if (!isJson(request)) return answer(400, { error: "invalid_content_type" });
  const bytes = await readLimited(request);
  if (!bytes) return answer(400, { error: "body_too_large" });
  const submission = parseSubmission(bytes);
  if (!submission) return answer(400, { error: "invalid_body" });

  // A retry of a stored submission is answered from its row, even if the
  // page has moved on since.
  const earlier = await findByKey(env, submission.idempotencyKey);
  if (earlier) return replay(earlier, submission, who.email);

  const definitions = await readDefinitions(request, env);
  const asked = definitions && findQuestion(definitions, submission.page, submission.question);
  if (!asked) return answer(404, { error: "unknown_question" });
  if (asked.version !== submission.version) return answer(409, { error: "stale_page" });
  if (!submission.selected.every((choice) => asked.choices.includes(choice))) {
    return answer(400, { error: "invalid_choice" });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // Stored in the question's own order, whatever order the boxes arrived in.
  const selected = JSON.stringify(asked.choices.filter((choice) => submission.selected.includes(choice)));
  const inserted = await env.DB.prepare(
    `INSERT INTO responses (id, idempotencyKey, page, question, version, selected, note, actor, createdAt, supersedes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       (SELECT id FROM responses WHERE actor = ?8 AND page = ?3 AND question = ?4 ORDER BY rowid DESC LIMIT 1))
     ON CONFLICT (idempotencyKey) DO NOTHING`,
  )
    .bind(
      id,
      submission.idempotencyKey,
      submission.page,
      submission.question,
      submission.version,
      selected,
      submission.note,
      who.email,
      createdAt,
    )
    .run();
  if (inserted.meta.changes === 1) return answer(201, { id, createdAt });

  // The same key landed first in a concurrent request.
  const winner = await findByKey(env, submission.idempotencyKey);
  if (!winner) return answer(500, { error: "not_saved" });
  return replay(winner, submission, who.email);
}
