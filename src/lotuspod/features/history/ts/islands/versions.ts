import { effect, untracked } from "@preact/signals";
import type { Page } from "../../../comments/ts/index";
import { linkSections } from "./changes";
import { changedPill } from "./changed-pill";
import { historyTabPanel } from "./history-tab";
import { slot } from "./slot";
import { HASH, read, versionsState, type VersionsState } from "./state";
import { view } from "./view";

// The page's versions (lotuspod.features.history.versions): a page with a
// revision asks the versions route once. When it answers 200, even with no
// versions (a directory that is not the top of its own repository has none),
// the header's date line gains a "Versions · N" link to #versions, and while
// the hash is #versions the page shows its versions view in place of its header
// and body. Any other answer leaves the page as it is: no link, no view.
//
// When the reader last opened the page at another revision (live.previous),
// the page asks the changes route what changed since. Unless it answers
// changed: false or fails, the changed or added sections' headings carry a
// rule while History is shown, and the view shows a pane comparing that
// version with the current one and marks its entry "you last looked". The
// comments panel's History tab lists those sections, beside the newest
// versions, once the versions route answers with a list, and the title bar's
// "N changed" opens it while any changed section is unseen. On a page with no
// comments panel the pill and "Versions · N" open the versions view.
export function versions(page: Page): void {
  const line = document.querySelector<HTMLElement>("header.artifact-header .artifact-meta");
  const main = document.querySelector<HTMLElement>("main.artifact");
  if (!page.live.revision() || !line || !main) {
    return;
  }
  const name = page.pageName();
  const title = document.querySelector(".artifact-title");
  const state = versionsState();

  effect(() => {
    const found = state.changes.value;
    if (found) {
      untracked(() => linkSections(main, found));
    }
  });
  effect(() => {
    const listed = state.versions.value;
    if (listed) {
      untracked(() => {
        slot(line, page, state);
        window.addEventListener("hashchange", () => {
          state.open.value = location.hash === HASH;
        });
        state.open.value = location.hash === HASH;
        shows(page, main, name, title, state);
      });
    }
  });
  historyTabPanel(page, main, name, state);
  changedPill(page, state);
  read(page, name, state);
}

// The view follows open: made the first time it shows; showing it takes the
// focus.
function shows(page: Page, main: HTMLElement, name: string, title: Element | null,
  state: VersionsState): void {
  let node: HTMLElement | null = null;
  effect(() => {
    const open = state.open.value;
    untracked(() => {
      if (open === Boolean(node && !node.hidden)) {
        return;
      }
      node ??= view(page, main, name, title ? (title.textContent || "").trim() : name, state);
      node.hidden = !open;
      main.classList.toggle("artifact--versions", open);
      document.body.classList.toggle("artifact-versions-shown", open);
      if (open) {
        window.scrollTo(0, 0);
        node.querySelector<HTMLElement>("#artifact-versions-heading")?.focus({ preventScroll: true });
      }
    });
  });
}
