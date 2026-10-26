import type { AnswerStore } from "../../../comments/ts/index";
import { acting, dirty, draw, fill, queue, refused, saved, type Card, type Deck } from "./card";
import { isChecklist } from "./checklist";
import { fold, noteField, radios, status } from "./words";

const MAX_REASON = 200;

// An owner (one of the [access] owners, as the archive route says) may
// dismiss a decision that no longer matters, the note's text its reason:
// the dismissal is an answer of its own, folded to "Dismissed: REASON" with
// an Undo for an owner, which puts the decision back as it stood. Each
// posts through the store, which holds the answers; SAVED tells the page.
export function dismissals(deck: Deck, answers: AnswerStore, told: (card: Card, detail: unknown) => void) {
  const { page } = deck;
  // Whether the archive route was asked: once, as the page's first form
  // is wired, at load or on a swap.
  let asked = false;

  function undismissed(response: Response, payload: { error?: unknown } | null): string {
    if (response.status === 401) {
      return page.signedOut;
    }
    const error = payload && payload.error ? String(payload.error) : "status " + response.status;
    if (response.status === 409 && error === "stale") {
      return page.stale;
    }
    return "This decision was not dismissed (" + error + "). Try again.";
  }

  // Dismiss, in the form's turn: the note's text as it then reads,
  // trimmed, posted as the reason, its length counted in characters as
  // the server counts them. Dismissed, no option stays picked, the note is
  // emptied and folded, as Ask leaves it, and the form folds to the
  // dismissal. A note written while it was dismissing stays in the folded
  // card, unsent, for Undo to open again.
  async function dismiss(card: Card, button: HTMLButtonElement): Promise<void> {
    const { form } = card;
    const note = noteField(form);
    const sent = note.value;
    const reason = sent.trim();
    try {
      if (Array.from(reason).length > MAX_REASON) {
        status(form, "Shorten the note to " + MAX_REASON + " characters to dismiss with it as the reason.");
        return;
      }
      status(form, "Dismissing this decision...");
      const { response, payload } = await answers.dismiss(form.dataset.question!, {
        page: form.dataset.page, question: form.dataset.question,
        version: form.dataset.version, dismissed: true, reason,
      });
      if (response.status !== 201 || !payload) {
        refused(deck, card, undismissed(response, payload as { error?: unknown } | null));
        return;
      }
      card.shown = card.answers.peek();
      card.waiting = false;
      for (const radio of radios(form)) radio.checked = false;
      if (note.value === sent) {
        note.value = "";
        fold(note, false);
      }
      card.editing = false;
      status(form, "");
      const back = draw(deck, card);
      told(card, payload);
      back?.focus();
    } catch {
      refused(deck, card, "This decision was not dismissed: the site did not answer. Try again.");
    } finally {
      button.disabled = false;
    }
  }

  // Why an Undo failed, under the dismissed card, which stays folded so
  // its Undo can be pressed again.
  function cardSays(card: Card, text: string): void {
    const block = card.form.querySelector(".artifact-decision-saved")!;
    let said = block.querySelector(".artifact-decision-saved-status");
    if (!said) {
      said = document.createElement("p");
      said.className = "artifact-decision-saved-status";
      said.setAttribute("role", "status");
      block.appendChild(said);
    }
    said.textContent = text;
  }

  // Undo, in the form's turn: the dismissal taken back, and the form drawn
  // from the answers the route gives back, its inputs as they hold, or
  // only its default picked when no answer is left, as the page opened it,
  // so a pick made in the review sheet while it was dismissed goes. A note
  // written while it was dismissed stays, the form open to save it. A
  // question with no answer left leaves the Answered table, and a read
  // that is still coming is not taken over it (the store's).
  async function undo(card: Card, button: HTMLButtonElement): Promise<void> {
    const { form } = card;
    try {
      const { response, payload } = await answers.undo(form.dataset.question!, {
        page: form.dataset.page, question: form.dataset.question, dismissed: false,
      });
      if (response.status !== 200 || !payload) {
        const failed = payload as { error?: unknown } | null;
        const error = failed && failed.error ? String(failed.error) : "status " + response.status;
        cardSays(card, response.status === 401 ? page.signedOut :
          "This dismissal was not undone (" + error + "). Try again.");
        return;
      }
      card.shown = card.answers.peek();
      card.waiting = false;
      const note = noteField(form);
      const draft = note.value;
      for (const radio of radios(form)) {
        radio.checked = !saved(card) && radio.value === (form.dataset.default || null);
      }
      fill(card);
      if (draft) {
        note.value = draft;
        fold(note, true);
      }
      card.editing = dirty(card);
      status(form, "");
      const change = draw(deck, card);
      told(card, payload);
      (change || form.querySelector("input"))?.focus();
    } catch {
      cardSays(card, "This dismissal was not undone: the site did not answer. Try again.");
    } finally {
      button.disabled = false;
    }
  }

  deck.undo = (card, button) => {
    void queue(card, () => acting(deck, card, () => undo(card, button)));
  };

  // A form's Dismiss, for an owner, after its Save answer and Ask, and its
  // Undo once drawn again.
  function dismissible(card: Card): void {
    const { form } = card;
    if (!isChecklist(form)) {
      const button = document.createElement("button");
      button.className = "artifact-decision-dismiss";
      button.textContent = "Dismiss";
      button.type = "button";
      button.addEventListener("click", () => {
        button.disabled = true;
        void queue(card, () => acting(deck, card, () => dismiss(card, button)));
      });
      const after = form.querySelector(".artifact-decision-ask") || form.querySelector('button[type="submit"]')!;
      after.parentNode!.insertBefore(button, after.nextSibling);
    }
    if (form.classList.contains("artifact-decision--dismissed")) {
      draw(deck, card);
    }
  }

  return {
    dismissible,
    // Each decision's Dismiss, and Undo on its dismissed card, only once
    // the archive route says the reader is an owner. An archived page
    // takes no answer, so it asks nothing.
    mayDismiss(name: string, cards: () => Card[]): void {
      if (page.archived || !cards().length || asked) {
        return;
      }
      asked = true;
      fetch("/api/archive?page=" + encodeURIComponent(name)).then(async (response) => {
        const payload = response.status === 200 ? await page.json<{ mayArchive?: unknown }>(response) : null;
        if (!payload || payload.mayArchive !== true) {
          return;
        }
        deck.owner = true;
        cards().forEach(dismissible);
      }).catch(() => {
        // No answer: no Dismiss and no Undo.
      });
    },
  };
}
