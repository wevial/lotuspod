import { signal } from "@preact/signals";

// What the title bar's count opens: the element named by id, which open
// shows, opener taking the focus back when the bottom sheet closes.
export interface Opens {
  id: string;
  open(opener: HTMLElement): void;
}

// The count opens the panel's Decisions tab with decide, else the bottom
// sheet's with sheet.
export function opensIn(panel: boolean, decide: () => void, sheet: (opener: HTMLElement) => void): Opens {
  return panel ? { id: "artifact-comments-decisions", open: decide } :
    { id: "artifact-comments-bottom-sheet-decisions", open: sheet };
}

// Where the comments panel's Decisions tab meets the decisions island. The
// island says whether the page asks questions (asks), and how many are to
// answer once its answers are read (count, null until then); the shell gives
// it the tab's panel to draw into (node), once the shell is drawn; and the
// shell, or the bottom sheet without room for it, says how the title bar's
// count opens the questions (opens).
export const decisionsTab = {
  asks: signal(false),
  count: signal<number | null>(null),
  node: signal<HTMLElement | null>(null),
  opens: signal<Opens | null>(null),
};

// Where the comments panel's History tab meets the history island. The
// island says whether the page lists its versions (shown, once the versions
// route answers with a list), and how many sections "Since you last looked"
// lists while they are not marked seen (unseen, 0 otherwise); the shell gives
// it the tab's panel to draw into (node), once the shell is drawn.
export const historyTab = {
  shown: signal(false),
  unseen: signal(0),
  node: signal<HTMLElement | null>(null),
};

// What the bottom sheet's tabs read: whether it has a Decisions tab, once
// the answers are read on a page that asks questions; how many are to
// answer; and the node whose children it moves in to show them. Likewise
// for its History tab: whether it has one, how many sections changed
// unseen, and the node whose children it moves in.
export interface SheetTabs {
  asks(): boolean;
  count(): number | null;
  node(): HTMLElement | null;
  history(): boolean;
  unseen(): number;
  historyNode(): HTMLElement | null;
}

export const sheetTabs: SheetTabs = {
  asks: () => decisionsTab.asks.peek() && decisionsTab.count.peek() !== null,
  count: () => decisionsTab.count.peek(),
  node: () => decisionsTab.node.peek(),
  history: () => historyTab.shown.peek(),
  unseen: () => historyTab.unseen.peek(),
  historyNode: () => historyTab.node.peek(),
};
