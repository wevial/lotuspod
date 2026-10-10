// The one module that names what the legacy page script's sources share in
// the closure the join wraps them in (THEME_CLOSURES in src/lotuspod/cli.py):
// the bundle is joined last inside it, so these are the closure's own names,
// which a minifier never renames. Each is read once, as the bundle loads, so
// a name that does not exist throws on every page at once. Islands import
// page, never the names.

// What js/live-page.js keeps of the page's revision while it is open.
export interface Live {
  // A revision the page learned it is now published at; once it is not its
  // own, the page offers a reload.
  seen(revision: unknown): void;
  // What to keep over a reload: save() is kept, and unsent() says whether a
  // composer holds text not sent, so a hidden page does not reload itself.
  keep(keeper: { save(): unknown; unsent(): boolean }): void;
  // What save() kept before the reload that loaded this page, taken once.
  kept(): object | null;
  // Scroll to where the reader was before the reload, once.
  place(): void;
  // The revision the reader last opened the page at, null the first time or
  // on any failure.
  previous(): Promise<string | null>;
}

// A stored answer to a decision, as the answers route gives it: a choice, a
// checklist's items checked, or a dismissal.
export interface Answer {
  choice?: string;
  checked?: string[];
  note?: string;
  dismissed?: boolean;
}

// What js/decisions.js reads and saves the page's decision forms by
// (answerForms()): the forms and the stored answers are the truth.
export interface Answering {
  // The form's stored answer at its version, else null.
  saved(form: HTMLFormElement): Answer | null;
  // A checklist's item ids checked now ("checked") or by default
  // ("defaultChecked"), in page order.
  ticked(form: HTMLFormElement, state: "checked" | "defaultChecked"): string[];
  // Whether two lists of item ids hold the same items.
  same(a: string[], b: string[]): boolean;
  // The items whose state in checked differs from their defaults, worded.
  summary(form: HTMLFormElement, checked: string[]): string;
  // An option's label, else its value.
  optionText(input: HTMLInputElement): string;
  isChecklist(form: HTMLFormElement): boolean;
  // Whether the picked option, items or note differ from the stored answer.
  dirty(form: HTMLFormElement): boolean;
  // Post the form's answer in its turn: true once saved, false when refused,
  // with why in the form's status.
  save(form: HTMLFormElement): Promise<boolean>;
  // True once the page's answers are read, set before ANSWERED is sent.
  read: boolean;
}

// js/live-page.js.
declare const live: Live;
// js/decisions.js: the page's decision forms, in page order, and what reads
// them, null on a page with neither a form nor a comment box.
declare const forms: HTMLFormElement[];
declare const answering: Answering | null;
// js/page-open.js: what the address's fragment gives name as #NAME=VALUE,
// decoded, else null; read as the page opens (first), null on a reload.
declare function linkedTo(name: string, first?: boolean): string | null;
// js/page-open.js: an archived page takes no new comment, reply or answer.
declare const ARCHIVED: boolean;
// js/page-open.js: the page events. ANSWERED is sent on the document once
// the page's read of answers has finished, SAVED on a decision form once an
// answer to it is saved, DRAWN on a comment box when rows are drawn into it.
declare const ANSWERED: string;
declare const SAVED: string;
declare const DRAWN: string;

export const page = Object.freeze({
  live,
  forms,
  answering,
  linkedTo,
  archived: ARCHIVED,
  events: Object.freeze({ answered: ANSWERED, saved: SAVED, drawn: DRAWN }),
});

export type Page = typeof page;
