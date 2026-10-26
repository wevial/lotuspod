import type { Asking, Page } from "../../../comments/ts/index";
import { fold, noteField } from "./words";

// Each decision's Ask, beside "Save answer", on a page whose comments store
// has started: the note's text posted through the store as a question
// thread on the decision, which saves no answer. Sent, the note is emptied
// and folded, so it is never saved as the answer's note, and the store
// opens the thread where the window has room for it.
export function giveAsk(page: Page, form: HTMLFormElement, asking: Asking): void {
  const save = form.querySelector('button[type="submit"]');
  const note = form.elements.namedItem("note");
  if (!save || !(note instanceof HTMLTextAreaElement || note instanceof HTMLInputElement) ||
      form.querySelector(".artifact-decision-ask")) return;
  const button = page.element("button", "artifact-decision-ask", "Ask");
  button.type = "button";
  save.parentNode!.insertBefore(button, save.nextSibling);
  const status = form.querySelector(".artifact-decision-status");
  function say(text: string) {
    if (status) status.textContent = text;
  }
  button.addEventListener("click", async () => {
    const field = noteField(form);
    const sent = field.value;
    const text = sent.trim();
    if (!text) {
      say(page.noQuestion);
      return;
    }
    button.disabled = true;
    say("Sending your question...");
    try {
      say(await asking.ask(form.dataset.question!, text, () => {
        say("");
        // A note changed while the question was sending holds a question
        // not yet sent: it stays, open, and the card keeps it unsaved.
        if (field.value !== sent) return;
        field.value = "";
        fold(field, false);
        // The card, and the review sheet, mark themselves as the note now
        // reads.
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }));
    } catch {
      say("Your question was not sent: the site did not answer. Try again.");
    } finally {
      button.disabled = false;
    }
  });
}
