// The review sheet over a page's decision cards (the decisions island), drawn
// once the page's answers are read, and again once each swap's read of
// them is (web/src/page-swap.ts sends ANSWERED after it). A form with a
// default (the form's data-default) and no stored answer gets its default
// picked, so it shows "Not saved": on a swap, only a form the swap brought
// in.
// A question is to answer while it has no stored answer at its version (a
// dismissal is one), a default picked for it included: every count of
// them, and Next open, ask the decisions island (Cards.toAnswer), as the
// comments panel's Decisions tab does.
// The title bar ends in "Next open: QUESTION ↓", which jumps to the next
// question to answer, and "N to answer" ("All answered" at none), which
// opens the comments panel's Decisions tab, or the bottom sheet's without
// room for the panel (decisionsTab.opens). A page whose answers could not
// be read gets no sheet, and nor does an archived one, which takes no
// answer.
// Each h2 whose section asks questions to answer, and its outline link, is
// marked "N open". The sheet draws from the forms and the stored answers on
// every change to them; Preact keeps only what is the sheet's own, the
// question Next open last jumped to, which a swap keeps.

import { createPortal, Fragment, render } from "preact";
import { useLayoutEffect, useReducer, useState } from "preact/hooks";
import { effect, untracked } from "@preact/signals";
import type { Cards } from "../../../decisions/ts/index";
import type { Page } from "./bridge";
import { decisionsTab } from "./comments/tabs";

interface Question {
  form: HTMLFormElement;
  // The nearest h2 before the form, null before the first.
  heading: HTMLElement | null;
  text: string;
  // The form's default when it names one of its options, else "".
  fallback: string;
}

// Where a section's "N open" marks are drawn: a container the island adds
// to its h2, and one to its outline link, if it has one; key tells them
// apart across draws.
interface Marks {
  heading: HTMLElement;
  link: HTMLElement | null;
  key: number;
}

function words(node: Element | null): string {
  return node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "";
}

function radioOf(form: HTMLFormElement, value: string): HTMLInputElement | null {
  return Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="choice"]'))
    .find((radio) => radio.value === value) ?? null;
}

function picked(form: HTMLFormElement): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>('input[name="choice"]:checked');
}

function opened(the: Cards, question: Question): boolean {
  return the.toAnswer(question.form);
}

// Tell the form a pick moved it, as the reader's own pick would.
function moved(input: HTMLInputElement): void {
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

interface SheetProps {
  page: Page;
  the: Cards;
  questions: Question[];
  marks: Map<HTMLElement, Marks>;
}

function Sheet({ page, the, questions, marks }: SheetProps) {
  // Each change to the forms or their answers draws the sheet again.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // The question Next open jumped to last, by its data-question, so a swap
  // adding or taking away one before it keeps the reader's place.
  const [last, setLast] = useState("");
  const opens = decisionsTab.opens.value;

  // Layout effects, so they run as the sheet is drawn, before the
  // ANSWERED listener that draws it returns. The forms bound are the ones
  // the sheet is drawn from: a swap unbinds those it took out.
  useLayoutEffect(() => {
    for (const { form } of questions) {
      form.addEventListener("change", redraw);
      form.addEventListener("input", redraw);
      form.addEventListener(page.events.saved, redraw);
    }
    return () => {
      for (const { form } of questions) {
        form.removeEventListener("change", redraw);
        form.removeEventListener("input", redraw);
        form.removeEventListener(page.events.saved, redraw);
      }
    };
  }, [questions]);

  const count = questions.filter((question) => opened(the, question)).length;

  // The first question to answer after the last one jumped to, wrapping round;
  // from the top when that one is no longer asked.
  function upcoming(): number {
    const from = questions.findIndex((question) => question.form.dataset.question === last);
    for (let step = 1; step <= questions.length; step += 1) {
      const index = (from + step) % questions.length;
      if (opened(the, questions[index]!)) {
        return index;
      }
    }
    return -1;
  }

  const index = upcoming();

  function next(event: Event): void {
    event.preventDefault();
    const at = upcoming();
    if (at >= 0) {
      setLast(questions[at]!.form.dataset.question ?? "");
      the.jump(questions[at]!.form);
    }
  }

  // The questions to answer in each section that has marks.
  const counts = new Map<HTMLElement, number>();
  questions.forEach((question) => {
    if (question.heading) {
      counts.set(question.heading, (counts.get(question.heading) ?? 0) + (opened(the, question) ? 1 : 0));
    }
  });

  return (
    <>
      <a class="artifact-review-next" href="#" hidden={index < 0} onClick={next}>
        <span class="artifact-review-next-text">
          Next open
          <span class="artifact-review-next-question">{index < 0 ? null : ": " + questions[index]!.text}</span>
        </span>
        <span class="artifact-review-next-arrow" aria-hidden="true">↓</span>
      </a>
      <button hidden={!questions.length} class={count ? "artifact-review-count" : "artifact-review-count artifact-review-count--done"}
        type="button" aria-controls={opens?.id} onClick={(event) => opens?.open(event.currentTarget)}>
        <span class="artifact-review-dot" aria-hidden="true" />
        <span>{count ? `${count} to answer` : "All answered"}</span>
      </button>
      {Array.from(marks, ([heading, mark]) => {
        const n = counts.get(heading) ?? 0;
        return (
          <Fragment key={mark.key}>
            {createPortal(<span class="artifact-review-open" hidden={!n}>{n ? `${n} open` : null}</span>, mark.heading)}
            {mark.link ? createPortal(
              <span class="artifact-review-outline" hidden={!n}>
                <span class="artifact-review-dot" aria-hidden="true" />
                <span class="artifact-review-outline-number">{n ? String(n) : null}</span>
                <span class="artifact-review-hidden"> open</span>
              </span>, mark.link) : null}
          </Fragment>
        );
      })}
    </>
  );
}

// Each question in page order, under the nearest h2 before its form, which
// the marks count.
function questionsOf(the: Cards, asks: (form: HTMLFormElement) => boolean): Question[] {
  return the.forms.filter(asks).map((form): Question => {
    const fallback = form.dataset.default ?? "";
    return {
      form, heading: the.heading(form),
      text: words(form.querySelector(".artifact-decision-text")),
      fallback: radioOf(form, fallback) ? fallback : "",
    };
  });
}

// The marks drawn so far, for their keys.
let drawn = 0;

// The marks' containers, added to each h2 asking a question and to its
// outline link, so the fold code's heading is never drawn again. A heading
// kept from the last draw keeps its own; one that asks none now, or that a
// swap took out, loses them, and a link a swap brought in gets one.
function markUp(marks: Map<HTMLElement, Marks>, questions: Question[]): void {
  const outline = document.querySelector("ol.artifact-outline-list");
  const asking = new Set(questions.map((question) => question.heading));
  for (const [heading, mark] of marks) {
    if (!asking.has(heading) || !heading.isConnected) {
      mark.heading.remove();
      mark.link?.remove();
      marks.delete(heading);
    }
  }
  for (const heading of asking) {
    if (!heading) {
      continue;
    }
    let mark = marks.get(heading);
    if (!mark) {
      mark = { heading: heading.appendChild(document.createElement("span")), link: null, key: ++drawn };
      marks.set(heading, mark);
    }
    const link = outline && heading.id ?
      outline.querySelector(`a[href="#${CSS.escape(heading.id)}"]`) : null;
    if (mark.link?.parentElement !== link) {
      mark.link?.remove();
      mark.link = link ? link.appendChild(document.createElement("span")) : null;
      mark.key = ++drawn;
    }
  }
}

// Draw the sheet over the page's forms, once their answers are read: into
// tools, the same container each time, so Preact keeps the sheet's own
// state. The forms in read are those an earlier draw picked defaults on.
function draw(page: Page, the: Cards, tools: HTMLElement, marks: Map<HTMLElement, Marks>,
  read: WeakSet<HTMLFormElement>): void {
  // A form brought in by a swap whose read failed has no answer read: it
  // stays out of the sheet, so no default is picked or saved over one,
  // until a later read.
  const questions = questionsOf(the, (form) => the.read || read.has(form));
  markUp(marks, questions);

  // A default picked once the answers are read, so the read never takes
  // the form for one the reader touched: for each form with no answer to
  // the question as the page now asks it, one to an earlier wording too.
  // A form an earlier draw read keeps what the reader left it at.
  for (const question of questions) {
    if (read.has(question.form)) {
      continue;
    }
    read.add(question.form);
    if (question.fallback && !the.saved(question.form) && !picked(question.form)) {
      const radio = radioOf(question.form, question.fallback)!;
      radio.checked = true;
      moved(radio);
    }
  }
  render(<Sheet page={page} the={the} questions={questions} marks={marks} />, tools);
}

// Without the page's answers there is no telling what is answered: no
// sheet, so no default is picked or saved over an answer.
//
// #question=ID, a link from the index's Recent activity: once the answers
// are drawn, an answered form folded to its saved line, and again on each
// hashchange, the form asking ID has its section opened if it is folded
// and lands just under the title bar, as Cards.jump places it, with or without
// the sheet. A question the page does not ask leaves the page where it is.
// A link followed before the answers are drawn is no reload's fragment,
// and one after waits for every other hashchange listener, such as the
// versions view's (js/versions.js), which may still hide the text.
// A live block's "N decisions" (lotuspod.widgets) is such a link to the
// first question about it, which then also takes the focus, as Cards.jump gives
// it, pressed again once it is the address too.
export function reviewSheet(page: Page, cards: Cards | null): void {
  if (!cards || !cards.forms.length) {
    return;
  }
  const the = cards;
  // The question a block's link was last pressed for, until it is followed.
  let focusing: string | null = null;
  function toQuestion(first: boolean): void {
    const id = page.linkedTo("question", first);
    const form = the.forms.find((each) => each.dataset.question === id);
    const focus = !first && id !== null && id === focusing;
    focusing = null;
    if (form) {
      (focus ? the.jump : the.place)(form);
    }
  }
  let drawnAnswers = false;
  let followed = false;
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ?
      event.target.closest<HTMLAnchorElement>('a.artifact-live-decisions, a[href*="#question="]') : null;
    // A click that opens the link elsewhere (a modifier, another button, or
    // another browsing context) is the browser's.
    const target = link?.getAttribute("target");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || (target && target !== "_self")) {
      return;
    }
    // Any link to a question on this document (a bare hash, or the page's
    // own path or URL with one) followed again, its hash already the
    // address, places the form again, as a collapsed card is opened there;
    // a block's link also takes the focus.
    const url = new URL(link.getAttribute("href") ?? "", location.href);
    const here = url.origin + url.pathname + url.search === location.origin + location.pathname + location.search;
    const hash = here ? url.hash : "";
    focusing = null;
    if (link.matches("a.artifact-live-decisions")) {
      // An expanded block would cover the form: it closes first.
      if (link.closest("figure.artifact-live--expanded")) {
        link.closest("figure")?.querySelector<HTMLButtonElement>(".artifact-live-expand")?.click();
      }
      focusing = hash.startsWith("#question=") ? decodeURIComponent(hash.slice("#question=".length)) : null;
    }
    if (hash.startsWith("#question=") && hash === location.hash && drawnAnswers) {
      event.preventDefault();
      toQuestion(false);
    }
  });
  window.addEventListener("hashchange", () => {
    followed = true;
    if (drawnAnswers) {
      setTimeout(() => toQuestion(false), 0);
    }
  });
  document.addEventListener(page.events.answered, () => {
    if (the.read) {
      sheet(page, the);
    }
    drawnAnswers = true;
    toQuestion(!followed);
  }, { once: true });
}

// The sheet's first draw, and once it is drawn, a draw again after each
// swap's read of the answers: never before it, so no default is picked
// over an answer not read yet.
function sheet(page: Page, the: Cards): void {
  const bar = document.querySelector(".artifact-topbar");
  if (!bar || !document.querySelector("section.artifact-body") || page.archived || !the.forms.length) {
    return;
  }
  const tools = bar.appendChild(document.createElement("div"));
  tools.className = "artifact-review-bar";
  const marks = new Map<HTMLElement, Marks>();
  const read = new WeakSet<HTMLFormElement>();
  draw(page, the, tools, marks, read);
  document.addEventListener(page.events.answered, () => draw(page, the, tools, marks, read));
  // A card drawn again from the store's answers between reads (one saved or
  // read elsewhere on the page) draws the sheet again too.
  let seen = the.drawn.peek();
  effect(() => {
    const now = the.drawn.value;
    if (now === seen) return;
    seen = now;
    untracked(() => draw(page, the, tools, marks, read));
  });
}
