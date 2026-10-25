import { render } from "preact";
import type { Page } from "../../../comments/ts/index";
import { HASH, type VersionsState } from "./state";

// The menu the classic version-menu.js draws.
export type Menu = ReturnType<Page["versionMenu"]>;

function Link({ state }: { state: VersionsState }) {
  return <>{"· "}<a class="artifact-versions-link" href={HASH}>{"Versions · " + (state.versions.value ?? []).length}</a></>;
}

// The "Versions · N" link and the version menu's button take the slot the
// theme kept for them at the end of the header's date line, so the header
// does not move when they arrive; only the badge of replies to the reader
// (the comments island) comes after them. The menu's nodes follow what the
// island draws in the slot.
export function slot(line: HTMLElement, page: Page, state: VersionsState, menu: Menu): void {
  const node = page.element("span", "artifact-versions-slot");
  render(<Link state={state} />, node);
  node.append(menu.button, menu.menu);
  line.insertBefore(node, line.querySelector(".artifact-unread"));
  line.classList.add("artifact-meta--versions");
}
