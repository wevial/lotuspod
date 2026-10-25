// Bundled with Preact into src/lotuspod/features/comments/ts/islands.js
// (web/build.ts), after comment-markdown.js so comments start before later sources, and never
// on a pod that goes to the index (features/publish/ts/open-in-tabs.js). The
// decision cards mount first, through the decisions slice's public entry, so
// the review sheet reads them and the comments find their forms taken over.
// The history slice's island mounts last, through its public entry; it adds
// its link to the header before the badge of replies the comments add.

import { decisions } from "../../../decisions/ts/index";
import { versions } from "../../../history/ts/index";
import { page, type Page } from "./bridge";
import { comments } from "./comments";
import { reviewSheet } from "./review-sheet";

type Island = (page: Page) => void;

const cards = decisions(page);
const islands: Island[] = [(page) => reviewSheet(page, cards), comments, versions];

for (const mount of islands) {
  mount(page);
}
