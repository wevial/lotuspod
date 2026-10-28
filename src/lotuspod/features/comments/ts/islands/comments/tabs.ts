import { computed, signal } from "@preact/signals";

// What a control in the title bar opens: the element named by id, which
// open shows, opener taking the focus back when the bottom sheet closes.
export interface Opens {
  id: string;
  open(opener: HTMLElement): void;
}

// The panel's tab opens with inPanel, else the bottom sheet's with sheet.
export function opensIn(tab: "decisions" | "history", panel: boolean, inPanel: () => void,
  sheet: (opener: HTMLElement) => void): Opens {
  return panel ? { id: "artifact-comments-" + tab, open: inPanel } :
    { id: "artifact-comments-bottom-sheet-" + tab, open: sheet };
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
// it the tab's panel to draw into (node), once the shell is drawn; and the
// shell, or the bottom sheet without room for it, says how the title bar's
// "N changed" and the header's "Versions · N" open the tab (opens), null on a
// page with no comments panel. History is in view (selected) while the panel
// shows it, as the shell says (inPanel), or the bottom sheet holds it, as
// the sheet says through sheetTabs.
const inSheet = signal(false);
const inPanel = signal(false);
export const historyTab = {
  shown: signal(false),
  unseen: signal(0),
  node: signal<HTMLElement | null>(null),
  opens: signal<Opens | null>(null),
  inPanel,
  selected: computed(() => inPanel.value || inSheet.value),
};

// What the bottom sheet's tabs read: whether it has a Decisions tab, once
// the answers are read on a page that asks questions; how many are to
// answer; and the node whose children it moves in to show them. Likewise
// for its History tab: whether it has one, how many sections changed
// unseen, and the node whose children it moves in; and it says whether
// it holds History.
export interface SheetTabs {
  asks(): boolean;
  count(): number | null;
  node(): HTMLElement | null;
  history(): boolean;
  unseen(): number;
  historyNode(): HTMLElement | null;
  selected(holds: boolean): void;
}

export const sheetTabs: SheetTabs = {
  asks: () => decisionsTab.asks.peek() && decisionsTab.count.peek() !== null,
  count: () => decisionsTab.count.peek(),
  node: () => decisionsTab.node.peek(),
  history: () => historyTab.shown.peek(),
  unseen: () => historyTab.unseen.peek(),
  historyNode: () => historyTab.node.peek(),
  selected: (holds) => { inSheet.value = holds; },
};
