import type { PlacementBridge, Thread, ThreadBridge } from "../bridge";
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
export interface ShellHooks {
  opened(): void;
  resolvedChanged(): void;
  compose(box: HTMLElement): void;
}
export interface Shell {
  readonly list: HTMLDivElement;
  isOpen(): boolean;
  resolvedShown(): boolean;
  setOpen(show: boolean, remember: boolean): void;
  setResolvedShown(show: boolean, remember: boolean): void;
  hidden(hide: boolean): void;
  sections(sections: Section[]): void;
  refresh(tally: Tally): void;
  empty(none: boolean): void;
  unpick(focus: boolean): void;
  unlit(): void;
  focus(control: "fold" | "opener" | "resolved" | HTMLElement): void;
}
export interface Parts {
  thread(bridge: ThreadBridge): ReturnType<typeof import("./thread").threadRows>;
  placement(bridge: PlacementBridge): Placement;
}
export interface Commenting {
  start(parts: Parts): void;
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
  compose(box: HTMLElement, holder: HTMLElement): void;
  put(thread: Thread): void;
  lit(thread: Thread): boolean;
  show: Over["show"];
  passage: Over["passage"];
  dropped: Over["dropped"];
}
