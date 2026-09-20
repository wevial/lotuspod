// The response form's page script. It holds no credential: sign-in is
// Cloudflare Access's cookie, and the request token is fetched after sign-in,
// kept in memory for one submission and never written to storage. The page
// says "Saved" only once the Worker has confirmed the row is stored.
//
// No imports, so a browser loads this file as it is.

const SESSION_PATH = "/api/session";
const RESPONSES_PATH = "/api/responses";
const CSRF_HEADER = "X-Lotuspod-Csrf";

const MESSAGES = {
  stale: "This page has changed since it was loaded. Reload it and answer again.",
  signed_out: "You are signed out. Sign in again, then press Submit.",
  failed: "Not saved: the server could not be reached or refused the answer. Press Submit to try again.",
};

function outcome(status) {
  return { status, message: MESSAGES[status] };
}

// What the form currently says: the question it was rendered for, the ticked
// choices by name, and the note when one was written.
export function readForm(form) {
  const selected = [];
  for (const box of form.querySelectorAll('input[type="checkbox"]')) {
    if (box.checked) selected.push(box.name);
  }
  const payload = {
    page: form.dataset.page,
    question: form.dataset.question,
    version: form.dataset.version,
    selected,
  };
  const note = form.querySelector('textarea[name="note"]')?.value ?? "";
  if (note !== "") payload.note = note;
  return payload;
}

async function readJson(response) {
  try {
    const body = await response.json();
    return body !== null && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

// One attempt to store the payload: a session token, then the answer. The
// state object carries the idempotency key from one attempt to the next, so
// a retry of the same contents can never become a second row; the caller
// clears state.idempotencyKey when the contents change. Resolves to
// { status: "saved", id, createdAt } or { status, message } with status
// "stale", "signed_out" or "failed", and never rejects.
export async function submitResponse(fetchImpl, payload, state) {
  if (!state.idempotencyKey) state.idempotencyKey = crypto.randomUUID();
  try {
    const session = await fetchImpl(SESSION_PATH, {
      credentials: "same-origin",
      cache: "no-store",
      // An expired Access session answers with a redirect to its sign-in.
      redirect: "manual",
    });
    if (session.status === 403 || session.type === "opaqueredirect") return outcome("signed_out");
    if (!session.ok) return outcome("failed");
    const { csrf } = await readJson(session);
    if (typeof csrf !== "string" || csrf === "") return outcome("failed");

    const response = await fetchImpl(RESPONSES_PATH, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: csrf },
      body: JSON.stringify({ ...payload, idempotencyKey: state.idempotencyKey }),
    });
    if (response.status === 403 || response.type === "opaqueredirect") return outcome("signed_out");
    const body = await readJson(response);
    if (response.status === 409 && body.error === "stale_page") return outcome("stale");
    if (!response.ok || typeof body.id !== "string" || typeof body.createdAt !== "string") {
      return outcome("failed");
    }
    state.idempotencyKey = null;
    return { status: "saved", id: body.id, createdAt: body.createdAt };
  } catch {
    // The row may or may not exist: the kept key makes the retry safe.
    return outcome("failed");
  }
}

function savedText(createdAt) {
  const when = new Date(createdAt);
  return Number.isNaN(when.getTime()) ? "Saved" : `Saved ${when.toLocaleString()}`;
}

function wire(form) {
  const state = { idempotencyKey: null };
  const status = document.createElement("p");
  status.className = "artifact-form-status";
  status.setAttribute("role", "status");
  form.append(status);

  const setDisabled = (disabled) => {
    for (const control of form.elements) control.disabled = disabled;
  };
  // Different contents are a different answer, so they get a new key.
  const forgetKey = () => {
    state.idempotencyKey = null;
  };
  form.addEventListener("input", forgetKey);
  form.addEventListener("change", forgetKey);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Read before disabling: the payload is what the maintainer saw.
    const payload = readForm(form);
    setDisabled(true);
    status.textContent = "Saving…";
    const result = await submitResponse((input, init) => fetch(input, init), payload, state);
    if (result.status === "saved") {
      status.textContent = savedText(result.createdAt);
      return;
    }
    status.textContent = result.message;
    setDisabled(false);
  });
}

if (typeof document !== "undefined") {
  for (const form of document.querySelectorAll("form.artifact-form")) wire(form);
}
