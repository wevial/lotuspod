import type { Page } from "../bridge";
import type { Mode } from "./parts";

// Where the title bar ends, in the window.
export function barBottom(): number {
  const bar = document.querySelector(".artifact-topbar");
  return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
}

// Open the section target is in, if it is folded.
export function unfold(target: HTMLElement): void {
  const wrapper = target.closest(".artifact-section-body");
  if (wrapper && wrapper.hasAttribute("hidden")) {
    const heading = wrapper.previousElementSibling;
    const button = heading && heading.querySelector<HTMLButtonElement>("button.artifact-section-toggle");
    if (button) {
      button.click();
    }
  }
}

// Whether the window leaves ROOM right of the reading column at its
// full measure: a panel widened into the column narrows it
// (css/base.css), which must not change where the threads live. The
// measure is read from a probe set in the column's font, out of sight
// and outside the column, so it is no part of the page's text.
function roomy(page: Page): boolean {
  const column = document.querySelector(".artifact-body");
  if (!column) {
    return false;
  }
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position: absolute; left: 0; top: 0; height: 0; visibility: hidden; pointer-events: none";
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const style = getComputedStyle(column);
  (["fontFamily", "fontSize", "fontStyle", "fontWeight", "fontStretch"] as const).forEach(function (name) {
    probe.style[name] = style[name];
  });
  probe.style.width = style.getPropertyValue("--measure-prose") || "66ch";
  document.body.appendChild(probe);
  const measure = probe.getBoundingClientRect().width;
  probe.remove();
  const left = column.getBoundingClientRect().left;
  const holder = column.parentElement!;
  const edge = holder.getBoundingClientRect().right -
    (parseFloat(getComputedStyle(holder).paddingRight) || 0) -
    (parseFloat(getComputedStyle(holder).borderRightWidth) || 0);
  const right = left + Math.min(measure, edge - left);
  return document.documentElement.clientWidth - right >= page.room * rem;
}

// The comments panel where the window leaves room for it, else a popover
// from POPOVER pixels wide, else the bottom sheet.
export function modeOf(page: Page): Mode {
  return roomy(page) ? "panel" : window.matchMedia(page.popover).matches ? "popover" : "sheet";
}
