import { effect, untracked } from "@preact/signals";
import type { Page } from "../bridge";
import type { Mode } from "./parts";
import { barBottom, modeOf, unfold } from "./room";
import { shell as makeShell } from "./shell";
import { decisionsTab, historyTab, opensIn, sheetTabs } from "./tabs";

// The comments panel on a page that asks questions and takes no comments:
// its Decisions tab alone, and no store, as the page serves no threads to
// read. It shows once the answers are read and the page asks questions,
// in the panel as the window leaves room for it, else in the bottom sheet,
// which the title bar's count opens.
export function questions(page: Page): void {
  const shell = makeShell(page, { opened() {}, resolvedChanged() {}, compose() {} }, false);
  const api = { mode: null as Mode | null };
  const over = page.overText({
    comments: false, tabs: sheetTabs, panel: api, unfold, barBottom,
    mute(node) {
      node.setAttribute("aria-hidden", "true");
      return node;
    },
  });

  // The panel, or the sheet, as the window allows; the questions open in
  // the sheet move to the panel when the window widens, and back, the
  // focus kept on what had it.
  function arrange(): void {
    const mode = modeOf(page);
    let focused: Element | null = null;
    if (mode !== api.mode) {
      focused = document.activeElement;
      const wide = api.mode === "panel";
      const deciding = wide && shell.deciding() && sheetTabs.asks();
      const reading = wide && shell.reading() && sheetTabs.history();
      const taken = over.take();
      api.mode = mode;
      over.mode(mode);
      if (mode === "panel" && taken.view) {
        shell.setOpen(true, false, taken.view.history ? "history" : "decisions");
      } else if (mode !== "panel") {
        over.restore(deciding ? { ...taken, view: { decisions: true } } :
          reading ? { ...taken, view: { history: true } } : taken);
      }
      decisionsTab.opens.value = opensIn(mode === "panel", shell.decide, over.decisions);
    }
    // Questions no longer asked, or no longer counted, close the sheet.
    if (!sheetTabs.asks()) {
      over.take();
    }
    shell.hidden(mode !== "panel" || !sheetTabs.asks());
    over.sync();
    if (focused instanceof HTMLElement && focused !== document.activeElement && focused.isConnected) {
      focused.focus({ preventScroll: true });
    }
  }

  arrange();
  window.addEventListener("resize", arrange);
  effect(() => {
    decisionsTab.asks.value;
    decisionsTab.count.value;
    historyTab.shown.value;
    historyTab.unseen.value;
    untracked(arrange);
  });
}
