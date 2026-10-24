import { render } from "preact";
import type { ReadonlySignal, Signal } from "@preact/signals";
import type { Answer, Answers, Page } from "../../../comments/ts/index";
import { isChecklist, optionText, same, ticked, boxes } from "./checklist";
import { expand } from "./collapse";
import { label, noteField, noteOf, radios, status } from "./words";

// A decision form as the island holds it: the store's answers to its
// question, those it was last drawn from, whether it is open to change
// with an answer saved, and its posts, one at a time.
export interface Card {
  form: HTMLFormElement;
  answers: ReadonlySignal<Answers>;
  shown: Answers;
  editing: boolean;
  // The form's posts, chained, and how many are queued or under way.
  turn: Promise<unknown>;
  queued: number;
  // Posts under way whose answer the post draws itself.
  acting: number;
  // Until a read of the answers succeeds after it is wired, the card takes
  // none of the store's: a form a swap brought in stays out of what a
  // failed or replaced read would leave it, as on a reload.
  waiting: boolean;
  // Counts each time any card is marked: a pick, a note or a draw, which the
  // Decisions tab draws from.
  marked: Signal<number>;
  dispose(): void;
}

// What every card is drawn with: the page, and whether the reader may
// dismiss and undo, once the archive route says so.
export interface Deck {
  page: Page;
  owner: boolean;
  // Undo a card's dismissal, in its turn (the dismiss part's).
  undo(card: Card, button: HTMLButtonElement): void;
}

// The answer to the question as the page now asks it, if any.
export function saved(card: Card): Answer | null {
  const current = card.shown.current;
  return current && current.version === card.form.dataset.version ? current : null;
}

// Whether the picked option or the note differs from answer; for a
// checklist, whether the items checked differ from answer's, or from their
// defaults while there is none.
function differs(form: HTMLFormElement, answer: Answer | null): boolean {
  if (isChecklist(form)) {
    if (!same(ticked(form, "checked"), answer ? answer.checked || [] : ticked(form, "defaultChecked"))) {
      return true;
    }
  } else {
    const picked = form.querySelector<HTMLInputElement>('input[name="choice"]:checked');
    if (picked && (!answer || picked.value !== answer.choice)) {
      return true;
    }
  }
  return noteField(form).value !== noteOf(answer);
}

// Whether the form differs from its saved answer.
export function dirty(card: Card): boolean {
  return differs(card.form, saved(card));
}

// Where a collapsed card stands, in its one line: "✓ Saved · LABEL" while
// it holds its saved answer, "LABEL · Not saved" for a pick it differs
// from that by, and "Not answered yet" with no pick.
function Line({ card, changed }: { card: Card; changed: boolean }) {
  const answer = saved(card);
  if (answer && answer.dismissed && !changed) {
    return <>{answer.note ? "Dismissed: " + answer.note : "Dismissed"}</>;
  }
  if (answer && !changed) {
    return (
      <>
        <span class="artifact-decision-saved-mark"><span class="artifact-decision-check" aria-hidden="true">✓</span>{" Saved"}</span>
        {" · "}<strong>{label(card.form, answer)}</strong>
      </>
    );
  }
  const picked = card.form.querySelector<HTMLInputElement>('input[name="choice"]:checked');
  if (!picked) {
    return <>Not answered yet</>;
  }
  return <><strong>{optionText(picked)}</strong>{" · "}<span class="artifact-decision-line-unsaved">Not saved</span></>;
}

// The lavender rule and "Not saved" while the form differs from its
// answer; "Not answered yet" while nothing is answered or picked; the
// collapsed card's line.
export function mark(card: Card): void {
  const { form } = card;
  const changed = dirty(card);
  form.classList.toggle("artifact-decision--dirty", changed);
  const unsaved = form.querySelector<HTMLElement>(".artifact-decision-unsaved");
  if (unsaved) {
    unsaved.hidden = !changed;
  }
  const hint = form.querySelector<HTMLElement>(".artifact-decision-hint");
  if (hint) {
    hint.hidden = changed || Boolean(card.shown.current);
  }
  const line = form.querySelector<HTMLElement>(".artifact-decision-line");
  if (line) {
    render(<Line card={card} changed={changed} />, line);
  }
  card.marked.value = card.marked.peek() + 1;
}

function History({ page, form, earlier }: { page: Page; form: HTMLFormElement; earlier: readonly Answer[] }) {
  return (
    <>
      <summary>{earlier.length + (earlier.length === 1 ? " earlier answer" : " earlier answers")}</summary>
      <ol>
        {earlier.map((row) => (
          <li>
            <span class="artifact-decision-history-choice">{label(form, row)}</span>
            {row.note && <>{" "}<span class="artifact-decision-history-note">{row.note}</span></>}
            {" "}
            <span class="artifact-decision-history-by">{page.reader(row) + ", " + page.when(row.createdAt)}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function history(deck: Deck, card: Card): void {
  const { form } = card;
  let details = form.querySelector<HTMLDetailsElement>(".artifact-decision-history");
  if (!details) {
    details = document.createElement("details");
    details.className = "artifact-decision-history";
    form.querySelector("fieldset")!.appendChild(details);
  }
  const earlier = card.shown.earlier;
  details.hidden = earlier.length === 0;
  render(<History page={deck.page} form={form} earlier={earlier} />, details);
}

// The folded card: "✓ Saved · LABEL · change", where an answer an agent
// recorded was given, the note, who and when. A dismissal's is
// "Dismissed: REASON · Undo", Undo for an owner only, then who and when.
function Folded({ deck, card, answer }: { deck: Deck; card: Card; answer: Answer }) {
  const { page } = deck;
  if (answer.dismissed) {
    return (
      <>
        <p class="artifact-decision-saved-line">
          {answer.note ? "Dismissed: " + answer.note : "Dismissed"}
          {deck.owner && <>{" · "}<button type="button" class="artifact-decision-undo" onClick={(event) => {
            const back = event.currentTarget;
            back.disabled = true;
            deck.undo(card, back);
          }}>Undo</button></>}
        </p>
        <p class="artifact-decision-saved-by">{page.reader(answer) + " · " + page.when(answer.createdAt)}</p>
      </>
    );
  }
  let by = (answer.source ? "recorded by " : "") + page.reader(answer) + " · " + page.when(answer.createdAt);
  if (answer.supersedes) {
    by += " · replaced an earlier answer";
  }
  return (
    <>
      <p class="artifact-decision-saved-line">
        <span class="artifact-decision-saved-mark"><span class="artifact-decision-check" aria-hidden="true">✓</span>{" Saved"}</span>
        {" · "}<strong>{label(card.form, answer)}</strong>{" · "}
        <button type="button" class="artifact-decision-change" onClick={() => unfold(deck, card)}>change</button>
      </p>
      {answer.source && <p class="artifact-decision-saved-source">{"Answered elsewhere: " + answer.source}</p>}
      {answer.note && <p class="artifact-decision-saved-note">{answer.note}</p>}
      <p class="artifact-decision-saved-by">{by}</p>
    </>
  );
}

// Draw a form from its answers: folded under its legend when it holds an
// answer to the question as the page now asks it, open otherwise. The
// button the folded card offers is returned.
export function draw(deck: Deck, card: Card): HTMLButtonElement | null {
  const { form } = card;
  const answer = saved(card);
  const folded = Boolean(answer) && !card.editing;
  const current = card.shown.current;
  let earlier = form.querySelector(".artifact-decision-earlier");
  if (current && !answer) {
    if (!earlier) {
      earlier = document.createElement("p");
      earlier.className = "artifact-decision-earlier";
      const options = form.querySelector(".artifact-decision-options")!;
      options.parentNode!.insertBefore(earlier, options);
    }
    earlier.textContent = "Answered to an earlier wording by " + deck.page.reader(current) + ", " +
      deck.page.when(current.createdAt);
  } else if (earlier) {
    earlier.remove();
  }
  let block = form.querySelector<HTMLElement>(".artifact-decision-saved");
  if (folded) {
    if (!block) {
      block = document.createElement("div");
      block.className = "artifact-decision-saved";
      const legend = form.querySelector("legend")!;
      legend.parentNode!.insertBefore(block, legend.nextSibling);
    }
    // A failed Undo's words go when the card is drawn again.
    block.querySelector(".artifact-decision-saved-status")?.remove();
    render(<Folded deck={deck} card={card} answer={answer!} />, block);
  }
  for (const child of Array.from(form.querySelector("fieldset")!.children) as HTMLElement[]) {
    if (child.tagName === "LEGEND" || child.classList.contains("artifact-decision-history") ||
      child.classList.contains("artifact-decision-line")) {
      continue;
    }
    child.hidden = child.classList.contains("artifact-decision-saved") ? !folded : folded;
  }
  form.classList.toggle("artifact-decision--saved", folded);
  form.classList.toggle("artifact-decision--dismissed", folded && Boolean(answer!.dismissed));
  history(deck, card);
  mark(card);
  if (!folded) {
    return null;
  }
  return block!.querySelector<HTMLButtonElement>(".artifact-decision-undo, .artifact-decision-change");
}

// Fill a form's inputs from its answer to the question as the page now
// asks it; an answer to an earlier wording fills nothing.
export function fill(card: Card): void {
  const answer = saved(card);
  if (!answer) {
    return;
  }
  if (isChecklist(card.form)) {
    const checked = answer.checked || [];
    for (const box of boxes(card.form)) {
      box.checked = checked.indexOf(box.value) !== -1;
    }
  } else {
    for (const radio of radios(card.form)) {
      radio.checked = radio.value === answer.choice;
    }
  }
  noteField(card.form).value = noteOf(answer);
}

// The store's answers to the question changed under the card (a read, or a
// post from elsewhere): it is drawn from them. A dismissal folds it all the
// same, no option left picked and a note the reader wrote kept for Undo to
// open, the saved answer's note emptied, as Dismiss leaves it; a
// form the reader changed from what it last showed stays open as they left
// it; any other takes the answer's pick and note.
export function adopt(deck: Deck, card: Card, value: Answers): void {
  const touched = differs(card.form, saved(card));
  card.shown = value;
  const answer = saved(card);
  if (answer && answer.dismissed) {
    for (const radio of radios(card.form)) radio.checked = false;
    if (!touched) noteField(card.form).value = "";
    card.editing = false;
  } else if (touched && dirty(card)) {
    card.editing = true;
  } else {
    fill(card);
  }
  draw(deck, card);
}

// The card open again with its answer picked and its note; a pick made
// since in the review sheet (comments/ts/islands/review-sheet.tsx) or the
// Decisions tab stays picked. The focus stays where it is.
export function openCard(deck: Deck, card: Card): void {
  const { form } = card;
  if (!dirty(card)) {
    fill(card);
  }
  const note = form.querySelector<HTMLDetailsElement>("details.artifact-decision-note");
  if (note) {
    note.open = Boolean(noteField(form).value);
  }
  card.editing = true;
  status(form, "");
  draw(deck, card);
}

// "change": the card open again, its pick focused.
export function unfold(deck: Deck, card: Card): void {
  openCard(deck, card);
  card.form.querySelector<HTMLInputElement>('input[name="choice"]:checked, input[name="item"]:checked')?.focus();
}

// The card's saved pick and note put back, and the card folded to its answer.
export function restore(deck: Deck, card: Card): void {
  fill(card);
  card.editing = false;
  status(card.form, "");
  draw(deck, card);
}

// Why a form's answer was not saved, in its status: a form folded to its
// answer (saved from the review sheet), or collapsed, opens to show it.
export function refused(deck: Deck, card: Card, text: string): void {
  expand(card.form);
  if (card.form.classList.contains("artifact-decision--saved")) {
    card.editing = true;
    draw(deck, card);
  }
  status(card.form, text);
}

// Run work once the form's earlier posts are answered: a form posts one
// answer, dismissal or undo at a time, so an older post never lands after
// a newer one.
export function queue<T>(card: Card, work: () => Promise<T>): Promise<T> {
  const turn = card.turn.then(work);
  card.turn = turn;
  card.queued += 1;
  const done = () => { card.queued -= 1; };
  turn.then(done, done);
  return turn;
}

// An action posting through the store that draws the card from what it
// gets itself: the store's signal is not adopted while it runs, and one a
// read changed meanwhile is adopted once it ends.
export async function acting<T>(deck: Deck, card: Card, work: () => Promise<T>): Promise<T> {
  card.acting += 1;
  try {
    return await work();
  } finally {
    card.acting -= 1;
    if (!card.acting && !card.waiting && card.answers.peek() !== card.shown) {
      adopt(deck, card, card.answers.peek());
    }
  }
}
