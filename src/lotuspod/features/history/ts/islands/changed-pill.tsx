import { render } from "preact";
import { historyTab, type Page } from "../../../comments/ts/index";
import { HASH, type VersionsState } from "./state";

// The pill, while any section "Since you last looked" lists is unseen:
// pressed, it opens the History tab where the page has a comments panel,
// leaving the full versions view first, as that view hides the panel; else
// it opens the full versions view.
function Pill({ state }: { state: VersionsState }) {
  const unseen = historyTab.unseen.value;
  const opens = historyTab.opens.value;
  if (unseen <= 0) {
    return null;
  }
  return (
    <button type="button" class="artifact-history-pill" aria-controls={opens?.id}
      aria-label={`${unseen} changed since you last looked: open History`} onClick={(event) => {
        if (opens) {
          if (state.open.peek()) {
            history.pushState(null, "", location.pathname + location.search);
            state.open.value = false;
          }
          opens.open(event.currentTarget);
        } else {
          location.hash = HASH;
        }
      }}>
      <span class="artifact-history-pill-dot" aria-hidden="true" />
      <span class="artifact-history-pill-words" aria-hidden="true">
        <span class="artifact-history-pill-count">{String(unseen)}</span>
        <span class="artifact-history-pill-word"> changed</span>
      </span>
    </button>
  );
}

// The title bar's "N changed", drawn into a slot just before the review bar
// when the bar is there, else at the bar's end, so a review bar appended
// later comes after it.
export function changedPill(page: Page, state: VersionsState): void {
  const bar = document.querySelector<HTMLElement>(".artifact-topbar");
  if (!bar) {
    return;
  }
  const node = page.element("span", "artifact-history-pill-slot");
  bar.insertBefore(node, bar.querySelector(":scope > .artifact-review-bar"));
  render(<Pill state={state} />, node);
}
