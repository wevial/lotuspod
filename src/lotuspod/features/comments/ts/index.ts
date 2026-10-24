// The comments slice's public entry, which another slice's islands import
// (the slice rule in web/build.test.ts): the bridge's page and its types,
// and the comments store's state, read-only, with what reads and posts the
// page's answers through it; and where the comments panel's Decisions tab is
// drawn.

import { shared, type StoreState } from "./islands/comments/state";

export type { Page, Saved, Swapped } from "./islands/bridge";
export { answerStore, type AnswerStore, type Posted } from "./islands/comments/answers";
export { UNANSWERED, type Answer, type Answers, type Asking } from "./islands/comments/state";
export { decisionsTab } from "./islands/comments/tabs";

// The store's signals, which only the store writes.
export const store: Omit<StoreState, "write"> = shared;
