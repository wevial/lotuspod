import { render } from "preact";
import { historyTab, type Page } from "../../../comments/ts/index";
import { HASH, type VersionsState } from "./state";

// The menu the classic version-menu.js draws.
export type Menu = ReturnType<Page["versionMenu"]>;

// Where the page has a comments panel, a plain click opens its History tab,
// the address kept, with the tab's own "Versions · N" scrolled to the top of
// the tab, which scrolls on its own; any other click, or a page with no
// panel, follows the link to the versions view.
function Link({ state }: { state: VersionsState }) {
  function click(event: MouseEvent): void {
    const opens = historyTab.opens.peek();
    if (!opens || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    opens.open(event.currentTarget as HTMLElement);
    const area = document.getElementById(opens.id);
    const heading = area?.querySelector(".artifact-history-versions-heading");
    if (heading && area) {
      area.scrollTop += heading.getBoundingClientRect().top - area.getBoundingClientRect().top;
    }
  }
  return <>{"· "}<a class="artifact-versions-link" href={HASH} onClick={click}>{"Versions · " + (state.versions.value ?? []).length}</a></>;
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
