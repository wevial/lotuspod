import type { Answer } from "../../../comments/ts/index";
import { all, isChecklist, summary } from "./checklist";

export function radios(form: HTMLFormElement): HTMLInputElement[] {
  return all<HTMLInputElement>('input[type="radio"][name="choice"]', form);
}

// The label beside the form's radio valued value, if it has one.
function labelOf(form: HTMLFormElement, value: unknown): Element | null | undefined {
  const found = radios(form).find((radio) => radio.value === value);
  return found && found.parentNode!.querySelector(".artifact-decision-label");
}

// Whether input is a choice radio, picked, that offers "Something else":
// valued "other" or so labelled in any case.
export function somethingElse(input: HTMLInputElement): boolean {
  if (input.type !== "radio" || input.name !== "choice" || !input.checked) return false;
  const text = input.parentNode?.querySelector(".artifact-decision-label")?.textContent ?? "";
  return input.value === "other" || text.replace(/\s+/g, " ").trim().toLowerCase() === "something else";
}

// The words of a form's part, its whitespace collapsed.
export function words(form: HTMLFormElement, selector: string): string {
  const node = form.querySelector(selector);
  return node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "";
}

// An answer in the words it was given in: its kept label, else its items
// or its choice.
export function kept(answer: Answer): string {
  const asked = answer.asked || {};
  if (asked.label) {
    return String(asked.label);
  }
  return Array.isArray(answer.checked) ? answer.checked.join(", ") : String(answer.choice);
}

// The note an answer leaves in its form: none for a dismissal, whose note
// is its reason.
export function noteOf(answer: Answer | null): string {
  return answer && answer.note && !answer.dismissed ? answer.note : "";
}

// The label the form shows for an answer: "Dismissed" for a dismissal;
// a decision's option label, or the choice itself when it offers no
// such option (an answer to an earlier wording); a checklist's summary
// while the answer is at the form's version, else the words it was
// given in.
export function label(form: HTMLFormElement, answer: Answer): string {
  if (answer.dismissed) {
    return "Dismissed";
  }
  if (isChecklist(form)) {
    return answer.version === form.dataset.version ? summary(form, answer.checked || []) : kept(answer);
  }
  const choice = chosen(form, answer);
  const text = labelOf(form, choice);
  return text ? text.textContent ?? "" : String(choice);
}

// The option a decision form shows answer as, the rule
// lotuspod.features.decisions.decisions.shown documents: its default for an
// earlier "Accept the default" it no longer offers, else the answer's own
// choice.
export function chosen(form: HTMLFormElement, answer: Answer): string | undefined {
  return holds(form, answer) && accepted(form, answer) ? form.dataset.default : answer.choice;
}

// The characters Python's str.split() takes as white space, so the page and
// publish's warning collapse the same ones.
const SPACE = /[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

// Text with its white space collapsed.
function squeezed(text: unknown): string {
  return String(text).replace(SPACE, " ").replace(/^ | $/g, "");
}

// Whether answer, a question's current answer, shows as the form's answer:
// the rule lotuspod.features.decisions.decisions.holds documents.
export function holds(form: HTMLFormElement, answer: Answer): boolean {
  if (answer.version === form.dataset.version) {
    return true;
  }
  const asked = answer.asked || {};
  if (isChecklist(form) || answer.dismissed || Array.isArray(answer.checked) || !asked.text ||
    asked.label == null || squeezed(asked.text) !== squeezed(form.querySelector(".artifact-decision-text")?.textContent ?? "")) {
    return false;
  }
  const text = labelOf(form, answer.choice);
  return text ? squeezed(asked.label) === squeezed(text.textContent ?? "") : accepted(form, answer);
}

// Whether answer, a decision's, not a dismissal, is an "Accept the default"
// the form no longer offers, while the form's default is one of its options.
function accepted(form: HTMLFormElement, answer: Answer): boolean {
  return !answer.dismissed && answer.choice === "accept" &&
    squeezed(answer.asked?.label) === "Accept the default" &&
    !labelOf(form, "accept") && Boolean(labelOf(form, form.dataset.default));
}

// The note field's fold opened, or closed.
export function fold(note: HTMLTextAreaElement, open: boolean): void {
  const details = note.closest("details");
  if (details) details.open = open;
}

// The form's note field.
export function noteField(form: HTMLFormElement): HTMLTextAreaElement {
  return form.elements.namedItem("note") as HTMLTextAreaElement;
}

export function status(form: HTMLFormElement, text: string): void {
  form.querySelector(".artifact-decision-status")!.textContent = text;
}
