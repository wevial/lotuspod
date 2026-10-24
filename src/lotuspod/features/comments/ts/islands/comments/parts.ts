import type { Thread } from "../bridge";
import type { threadList } from "./thread-list";

export interface Section {
  box: HTMLElement;
  title: string;
  id: number;
  section: string;
}
export interface Tally {
  open: { id: number; standing: "answered" | "writing" | "waiting" | "failed" }[];
  resolved: number;
  none: boolean;
}
// The comments panel's tabs, on a page that asks questions.
export type Tab = "decisions" | "comments";
export interface ShellHooks {
  opened(): void;
  resolvedChanged(): void;
  compose(box: HTMLElement): void;
}
export interface Shell {
  readonly list: HTMLDivElement;
  // Whether the threads are in view: the panel open on its Comments tab.
  isOpen(): boolean;
  resolvedShown(): boolean;
  // Open or fold the panel; opened, it shows tab, Comments unless named.
  setOpen(show: boolean, remember: boolean, tab?: Tab): void;
  setResolvedShown(show: boolean, remember: boolean): void;
  hidden(hide: boolean): void;
  sections(sections: Section[]): void;
  refresh(tally: Tally): void;
  empty(none: boolean): void;
  unpick(focus: boolean): void;
  unlit(): void;
  focus(control: "fold" | "opener" | "resolved" | "decisions" | HTMLElement): void;
}
export interface ComposerHandles {
  field: HTMLTextAreaElement;
  form: HTMLFormElement;
  unfold(open: boolean): void;
  images: import('../bridge').Attachments;
}
// The comment threads and the reads that fill them (comments/store.ts),
// as the drafts reach them (comments/drafts.ts): drafts kept over a reload
// and swaps.
export interface Store {
  readonly sections: Map<string, HTMLElement>;
  readonly shown: Map<number, Thread>;
  readonly forms: Map<HTMLElement, HTMLFormElement>;
  readonly attached: Map<HTMLFormElement, import("../bridge").Attachments>;
  readonly composer: Pick<ReturnType<typeof import("./composer").composers>, "sending" | "wire" | "fieldOf" | "handles" | "on" | "unblock">;
  readonly panel: Placement;
  readonly passages: Passages;
  // A swap moved the page on to revision to.
  swapped(to: string): void;
  // A swap gave the tab a new title.
  retitle(): void;
  enlist(box: HTMLElement): void;
  ask(): void;
  boxFor(root: import("../bridge").CommentRow): HTMLElement | null;
  whereFrom(root: import("../bridge").CommentRow): HTMLParagraphElement;
  put(thread: Thread): void;
  refresh(): void;
  // A section's form opens on a live block, as its Comment opens it (one
  // restoring a draft opens only on a wide window): that section's box,
  // else null.
  holdOn(anchor: import("../bridge").Widget, restoring?: boolean): HTMLElement | null;
  // The box of the section a live block is in now, else null.
  blockBox(anchor: import("../bridge").Widget): HTMLElement | null;
  start(): void;
}

export interface Group {
  optionId: number;
  node: HTMLElement;
  heading: HTMLHeadingElement;
  entries: HTMLOListElement;
  box: HTMLElement | null;
  toggle: HTMLButtonElement;
  holder: HTMLDivElement;
}
export interface Entry {
  item: HTMLLIElement;
  head: HTMLButtonElement;
  body: HTMLDivElement;
  resolve: HTMLButtonElement;
  reopen: HTMLButtonElement;
  status: HTMLParagraphElement;
}

export type ThreadList = ReturnType<typeof threadList>;
export type Mode = "panel" | "popover" | "sheet";
export interface Passage {
  holder: HTMLElement;
  marks: HTMLElement[];
}
// The narrow renderer reads exactly one of these destinations at a time.
export type View =
  | { thread: Thread; box?: never; passage?: never }
  | { box: HTMLElement; thread?: never; passage?: never }
  | { passage: Passage; thread?: never; box?: never };
export interface Taken {
  view: View | null;
  opener: HTMLElement | null;
  anchor: HTMLElement | null;
  writing: Group | null;
  scroll?: number;
  still?: boolean;
}
export interface Kept {
  thread?: number;
  section?: string;
  writing?: boolean;
}
export interface Over {
  holds(thread: Thread): boolean;
  entries(): HTMLOListElement | null;
  sync(): void;
  uncover(node: HTMLElement): void;
  show(view: View, opener: HTMLElement | null): void;
  chip(box: HTMLElement): void;
  passage(mine: Passage): void;
  dropped(mine: Passage): void;
  started(thread: Thread, focused: boolean): void;
  posted(thread: Thread, focused: boolean): void;
  refit(): void;
  peek(): Taken;
  take(): Taken;
  mode(mode: Mode): void;
  restore(taken: Taken): void;
}
export interface Placement {
  wide: boolean;
  mode: Mode | null;
  refresh(): void;
  arrange(): void;
  held(): Kept | null;
  reopen(kept: Kept): void;
  take(olds: HTMLElement[]): Taken | null;
  give(taken: Taken | null): void;
  replace(old: HTMLElement, box: HTMLElement): void;
  unmount(old: HTMLElement, at: number): void;
  mount(box: HTMLElement, at: number): void;
  remounted(): void;
  forget(form: HTMLFormElement): void;
  reach(thread: Thread): void;
  asked(thread: Thread | undefined): void;
  posted(box: HTMLElement, thread: Thread | undefined): void;
  started(thread: Thread | undefined, focused: boolean): void;
  open(thread: Thread): void;
  // Open box's form for a new thread, as a live block's Comment does, from
  // opener.
  write(box: HTMLElement, opener: HTMLElement): void;
  compose(box: HTMLElement, holder: HTMLElement): void;
  put(thread: Thread): void;
  lit(thread: Thread): boolean;
  show: Over["show"];
  passage: Over["passage"];
  dropped: Over["dropped"];
}

export interface PassageDraft {
  quote?: import('../bridge').PassageQuote;
  section?: string;
  index?: number;
  text?: string;
  images?: unknown;
  held?: boolean;
  from?: import('../bridge').Attachments;
  box?: HTMLElement;
  saving?: Promise<import('../bridge').CommentRow | null> | null;
}
export interface Passages {
  detached(thread: Thread): boolean;
  said(thread: Thread): HTMLElement[];
  key(thread: Thread): string;
  shine(thread: Thread): void;
  point(thread: Thread | null, where: 'page' | 'entry'): void;
  update(): void;
  place(): void;
  cancel(mine: Passage): void;
  writing(): PassageDraft | null;
  reopen(kept: PassageDraft): boolean;
  moved(): void;
  writes(nodes: HTMLElement[]): boolean;
  swept(): PassageDraft | null;
}
