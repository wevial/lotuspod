// Focus moved to a tab after a pointer press (a click on ✕, a mouse pick in
// the finder) draws no ring: with focus({ focusVisible: false }) where the
// browser honours it, else a class the stylesheet reads, gone at the next
// key.

const QUIET = "pod-tab-title--quiet";

// Whether the last press was the pointer's rather than a key's, and whether
// the browser reads focusVisible when asked to focus.
let pointed = false;
let honoured = false;

export function focusing(bar: HTMLElement): void {
  try {
    document.createElement("button").focus({
      get focusVisible() {
        honoured = true;
        return false;
      },
    } as FocusOptions);
  } catch {
    // Not read: the class stands in.
  }
  window.addEventListener("pointerdown", () => {
    pointed = true;
  }, true);
  window.addEventListener("keydown", () => {
    pointed = false;
    for (const quiet of bar.querySelectorAll(`.${QUIET}`)) quiet.classList.remove(QUIET);
  }, true);
}

// Focus a tab's title, with no ring after a pointer press.
export function focusTab(title: HTMLElement): void {
  if (!pointed) {
    title.focus();
  } else if (honoured) {
    title.focus({ focusVisible: false } as FocusOptions);
  } else {
    title.classList.add(QUIET);
    title.focus();
  }
}
