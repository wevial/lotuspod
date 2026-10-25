// Islands reach the legacy closure only through page. The bundle follows
// comment-markdown.js inside THEME_CLOSURES (src/lotuspod/core/__init__.py);
// a minifier never renames its free names. Reading each as the bundle loads
// makes a missing name throw on every page at once.

// What features/live/ts/live-page.js keeps of the page's revision while it is
// open.
export interface Live {
  // A revision the page learned it is now published at; once it is not its
  // own, the page offers a reload.
  seen(revision: unknown): void;
  // The revision the page shows now: its own, then each one a swap brought
  // in (features/live/ts/page-swap.ts); "" on a page with none.
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

// features/publish/ts/page-open.js: shell text, storage keys and the whole-page
// section id.
declare const CLOSED: string;
declare const PANEL: string;
declare const RESOLVED_SHOWN: string;
declare const WHOLE_PAGE: string;
declare const CHANGED_GROUP: string;
declare const COMMENTS: string;
declare const ROOM: number;
declare const POPOVER: string;
declare function overText(the: NarrowBridge | QuestionsBridge): import("./comments/parts").Over;

// features/live/ts/live-page.js.
declare const live: Live;
// features/publish/ts/page-open.js: what the address's fragment gives name as
// #NAME=VALUE, decoded, else null; read as the page opens (first), null on a
// reload.
declare function linkedTo(name: string, first?: boolean): string | null;
// features/publish/ts/page-open.js: an archived page takes no new comment,
// reply or answer.
declare const ARCHIVED: boolean;
// features/widgets/ts/widgets.ts: what a live block's Comment button calls, set
// here once the comments island can start a thread on a block.
declare var startComment: StartComment | undefined;
// features/publish/ts/page-open.js: the page events. ANSWERED is sent on the
// document once the page's read of answers has finished, and again once each
// read after a swap that changed a decision form is drawn; SAVED on a decision
// form once an answer to it is saved, DRAWN on a comment box when rows are
// drawn into it.
declare const ANSWERED: string;
declare const SAVED: string;
// features/publish/ts/page-open.js: the answers route, what an answer to a
// question the page has changed since it loaded is refused with, and the
// Answered table's key among the folded sections.
declare const ANSWERS: string;
declare const STALE: string;
declare const FOLDED_ANSWERED: number;
// features/publish/ts/page-open.js: fold a section's wrapper under its
// heading's button, kept as id.
declare function foldSection(heading: HTMLElement, wrapper: HTMLElement, id: string | number): void;
// features/publish/ts/page-open.js: a reader's name, else a handle; never an
// address.
declare function reader(row: { actor?: CommentRow["actor"] } | null): string;
declare const DRAWN: string;
// features/publish/ts/page-open.js: sent on the document once a swap is
// applied.
declare const SWAPPED: string;
// features/live/ts/page-swap.ts: hold back from a swap each part whose nodes
// test says to, told whether the new revision took the part away.
declare function holdSwap(test: (nodes: readonly Element[], removed: boolean) => boolean): void;
// features/publish/ts/page-open.js: what a draft whose place a new revision
// dropped says on the form it went to: a passage's words gone, or any other
// place.
declare const PASSAGE_GONE: string;
declare const PLACE_GONE: string;
// features/publish/ts/page-open.js: what a comment begun on a live block says
// on its section's form when the page reloaded without the block.
declare const BLOCK_GONE: string;
// features/publish/ts/page-open.js: what a section's form on a live block says
// when a swap changed the block under it (the comment stays on the version the
// reader saw), and when a send was refused for a block the
// page has changed since it loaded.
declare const BLOCK_CHANGED: string;
declare const STALE_BLOCK: string;

declare function commentMarkdown(node: HTMLDivElement, text: string): HTMLDivElement;
declare function commentImages(row: CommentRow): HTMLUListElement | null;
declare function when(stamp: string | undefined): string;
// core/ts/shared.js: the page as its URL names it.
declare function pageName(): string;
// features/history/ts/version-menu.js, joined after the bundle; a function
// declaration, so defined as the bundle loads: the "▾" button and the menu of
// a page's versions, with the commit shown and the one the reader last
// looked at, and close(), which closes the menu.
declare function versionMenu(
  versions: readonly { commit: string; date: string; summary?: unknown; current?: unknown }[],
  page: string, shown: string | null, seen: string | null, old?: boolean,
): { button: HTMLButtonElement; menu: HTMLDivElement; close(focus: boolean): void };

declare function json<T = CommentRow & CommentPayload>(response: Response): Promise<T | null>;
declare function attachments(form: HTMLFormElement, field: HTMLTextAreaElement): Attachments;
declare const SIGNED_OUT: string;
// features/publish/ts/page-open.js: what a decision's Ask says with no question
// in its note, and when the page changed since it loaded.
declare const NO_QUESTION: string;
declare const STALE_QUESTION: string;
declare const STALE_PAGE: string;
declare const STALE_SECTION: string;
// features/publish/ts/page-open.js: the heading of the list of threads on
// sections the page no longer has.
declare const CHANGED: string;
// features/comments/ts/attachments.js: what the comments route's read said of
// the image cap, bytes or null with why, and why no cap was read.
declare function settleImageCap(bytes: number | null, why?: string): void;
declare const NO_CAP: string;
// features/comments/ts/attachments.js: "1 image" or "N images", what a comment
// of images alone says in a list.
declare function imageWords(row: CommentRow): string;
// features/publish/ts/page-open.js: the elements selector matches in node, else
// the page.
declare function all(selector: string, node?: HTMLElement): HTMLElement[];

export const page = Object.freeze({
  element, textModel, offsetOf, pieces, locate, wrap, unwrap,
  apart: APART, maxExact: MAX_EXACT, context: CONTEXT, still: STILL, coarse: COARSE,
  attachments, json, settleImageCap, noCap: NO_CAP, imageWords, all, changed: CHANGED,
  signedOut: SIGNED_OUT, stalePage: STALE_PAGE, staleSection: STALE_SECTION,
  noQuestion: NO_QUESTION, staleQuestion: STALE_QUESTION,
  commentMarkdown, commentImages, when, pageName, versionMenu,
  holdSwap,
  passageGone: PASSAGE_GONE,
  placeGone: PLACE_GONE,
  blockGone: BLOCK_GONE,
  blockChanged: BLOCK_CHANGED,
  staleBlock: STALE_BLOCK,
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
  linkedTo,
  answersURL: ANSWERS,
  stale: STALE,
  foldedAnswered: FOLDED_ANSWERED,
  foldSection,
  reader,
  archived: ARCHIVED,
  // Publish start as what a live block's Comment calls (startComment), on
  // a page that takes new comments; an archived page's blocks have none.
  startComment(start: StartComment): void {
    if (!ARCHIVED) startComment = start;
  },
  events: Object.freeze({ answered: ANSWERED, saved: SAVED, drawn: DRAWN, swapped: SWAPPED }),
});

export type Page = typeof page;

// A live block's address as a thread's first comment stores it (widget):
// its id, its widget file's hash and the state its widget showed.
export interface Widget { id: string; hash: string; state: string }
export type StartComment = (request: { anchor: { kind: "block" } & Widget }) => void;

// One part of the page a swap changed (features/live/ts/page-swap.ts): the
// header, the outline, the intro, a section or the references block, with the
// nodes it took out, detached, and put in.
export interface SwappedUnit {
  kind: "header" | "outline" | "intro" | "section" | "refs";
  id: string;
  change: "changed" | "added" | "removed";
  before: Node[];
  after: Node[];
}
// SWAPPED's detail: the revision the page now shows, and each part changed.
export interface Swapped { revision: string; units: SwappedUnit[] }

// The thread state the parts share. The list reads the same objects that
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
  widget?: Widget | null;
  sectionTitle?: string;
  text?: string;
  state?: string;
}
export interface Resolution { resolved: boolean }
// What SAVED tells of an answer saved: the comment its note opened or
// added to a thread with, if any.
export interface Saved { comment?: unknown }
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
  // The box's form for a new thread is no longer on a live block.
  unblock(box: HTMLElement): void;
  // Whether the box's form for a new thread holds text or images.
  unsent(box: HTMLElement): boolean;
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
  // Whether the page's first read of its threads has finished.
  settled(): boolean;
}

// The object narrow.js consumes. It retains ownership of its surfaces and
// moves the list's independent roots through this synchronous contract.
export interface NarrowBridge extends Pick<import("./comments/parts").ThreadList,
  "compose" | "unresolvedOf" | "ordered" | "latest" | "standing" | "asked" |
  "said" | "tick" | "title" | "opening"> {
  // The page takes comments: the sheet holds threads, and its Comments tab.
  comments: true;
  tabs: import("./comments/tabs").SheetTabs;
  panel: import("./comments/parts").Placement;
  groups: Map<HTMLElement, import("./comments/parts").Group>;
  passages: PlacementBridge["passages"];
  mute(node: HTMLElement): HTMLElement;
  threadsOf: ThreadListBridge["threadsOf"];
  resolved: ThreadListBridge["resolved"];
  routed: ThreadListBridge["routed"];
  decisionOf: ThreadListBridge["decisionOf"];
  anchorOf(thread: Thread): HTMLElement | null;
  // The title and state of the live block a thread is on, else null.
  blockOf(thread: Thread): { title: string; state: string } | null;
  unfold(target: HTMLElement): void;
  barBottom(): number;
  standsFor(box: HTMLElement): HTMLElement | null;
}

// What overText reads on a page that takes no comments, where the sheet
// holds only the questions and never a thread.
export interface QuestionsBridge extends Pick<NarrowBridge, "tabs" | "mute" | "unfold" | "barBottom"> {
  comments: false;
  panel: Pick<import("./comments/parts").Placement, "mode">;
}

// What the store reaches the drafts (comments/drafts.ts) by: the boxes and
// decision forms, which swaps change in place, and the drafts and the box a
// form stands for, which the drafts own.
export interface StoreBridge {
  boxes: HTMLElement[];
  decisions: HTMLFormElement[];
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
  "rows" | "author" | "agent" | "routed" | "unreadIn" | "settled"> {
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
