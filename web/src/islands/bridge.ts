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

// js/live-page.js.
declare const live: Live;
// js/page-open.js: an archived page takes no new comment, reply or answer.
declare const ARCHIVED: boolean;
// js/page-open.js: the page events. ANSWERED is sent on the document once
// the page's read of answers has finished, SAVED on a decision form once an
// answer to it is saved, DRAWN on a comment box when rows are drawn into it.
declare const ANSWERED: string;
declare const SAVED: string;
declare const DRAWN: string;

export interface Page {
  readonly live: Live;
  readonly archived: boolean;
  readonly events: {
    readonly answered: string;
    readonly saved: string;
    readonly drawn: string;
  };
}

export const page: Page = Object.freeze({
  live,
  archived: ARCHIVED,
  events: Object.freeze({ answered: ANSWERED, saved: SAVED, drawn: DRAWN }),
});
