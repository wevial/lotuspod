// The page script's islands entry: bundled with Preact into
// src/lotuspod/_theme/js/islands.js (web/build.ts), directly after comments.js
// in the page script, so comments start before later sources, and never
// on a pod that goes to the index (js/open-in-tabs.js). Each island reaches the legacy
// page only through the bridge's page.

import { page, type Page } from "./bridge";
import { comments } from "./comments";
import { reviewSheet } from "./review-sheet";

// An island mounts itself on the page it is handed.
type Island = (page: Page) => void;

// The islands, in the order they mount.
const islands: Island[] = [reviewSheet, comments];

for (const mount of islands) {
  mount(page);
}
