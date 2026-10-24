import { signal } from "@preact/signals";

// Where the comments panel's Decisions tab meets the decisions island. The
// island says whether the page asks questions (asks), and how many are to
// answer once its answers are read (count, null until then); the shell gives
// it the tab's panel to draw into (node), once the shell is drawn.
export const decisionsTab = {
  asks: signal(false),
  count: signal<number | null>(null),
  node: signal<HTMLElement | null>(null),
};
