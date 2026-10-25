import { effect, untracked } from "@preact/signals";
import type { Page } from "../../../comments/ts/index";
import { box } from "./changes";
import { slot, type Menu } from "./slot";
import { HASH, read, versionsState, type Version, type VersionsState } from "./state";
import { view } from "./view";

// The page's versions (lotuspod.features.history.versions): a page with a
// revision asks the versions route once. When it answers 200, even with no
// versions (a directory that is not the top of its own repository has none),
// the header's date line gains a "Versions · N" link to #versions beside the
// version menu's "▾" (features/history/ts/version-menu.js), and while the
// hash is #versions the page shows its versions view in place of its header
// and body. Any other answer leaves the page as it is: no link, no view.
//
// When the reader last opened the page at another revision (live.previous),
// the page asks the changes route what changed since. Unless it answers
// changed: false or fails, a box under the header says so, the changed or
// added sections' headings are tagged, and the view shows a pane comparing
// that version with the current one and marks its entry "you last looked".
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
      untracked(() => box(page, main, found));
    }
  });
  effect(() => {
    const listed = state.versions.value;
    if (listed) {
      untracked(() => draw(listed));
    }
  });
  read(page, name, state);

  function draw(listed: Version[]): void {
    const found = state.changes.value;
    const current = listed.find((version) => version.current);
    const menu = page.versionMenu(listed, name, current ? current.commit : null,
      found ? found.since.commit : null);
    slot(line!, page, state, menu);
    window.addEventListener("hashchange", () => {
      state.open.value = location.hash === HASH;
    });
    state.open.value = location.hash === HASH;
    shows(page, main!, name, title, state, menu);
  }
}

// The view follows open: made the first time it shows; showing it closes
// the menu, which it hides with the header, and takes the focus.
function shows(page: Page, main: HTMLElement, name: string, title: Element | null,
  state: VersionsState, menu: Menu): void {
  let node: HTMLElement | null = null;
  effect(() => {
    const open = state.open.value;
    untracked(() => {
      if (open === Boolean(node && !node.hidden)) {
        return;
      }
      if (open) {
        menu.close(false);
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
