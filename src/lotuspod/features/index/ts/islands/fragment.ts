import { state } from "./state";

// #tabs=NAME,NAME&on=NAME&at=FRAGMENT&view=activity, each part but the first
// optional; &at= is only ever read.
export const FRAGMENT = /^#tabs=([^&]*)(?:&on=([^&]*)(?:&at=([^&]*))?)?(?:&view=activity)?$/;

// The fragment the address had before any tab was open, for an index with
// no views to switch. Under the tabs' fragment it was loaded with, that is
// none.
let before = FRAGMENT.test(location.hash) ? "" : location.hash;

// The view the index's own script shows, "pages" or "activity"; null while
// it has no views to switch.
function viewShown(): string | null {
  const pressed = document.querySelector<HTMLElement>('.index-views button[aria-pressed="true"]');
  return pressed ? pressed.dataset.view ?? null : null;
}

export function write(): void {
  if (!FRAGMENT.test(location.hash)) before = location.hash;
  // Until the views can be switched, the view the address names stays.
  const view = viewShown() ||
    (FRAGMENT.test(location.hash) && location.hash.endsWith("&view=activity") ? "activity" : null);
  let fragment = view === null ? before : view === "activity" ? "#activity" : "";
  const tabs = state.tabs.value;
  if (tabs.length) {
    fragment = `#tabs=${tabs.map((tab) => encodeURIComponent(tab.name)).join(",")}`;
    if (state.active.value !== null) fragment += `&on=${encodeURIComponent(state.active.value)}`;
    if (view === "activity") fragment += "&view=activity";
  }
  history.replaceState(history.state, "", location.pathname + location.search + fragment);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}

// What the address the index loaded at names: its tabs in order, the
// active one and the fragment that one opens at; null without the tabs'
// fragment.
export function loadedAt(): { names: string[]; on: string | null; at: string } | null {
  const named = FRAGMENT.exec(location.hash);
  if (!named) return null;
  return {
    names: named[1]!.split(",").map(decode),
    on: named[2] === undefined ? null : decode(named[2]),
    at: named[3] === undefined ? "" : decode(named[3]),
  };
}
