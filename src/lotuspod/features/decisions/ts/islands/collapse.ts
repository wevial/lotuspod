// A decision card's question as a toggle: ▾ open, ▸ collapsed to one line
// under it, which the card part draws (card.tsx). The renderer writes no
// toggle, so a page without the script shows every card open; every card
// starts open on each load, and one a swap brings in is drawn open.
const COLLAPSED = "artifact-decision--collapsed";

function toggleOf(form: HTMLFormElement): HTMLButtonElement | null {
  return form.querySelector<HTMLButtonElement>("legend > button.artifact-decision-toggle");
}

export function isCollapsed(form: HTMLFormElement): boolean {
  return form.classList.contains(COLLAPSED);
}

// Collapse the card to its line, or open it.
export function collapse(form: HTMLFormElement, on: boolean): void {
  const button = toggleOf(form);
  if (!button) {
    return;
  }
  form.classList.toggle(COLLAPSED, on);
  button.setAttribute("aria-expanded", String(!on));
  button.querySelector(".artifact-decision-caret")!.textContent = on ? "▸" : "▾";
  form.querySelector<HTMLElement>(".artifact-decision-line")!.hidden = !on;
}

// A collapsed card open again, before anything takes the reader to it.
export function expand(form: HTMLFormElement): void {
  if (isCollapsed(form)) {
    collapse(form, false);
  }
}

// The question's words wrapped in the toggle, and the line last in the
// fieldset, the one part a collapsed card shows under its legend, so the
// context still follows the legend.
export function collapsible(form: HTMLFormElement): void {
  const legend = form.querySelector("legend.artifact-decision-question");
  if (!legend || toggleOf(form)) {
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "artifact-decision-toggle";
  const caret = document.createElement("span");
  caret.className = "artifact-decision-caret";
  caret.setAttribute("aria-hidden", "true");
  button.append(caret, ...Array.from(legend.childNodes));
  legend.appendChild(button);
  const line = document.createElement("p");
  line.className = "artifact-decision-line";
  legend.parentNode!.appendChild(line);
  button.addEventListener("click", () => collapse(form, !isCollapsed(form)));
  collapse(form, false);
}
