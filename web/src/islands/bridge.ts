import type { Commenting } from "./comments/parts";

// Islands reach the legacy closure only through page. The bundle follows
// comments.js inside THEME_CLOSURES (src/lotuspod/cli.py); a minifier never
// renames its free names. Reading each as the bundle loads makes a missing
// name throw on every page at once.

// What js/live-page.js keeps of the page's revision while it is open.
export interface Live {
  // A revision the page learned it is now published at; once it is not its
  // own, the page offers a reload.
  seen(revision: unknown): void;
  // The revision the page shows now: its own, then each one a swap brought
  // in (web/src/page-swap.ts); "" on a page with none.
  revision(): string;
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
  // True once the page's answers are read, set before ANSWERED is sent;
  // after a swap, whether its read of them was.
  read: boolean;
}

// js/comments.js publishes the page start; the island supplies its parts.
declare const commenting: Commenting | null;
// js/page-open.js: shell text, storage keys and the whole-page section id.
declare const CLOSED: string;
declare const PANEL: string;
declare const RESOLVED_SHOWN: string;
declare const WHOLE_PAGE: string;
declare const CHANGED_GROUP: string;
declare const COMMENTS: string;
declare const ROOM: number;
declare const POPOVER: string;
declare function overText(the: NarrowBridge): import("./comments/parts").Over;

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
// the page's read of answers has finished, and again once each read after a
// swap that changed a decision form is drawn; SAVED on a decision form once
// an answer to it is saved, DRAWN on a comment box when rows are drawn into
// it.
declare const ANSWERED: string;
declare const SAVED: string;
declare const DRAWN: string;

declare function commentMarkdown(node: HTMLDivElement, text: string): HTMLDivElement;
declare function commentImages(row: CommentRow): HTMLUListElement | null;
declare function when(stamp: string | undefined): string;

declare function json<T = CommentRow & CommentPayload>(response: Response): Promise<T | null>;
declare function attachments(form: HTMLFormElement, field: HTMLTextAreaElement): Attachments;
declare const SIGNED_OUT: string;
declare const STALE_PAGE: string;
declare const STALE_SECTION: string;
// js/page-open.js: the heading of the list of threads on sections the page
// no longer has.
declare const CHANGED: string;
// js/attachments.js: what the comments route's read said of the image cap,
// bytes or null with why, and why no cap was read.
declare function settleImageCap(bytes: number | null, why?: string): void;
declare const NO_CAP: string;
// js/attachments.js: "1 image" or "N images", what a comment of images alone
// says in a list.
declare function imageWords(row: CommentRow): string;
// js/page-open.js: the elements selector matches in node, else the page.
declare function all(selector: string, node?: HTMLElement): HTMLElement[];

export const page = Object.freeze({
  element, textModel, offsetOf, pieces, locate, wrap, unwrap,
  apart: APART, maxExact: MAX_EXACT, context: CONTEXT, still: STILL, coarse: COARSE,
  attachments, json, settleImageCap, noCap: NO_CAP, imageWords, all, changed: CHANGED,
  signedOut: SIGNED_OUT, stalePage: STALE_PAGE, staleSection: STALE_SECTION,
  commentMarkdown, commentImages, when,
  commenting,
  room: ROOM,
  popover: POPOVER,
  overText,
  closed: CLOSED,
  panelKey: PANEL,
  resolvedShownKey: RESOLVED_SHOWN,
  wholePage: WHOLE_PAGE,
  changedGroup: CHANGED_GROUP,
  commentsURL: COMMENTS,
  live,
  forms,
  answering,
  linkedTo,
  archived: ARCHIVED,
  events: Object.freeze({ answered: ANSWERED, saved: SAVED, drawn: DRAWN }),
});

export type Page = typeof page;

// State still owned by comments.js. The list reads the same objects that
// polling, passages and swaps update; it does not keep a second thread store.
export interface CommentRow {
  id: number;
  actor?: { kind?: string; handle?: string; name?: string };
  owner?: string;
  model?: string;
  createdAt?: string;
  revision?: string | number;
  reason?: string;
  answer?: { label?: string; choice?: string } | null;
  images?: unknown[];
  section?: string;
  quote?: { exact?: string; prefix?: string; suffix?: string } | null;
  question?: string | number | null;
  sectionTitle?: string;
  text?: string;
  state?: string;
}
export interface Resolution { resolved: boolean }
export interface Thread {
  list: HTMLOListElement;
  root: CommentRow;
  replies: CommentRow[];
  resolution: Resolution | null;
  box: HTMLElement | null;
  node: HTMLDivElement;
  n: number;
  spot?: TextSpot | null;
  number?: HTMLButtonElement | null;
  head?: HTMLElement;
  headKey?: string;
  marks: HTMLElement[];
  lit: boolean;
  entry: import("./comments/parts").Entry | null;
}
export interface Decision { form: HTMLFormElement; name: string; question: string }
export interface CommentPayload { resolution?: Resolution; error?: unknown }
export interface ThreadListBridge {
  all(selector: string, node: HTMLElement): HTMLElement[];
  boxes: HTMLElement[];
  shown: Map<number, Thread>;
  forms: Map<HTMLElement, HTMLFormElement>;
  decisions: HTMLFormElement[];
  page: string;
  rows(thread: Thread): CommentRow[];
  resolved(thread: Thread): boolean;
  agent(row: CommentRow): string;
  routed(row: CommentRow): string;
  threadsOf(box: HTMLElement): Thread[];
  decisionOf(thread: Thread): Decision | null;
  passages: Pick<import("./comments/parts").Passages, "said" | "key" | "point" | "detached" | "shine">;
  imageWords(row: CommentRow): string;
  looked(thread: Thread, viewed: boolean): void;
  refresh(): void;
  failure(response: Response, payload: CommentPayload | null): string;
  json(response: Response): Promise<CommentPayload | null>;
  wide(): boolean;
  moving(): boolean;
  holds(thread: Thread): boolean;
  uncover(node: HTMLElement): void;
  bring(thread: Thread): void;
}

// Placement reads live page-owned stores; swaps mutate these same maps.
export interface PlacementBridge extends Omit<ThreadListBridge,
  "wide" | "moving" | "holds" | "uncover" | "bring" | "passages"> {
  sections: Map<string, HTMLElement>;
  passages: ThreadListBridge["passages"] & Pick<import("./comments/parts").Passages, "place" | "cancel">;
  showUnread(): void;
  changed(): HTMLElement;
  author(row: CommentRow): string;
  unreadIn(threads: Thread[]): number;
}

// The object narrow.js consumes. It retains ownership of its surfaces and
// moves the list's independent roots through this synchronous contract.
export interface NarrowBridge extends Pick<import("./comments/parts").ThreadList,
  "compose" | "unresolvedOf" | "ordered" | "latest" | "standing" | "asked" |
  "said" | "tick" | "title" | "opening"> {
  panel: import("./comments/parts").Placement;
  groups: Map<HTMLElement, import("./comments/parts").Group>;
  passages: PlacementBridge["passages"];
  mute(node: HTMLElement): HTMLElement;
  threadsOf: ThreadListBridge["threadsOf"];
  resolved: ThreadListBridge["resolved"];
  routed: ThreadListBridge["routed"];
  decisionOf: ThreadListBridge["decisionOf"];
  anchorOf(thread: Thread): HTMLElement | null;
  unfold(target: HTMLElement): void;
  barBottom(): number;
  standsFor(box: HTMLElement): HTMLElement | null;
}

// What the store reaches comments.js by: the boxes and decision forms,
// which swaps change in place, and the unread replies, drafts and the
// box a form stands for, which comments.js still owns.
export interface StoreBridge {
  boxes: HTMLElement[];
  decisions: HTMLFormElement[];
  counted(thread: Thread, row: CommentRow): boolean;
  opening: Map<number, Set<number>>;
  unreadIn(threads: Thread[]): number;
  readTo(thread: Thread, id: number): void;
  looked(thread: Thread, open: boolean): void;
  showUnread(): void;
  // A read named the comments unread to the reader, or did not.
  named(unread: unknown): void;
  // Give back what was kept over a reload, once the threads are read.
  restore(): void;
  boxWith(form: HTMLFormElement): HTMLElement | null;
}

export interface ThreadBridge {
  owner: string;
  page: string;
  checking(): boolean;
  counted(thread: Thread, row: CommentRow): boolean;
  opening: Map<number, Set<number>>;
  label(thread: Thread, row: CommentRow): void;
}

export interface StoredImage { name: string; width: number; height: number }
export interface Attachments {
  kept(): StoredImage[];
  busy(): boolean;
  held(): boolean;
  restore(images: unknown): string;
  sending(): string[];
  sent(saved: boolean): void;
  pass(to: Attachments): string;
  adopt(file: File, done: Promise<{ image: StoredImage | null; why: string }>): string;
  take(files: File[]): void;
}
export interface ComposerBridge {
  page: string;
  revision(): string | null;
  attached: Map<HTMLFormElement, Attachments>;
  forms: Map<HTMLElement, HTMLFormElement>;
  sending: Map<HTMLFormElement, Promise<CommentRow | null>>;
  boxWith(form: HTMLFormElement): HTMLElement | null;
  rows(thread: Thread): CommentRow[];
  agent(row: CommentRow): string;
  routed(row: CommentRow): string;
  readTo(thread: Thread, id: number): void;
  merge(thread: Thread, rows: CommentRow[]): void;
  posted(): void;
  add(entry: { root: CommentRow; replies: CommentRow[] }): void;
  shown: Map<number, Thread>;
  placement(): import('./comments/parts').Placement;
}

// Chips read live stores and delegate opening to placement.
export interface ChipsBridge extends Pick<PlacementBridge,
  "boxes" | "decisions" | "shown" | "threadsOf" | "decisionOf" | "resolved" |
  "rows" | "author" | "agent" | "routed" | "unreadIn"> {
  list: Pick<import("./comments/parts").ThreadList, "latest" | "standing" | "asked" | "plural">;
  chipped(box: HTMLElement): void;
  reach(thread: Thread, opener: HTMLElement | null, read: boolean): void;
}

export type PassageQuote = NonNullable<CommentRow["quote"]>;
export interface TextSpot { start: number; end: number }
export interface TextModel { text: string; nodes: Text[]; spots: Map<Node, Int32Array> }
declare function textModel(root: HTMLElement | null): TextModel;
declare function offsetOf(model: TextModel, container: Node, offset: number): number;
declare function pieces(model: TextModel, start: number, end: number): { node: Text; from: number; to: number }[];
declare function locate(model: TextModel, quote: PassageQuote): TextSpot | null;
declare function wrap(root: HTMLElement | null, start: number, end: number, make: () => HTMLElement): HTMLElement[];
declare function unwrap(wrappers: HTMLElement[]): void;
declare const APART: string;
declare const MAX_EXACT: number;
declare const CONTEXT: number;
declare const STILL: number;
declare const COARSE: string;

export interface PassagesBridge {
  article: HTMLElement | null;
  boxes: HTMLElement[];
  shown: Map<number, Thread>;
  resolved(thread: Thread): boolean;
  revision(): string | null;
  attached: Map<HTMLFormElement, Attachments>;
  composer: Pick<ReturnType<typeof import('./comments/composer').composers>, 'passage'>;
  placement(): import('./comments/parts').Placement;
}

// shared.js: the imperative DOM helper, also used by page-owned UI.
declare function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K];
