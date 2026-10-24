// The decisions island (src/lotuspod/features/decisions/ts/islands/) on the
// comments store's signals, as the islands bundle holds them (islands.ts),
// mounted over a decision form as the renderer writes it
// (lotuspod.decisions), in happy-dom's DOM, against stubbed answers and
// archive routes.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Page } from "../src/lotuspod/features/comments/ts/index";
import { islands } from "./islands";

const { answerStore, decisions, store } = await islands();

const GLOBALS = ["window", "document", "Node", "Element", "HTMLElement", "HTMLFormElement", "HTMLInputElement",
  "HTMLTextAreaElement", "HTMLButtonElement", "HTMLDetailsElement", "Event", "CustomEvent", "SubmitEvent"] as const;
const realFetch = globalThis.fetch;
let window: Window;

beforeAll(() => {
  window = new Window({ url: "https://pond.test/pond.html" });
  for (const name of GLOBALS) {
    Object.defineProperty(globalThis, name, { value: name === "window" ? window : window[name], configurable: true, writable: true });
  }
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const name of GLOBALS) {
    delete (globalThis as Record<string, unknown>)[name];
  }
  await window.happyDOM.close();
});

// A decision with three options, b its default, as _form() in
// lotuspod/features/decisions/decisions.py writes it.
const FORM = `<form class="artifact-decision" data-page="pond" data-question="decision-1" data-version="v1" data-default="b">
<fieldset>
<legend class="artifact-decision-question"><span class="artifact-decision-number">1</span> <span class="artifact-decision-text">Which pump?</span></legend>
<div class="artifact-decision-options">
<label class="artifact-decision-option"><input type="radio" name="choice" value="a" required> <span class="artifact-decision-label">Small pump</span></label>
<label class="artifact-decision-option"><input type="radio" name="choice" value="b" required> <span class="artifact-decision-label">Solar pump</span></label>
<label class="artifact-decision-option"><input type="radio" name="choice" value="c" required> <span class="artifact-decision-label">Mains pump</span></label>
</div>
<div class="artifact-decision-foot">
<details class="artifact-decision-note"><summary>Add a note</summary><textarea name="note" rows="2" maxlength="4000" aria-label="Note"></textarea></details>
<button type="submit">Save answer</button>
<span class="artifact-decision-unsaved" hidden>Not saved</span>
<span class="artifact-decision-hint">Not answered yet</span>
<p class="artifact-decision-status" role="status"></p>
</div>
</fieldset>
</form>`;

// What the island reaches the page script by (comments/ts/islands/bridge.ts).
function stubPage(): Page {
  return {
    all: (selector: string, node?: HTMLElement) => Array.from((node || document).querySelectorAll(selector)),
    element(tag: string, className: string, text?: string) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    },
    json: async (response: Response) => {
      try {
        return await response.json();
      } catch {
        return null;
      }
    },
    when: (stamp: string | undefined) => (stamp ? stamp.slice(0, 10) : ""),
    reader: (row: { actor?: { name?: string } } | null) => row?.actor?.name || "someone",
    foldSection() {},
    foldedAnswered: 0,
    answersURL: "/api/answers",
    stale: "This question has changed since the page loaded. Reload it.",
    signedOut: "You are signed out. Reload the page to sign in.",
    noQuestion: "Write your question in the note, then press Ask.",
    archived: false,
    holdSwap() {},
    events: { answered: "lotuspod:answered", saved: "lotuspod:saved", drawn: "lotuspod:drawn", swapped: "lotuspod:swapped" },
  } as unknown as Page;
}

const ana = { kind: "reader", handle: "ana", name: "Ana" };
const answer = (id: number, choice: string) =>
  ({ id, question: "decision-1", version: "v1", choice, note: "", createdAt: "2026-10-2" + id + "T09:00:00Z", actor: ana });

// The answers route answering each read with the next of reads; the archive
// route says the reader is no owner.
function routes(...reads: object[]): void {
  globalThis.fetch = (async (url: string) => {
    if (url.startsWith("/api/archive")) return new Response("", { status: 403 });
    if (url === "/api/answers?page=pond") return Response.json(reads.shift());
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
}

// The island mounted over a fresh page holding FORM, once its first read
// of the answers is drawn.
async function mounted(page: Page): Promise<HTMLFormElement> {
  document.body.innerHTML = `<section class="artifact-body"><h2 id="decisions">Decisions</h2>
<div class="artifact-section-body" data-section="decisions">${FORM}</div></section>`;
  const answered = new Promise((done) => document.addEventListener("lotuspod:answered", done, { once: true }));
  expect(decisions(page)).not.toBeNull();
  await answered;
  return document.querySelector<HTMLFormElement>("form.artifact-decision")!;
}

// Each DOM event fired on the form, or in it, by its type.
function heard(form: HTMLFormElement): string[] {
  const types = ["input", "change", "submit", "reset", "click", "focus", "focusin", "blur", "invalid",
    "lotuspod:saved", "lotuspod:answered"];
  const fired: string[] = [];
  for (const type of types) form.addEventListener(type, () => fired.push(type), { capture: true });
  return fired;
}

const savedLine = (form: HTMLFormElement) =>
  form.querySelector(".artifact-decision-saved-line")!.textContent!.replace(/\s+/g, " ").trim();
const picked = (form: HTMLFormElement) =>
  form.querySelector<HTMLInputElement>('input[name="choice"]:checked')?.value ?? null;

test("the store's answer for the question moving from b to c shows c as saved, with no event fired on the form", async () => {
  const page = stubPage();
  routes({ questions: { "decision-1": { current: answer(1, "b"), earlier: [] } } });
  const form = await mounted(page);
  expect(store.answer("decision-1").value.current?.choice).toBe("b");
  expect(form.classList.contains("artifact-decision--saved")).toBe(true);
  expect(savedLine(form)).toBe("✓ Saved · Solar pump · change");
  expect(picked(form)).toBe("b");

  const fired = heard(form);
  routes({ questions: { "decision-1": { current: answer(2, "c"), earlier: [answer(1, "b")] } } });
  expect(await answerStore(page).read("pond")).toBe(true);
  expect(store.answer("decision-1").value.current?.choice).toBe("c");

  expect(form.classList.contains("artifact-decision--saved")).toBe(true);
  expect(savedLine(form)).toBe("✓ Saved · Mains pump · change");
  expect(picked(form)).toBe("c");
  expect(form.querySelector<HTMLElement>(".artifact-decision-saved")!.hidden).toBe(false);
  expect(form.querySelector<HTMLElement>(".artifact-decision-options")!.hidden).toBe(true);
  expect(form.querySelector(".artifact-decision-history summary")!.textContent).toBe("1 earlier answer");
  expect(document.querySelector(".artifact-answered tbody tr .artifact-answered-choice strong")!.textContent)
    .toBe("Mains pump");
  expect(fired).toEqual([]);
});

test("a pick the reader changed and has not saved stays open as they left it when the store's answer changes", async () => {
  const page = stubPage();
  routes({ questions: { "decision-1": { current: answer(1, "b"), earlier: [] } } });
  const form = await mounted(page);
  form.querySelector<HTMLButtonElement>(".artifact-decision-saved .artifact-decision-change")!.click();
  form.querySelector<HTMLInputElement>('input[value="a"]')!.checked = true;
  form.dispatchEvent(new Event("change", { bubbles: true }));
  expect(form.classList.contains("artifact-decision--dirty")).toBe(true);

  routes({ questions: { "decision-1": { current: answer(2, "c"), earlier: [answer(1, "b")] } } });
  await answerStore(page).read("pond");
  expect(form.classList.contains("artifact-decision--saved")).toBe(false);
  expect(picked(form)).toBe("a");
  expect(form.querySelector<HTMLElement>(".artifact-decision-unsaved")!.hidden).toBe(false);
});
