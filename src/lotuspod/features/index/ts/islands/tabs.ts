import { focusTab } from "./focus";
import { write } from "./fragment";
import { frameOf } from "./frames";
import { askSeen, markSeen } from "./seen";
import { activated, closed, moved, opened, pods, state, type Tab } from "./state";
import { tabOf } from "./strip";

// The island's actions: each writes the state, which draws the strip and
// the frames at once, then writes the address and reads the seen route as
// the change asks.

// The pod's tab added just after the active one, its frame at the address
// its listing link gives with the fragment.
export function add(name: string, hash: string): void {
  const { title, href } = pods.get(name)!;
  opened(name, title, href + hash);
}

// Activating a tab first posts the framed page's revision, so what it shows
// counts as read.
export function activate(name: string): void {
  activated(name);
  write();
  tabOf(name)?.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  markSeen(name, frameOf(name));
}

// Each time the listing shows again, the index's own script is told, so it
// reads its marks and counts again.
export function showListing(): void {
  activated(null);
  write();
  askSeen();
  document.dispatchEvent(new CustomEvent("lotuspod:listing"));
}

// The tab closed, its right neighbour activated if it was active, else its
// left, else the listing.
export function close(name: string): void {
  const at = closed(name);
  if (at < 0) return;
  if (name === state.active.value) {
    const tabs = state.tabs.value;
    const next = tabs[at] ?? tabs[at - 1] ?? null;
    if (next) activate(next.name);
    else showListing();
  } else {
    write();
    askSeen();
  }
  const now = state.active.value === null ? null : tabOf(state.active.value);
  if (now) focusTab(now.title);
  else document.getElementById("index-search")?.focus();
}

// The tab at from moved to to, its title focused again: a node put back in
// place loses focus. The active tab and the dots stay as they were.
export function move(from: number, to: number): Tab {
  const focused = document.activeElement;
  const tab = moved(from, to);
  write();
  const nodes = tabOf(tab.name);
  if (focused && nodes && nodes.tab.contains(focused)) focusTab(nodes.title);
  return tab;
}
