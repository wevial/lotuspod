import { batch, signal, type ReadonlySignal } from "@preact/signals";

// A pod the listing has: its title and its link.
export interface Listed {
  readonly title: string;
  readonly href: string;
}

// An open pod's tab: the pod's name and the title it shows.
export interface Tab {
  readonly name: string;
  readonly title: string;
}

// An open pod's frame: the pod's name and the address it was opened at.
export interface Frame {
  readonly name: string;
  readonly src: string;
}

// A page's entry in the seen route's answer.
export interface SeenEntry {
  readonly seen?: unknown;
  readonly revision?: unknown;
  readonly replies?: unknown;
}

export type Seen = Readonly<Record<string, SeenEntry | undefined>>;

// The open pods' tabs in strip order and their frames in the order they
// were opened, which a move leaves as it is; the active pod's name, null
// while the listing shows; the seen route's pages as last answered 200,
// else null; and what the live region last said.
const tabs = signal<readonly Tab[]>([]);
const frames = signal<readonly Frame[]>([]);
const active = signal<string | null>(null);
const seen = signal<Seen | null>(null);
const said = signal("");

export const state: {
  readonly tabs: ReadonlySignal<readonly Tab[]>;
  readonly frames: ReadonlySignal<readonly Frame[]>;
  readonly active: ReadonlySignal<string | null>;
  readonly seen: ReadonlySignal<Seen | null>;
  readonly said: ReadonlySignal<string>;
} = { tabs, frames, active, seen, said };

// Each pod the listing has, by name: read again whenever the listing's rows
// are swapped in, and added to by the finder's choice.
export const pods = new Map<string, Listed>();

export function readPods(): void {
  pods.clear();
  for (const row of document.querySelectorAll<HTMLTableRowElement>(".index-table tbody tr[data-page]")) {
    const link = row.cells[0] ? row.cells[0].querySelector("a[href]") : null;
    if (link) pods.set(row.dataset.page ?? "", { title: (link.textContent ?? "").trim(), href: link.getAttribute("href") ?? "" });
  }
}

export function isOpen(name: string): boolean {
  return tabs.value.some((tab) => tab.name === name);
}

// The pod's tab just after the active one, else last, and its frame after
// every other.
export function opened(name: string, title: string, src: string): void {
  const at = active.value === null ? -1 : tabs.value.findIndex((tab) => tab.name === active.value);
  const next = tabs.value.slice();
  next.splice(at < 0 ? next.length : at + 1, 0, { name, title });
  batch(() => {
    tabs.value = next;
    frames.value = [...frames.value, { name, src }];
  });
}

// The pod's tab and frame gone; where its tab was, else -1.
export function closed(name: string): number {
  const at = tabs.value.findIndex((tab) => tab.name === name);
  if (at < 0) return -1;
  batch(() => {
    tabs.value = tabs.value.filter((tab) => tab.name !== name);
    frames.value = frames.value.filter((frame) => frame.name !== name);
  });
  return at;
}

// The tab at from put at to; it is given back.
export function moved(from: number, to: number): Tab {
  const next = tabs.value.slice();
  const [tab] = next.splice(from, 1);
  next.splice(to, 0, tab!);
  tabs.value = next;
  return tab!;
}

export function activated(name: string | null): void {
  active.value = name;
}

export function answered(pages: Seen | null): void {
  seen.value = pages;
}

// Each open tab titled with its pod's title.
export function retitled(): void {
  tabs.value = tabs.value.map((tab) => {
    const title = pods.get(tab.name)?.title ?? tab.title;
    return title === tab.title ? tab : { name: tab.name, title };
  });
}

export function told(words: string): void {
  said.value = words;
}
