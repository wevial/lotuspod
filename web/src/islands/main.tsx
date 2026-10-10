// The page script's islands entry: bundled with Preact into
// src/lotuspod/_theme/js/islands.js (web/build.ts), the page script's last
// source, so it runs once every legacy source has, and never on a pod that
// goes to the index (js/open-in-tabs.js). Each island reaches the legacy
// page only through the bridge's page.

import { page, type Page } from "./bridge";
import { reviewSheet } from "./review-sheet";

// An island mounts itself on the page it is handed.
type Island = (page: Page) => void;

// The islands, in the order they mount.
const islands: Island[] = [reviewSheet];

for (const mount of islands) {
  mount(page);
}
