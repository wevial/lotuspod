import { effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import { answerStore, store, UNANSWERED, type Answer, type Page, type Swapped } from "../../../comments/ts/index";
import { answeredTable } from "./answered";
import { giveAsk } from "./ask";
import { acting, adopt, dirty, draw, mark, queue, refused, saved, unfold, type Card, type Deck } from "./card";
import { all, isChecklist, optionText, same, summary, ticked } from "./checklist";
import { dismissals } from "./dismiss";
import { noteField, status } from "./words";

// What the review sheet (comments/ts/islands/review-sheet.tsx) reads the
// page's decision forms by: the forms and the store's answers are the
// truth.
export interface Cards {
  // The page's decision forms, in page order.
  readonly forms: HTMLFormElement[];
  // The form's stored answer at its version, else null.
  saved(form: HTMLFormElement): Answer | null;
  // A checklist's item ids checked now ("checked") or by default
  // ("defaultChecked"), in page order.
  ticked(form: HTMLFormElement, state: "checked" | "defaultChecked"): string[];
  // Whether two lists of item ids hold the same items.
  same(a: readonly string[], b: readonly string[]): boolean;
  // The items whose state in checked differs from their defaults, worded.
  summary(form: HTMLFormElement, checked: readonly string[]): string;
  // An option's label, else its value.
  optionText(input: HTMLInputElement): string;
  isChecklist(form: HTMLFormElement): boolean;
  // Whether the picked option, items or note differ from the stored answer.
  dirty(form: HTMLFormElement): boolean;
  // Post the form's answer in its turn: true once saved, false when refused,
  // with why in the form's status.
  save(form: HTMLFormElement): Promise<boolean>;
  // True once the page's answers are read, set before ANSWERED is sent;
  // after a swap, whether its read of them was.
  read: boolean;
  // Counts each time a card is drawn again from a change to the store's
  // answers outside the island's own reads (a read or post elsewhere on the
  // page), which send ANSWERED instead.
  readonly drawn: ReadonlySignal<number>;
}

// The page's decision cards (lotuspod.decisions), as an island on the
// comments store: each form the renderer wrote is taken over, drawn from
// the store's answers to its question (comments/ts/islands/comments/state.ts)
// and saved through it, and the Answered table that ends the body is drawn
// from its current answers. forms may be empty, on a page whose decisions
// are no longer asked; a page with no form names itself on its comment
// boxes, and one with neither has no cards (null).
export function decisions(page: Page): Cards | null {
  const forms = page.all("form.artifact-decision") as HTMLFormElement[];
  const named = forms[0] || document.querySelector<HTMLElement>("details.artifact-comment[data-page]");
  if (!named) {
    return null;
  }
  const name = named.dataset.page!;
  const answers = answerStore(page);
  const cards = new Map<HTMLFormElement, Card>();
  const deck: Deck = { page, owner: false, undo() {} };
  const cardOf = (form: HTMLFormElement) => cards.get(form)!;
  // The island's reads of the answers under way, and the cards drawn again
  // outside them.
  let loading = 0;
  const drawn = signal(0);
  const each = () => forms.map(cardOf);

  // The form asking question, if the page asks it.
  function formOf(question: string): HTMLFormElement | null {
    return forms.find((form) => form.dataset.question === question) || null;
  }

  // A row's "change": the card's section opened if it is folded, as find
  // in page opens it, then the card scrolled to and opened again.
  function reopen(form: HTMLFormElement): void {
    const wrapper = form.closest("div.artifact-section-body");
    if (wrapper && wrapper.hasAttribute("hidden")) {
      wrapper.dispatchEvent(new Event("beforematch"));
    }
    form.scrollIntoView({ block: "center" });
    unfold(deck, cardOf(form));
  }
  const table = answeredTable(page, formOf, reopen);

  // An answer, dismissal or undo saved: the page is told (SAVED, with
  // what the route gave), and an answer whose note opened or added to a
  // thread calls for the threads to be read.
  function told(card: Card, detail: unknown): void {
    card.form.dispatchEvent(new CustomEvent(page.events.saved, { detail }));
    if (detail && (detail as { comment?: unknown }).comment) {
      store.asking.peek()?.owe();
    }
  }
  const dismissing = dismissals(deck, answers, told);

  function failure(response: Response, payload: { error?: unknown } | null): string {
    if (response.status === 401) {
      return page.signedOut;
    }
    if (response.status === 409) {
      return page.stale;
    }
    const error = payload && payload.error ? String(payload.error) : "status " + response.status;
    return "Your answer was not saved (" + error + "). Try again.";
  }

  // Post a form's answer, as picked when its turn comes, with its note:
  // true once it is saved and the form drawn from it, false when it is
  // not, with why in the form's status.
  async function post(card: Card): Promise<boolean> {
    const { form } = card;
    const checklist = isChecklist(form);
    const picked = form.querySelector<HTMLInputElement>('input[name="choice"]:checked');
    if (!checklist && !picked) {
      status(form, "Pick an option first.");
      return false;
    }
    const body: Record<string, unknown> = {
      page: form.dataset.page,
      question: form.dataset.question,
      version: form.dataset.version,
    };
    if (checklist) {
      body.checked = ticked(form, "checked");
    } else {
      body.choice = picked!.value;
    }
    body.note = noteField(form).value;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    status(form, "Saving your answer...");
    try {
      const { response, payload } = await answers.save(form.dataset.question!, body);
      if (response.status !== 201 || !payload) {
        refused(deck, card, failure(response, payload as { error?: unknown } | null));
        return false;
      }
      card.shown = card.answers.peek();
      card.waiting = false;
      // A pick or note changed while this was saving stays open, not saved.
      card.editing = dirty(card);
      status(form, "");
      draw(deck, card);
      // The answer itself is the store's; a note's comment, when one was
      // stored, goes with SAVED to the comment threads.
      told(card, payload);
      return true;
    } catch {
      refused(deck, card, "Your answer was not saved: the site did not answer. Try again.");
      return false;
    } finally {
      button.disabled = false;
    }
  }

  function save(form: HTMLFormElement): Promise<boolean> {
    const card = cardOf(form);
    return queue(card, () => acting(deck, card, () => post(card)));
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    // A form saved and folded hands the focus to its "change".
    if (await save(form) && form.classList.contains("artifact-decision--saved")) {
      form.querySelector<HTMLButtonElement>(".artifact-decision-saved .artifact-decision-change")!.focus();
    }
  }

  // A form joins the page's: drawn from the store's answers to its
  // question once a read of them succeeds, again each time they change, and
  // marked as the reader changes it; with its Ask once the comments store
  // has started.
  function wire(form: HTMLFormElement): void {
    const card: Card = {
      form, answers: store.answer(form.dataset.question!), shown: UNANSWERED,
      editing: false, turn: Promise.resolve(), queued: 0, acting: 0, waiting: true, dispose() {},
    };
    cards.set(form, card);
    form.addEventListener("submit", submit);
    form.addEventListener("input", () => mark(card));
    form.addEventListener("change", () => mark(card));
    mark(card);
    card.dispose = effect(() => {
      const value = card.answers.value;
      if (value !== card.shown && !card.acting && !card.waiting) {
        untracked(() => {
          adopt(deck, card, value);
          // Outside the island's own reads, which send ANSWERED once drawn,
          // the review sheet is told the cards changed.
          if (!loading) drawn.value += 1;
        });
      }
    });
    const asking = store.asking.peek();
    if (asking) giveAsk(page, form, asking);
  }

  forms.forEach(wire);
  // Ask, once the comments store starts.
  effect(() => {
    const asking = store.asking.value;
    if (asking) untracked(() => forms.forEach((form) => giveAsk(page, form, asking)));
  });
  // The Answered table, as the store's current answers change.
  effect(() => {
    const rows = store.currents.value;
    untracked(() => table(rows));
  });
  dismissing.mayDismiss(name, each);

  const reading: Cards = {
    forms, ticked, same, summary, optionText, isChecklist, save, read: false, drawn,
    saved: (form) => saved(cardOf(form)),
    dirty: (form) => dirty(cardOf(form)),
  };

  // The answers read, the table placed after the body's last section, and
  // the page told (ANSWERED); not for a read a newer one replaced, which
  // sends ANSWERED itself once it is drawn. read is true once the answers
  // are read, so a failed read is never taken for a page with nothing
  // answered.
  function load(): void {
    loading += 1;
    answers.read(name).catch(() => false).then((read) => {
      loading -= 1;
      if (read === null) {
        return;
      }
      reading.read = read === true;
      if (read) {
        for (const card of each()) {
          card.waiting = false;
          if (!card.acting && card.answers.peek() !== card.shown) {
            adopt(deck, card, card.answers.peek());
          }
        }
      }
      table(store.currents.peek());
      document.dispatchEvent(new CustomEvent(page.events.answered));
    });
  }
  load();

  // The forms among some nodes and in them.
  function formsIn(nodes: Node[]): HTMLFormElement[] {
    const found: HTMLFormElement[] = [];
    for (const node of nodes) {
      if (node instanceof Element) {
        if (node.matches("form.artifact-decision")) {
          found.push(node as HTMLFormElement);
        }
        found.push(...all<HTMLFormElement>("form.artifact-decision", node));
      }
    }
    return found;
  }

  // A swap (live/ts/page-swap.ts) brought in a newer revision's parts:
  // each form in a part it took out leaves forms, which stays the one
  // array, in page order, and each in a part it put in is wired as one is
  // at load, with Dismiss for an owner. The answers are then read again,
  // as a reworded question's form, or one answered elsewhere since, is
  // drawn from them as a reload would draw it, and the table after them;
  // ANSWERED tells the page the read is drawn.
  document.addEventListener(page.events.swapped, (event) => {
    const gone: HTMLFormElement[] = [];
    const fresh: HTMLFormElement[] = [];
    for (const unit of (event as CustomEvent<Swapped>).detail.units) {
      gone.push(...formsIn(unit.before));
      fresh.push(...formsIn(unit.after));
    }
    if (!gone.length && !fresh.length) {
      return;
    }
    for (const form of gone) {
      const at = forms.indexOf(form);
      if (at >= 0) {
        forms.splice(at, 1);
        cards.get(form)?.dispose();
        cards.delete(form);
      }
    }
    for (const form of fresh) {
      forms.push(form);
      wire(form);
      if (deck.owner) {
        dismissing.dismissible(cardOf(form));
      }
    }
    // A page that loaded with no form asks now whether the reader may
    // dismiss.
    dismissing.mayDismiss(name, each);
    forms.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    load();
  });

  // A section holding a form the reader changed and has not saved, or
  // one whose answer, dismissal or undo is still being posted, is held
  // back from a swap until its Update, so what they picked or wrote is
  // never lost.
  page.holdSwap((nodes) => forms.some((form) => {
    const card = cardOf(form);
    return (dirty(card) || card.queued > 0) && nodes.some((node) => node.contains(form));
  }));
  return reading;
}
