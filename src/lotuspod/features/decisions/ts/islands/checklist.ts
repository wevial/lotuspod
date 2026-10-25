// A checklist (lotuspod.features.decisions.decisions) asks one question about a
// list of items: its inputs are checkboxes, each preset to its default, and its
// answer is the set of items checked.

export function all<T extends Element = HTMLElement>(selector: string, root: ParentNode): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function isChecklist(form: HTMLFormElement): boolean {
  return form.classList.contains("artifact-decision--checklist");
}

export function boxes(form: HTMLFormElement): HTMLInputElement[] {
  return all<HTMLInputElement>('input[type="checkbox"][name="item"]', form);
}

// The ids of a checklist's items checked now ("checked"), or by default
// ("defaultChecked"), in page order.
export function ticked(form: HTMLFormElement, state: "checked" | "defaultChecked"): string[] {
  return boxes(form).filter((box) => box[state]).map((box) => box.value);
}

// Whether two lists of item ids hold the same items.
export function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.indexOf(item) !== -1);
}

// An option's label, else its value.
export function optionText(input: HTMLInputElement): string {
  const text = input.parentNode!.querySelector(".artifact-decision-label");
  return text ? (text.textContent ?? "").replace(/\s+/g, " ").trim() : input.value;
}

// The items whose state in checked differs from their defaults, by label
// in page order, worded as the server words a checklist's answer.
export function summary(form: HTMLFormElement, checked: readonly string[]): string {
  const on: string[] = [];
  const off: string[] = [];
  for (const box of boxes(form)) {
    const now = checked.indexOf(box.value) !== -1;
    if (now !== box.defaultChecked) {
      (now ? on : off).push(optionText(box));
    }
  }
  const parts: string[] = [];
  if (on.length) {
    parts.push("On: " + on.join(", "));
  }
  if (off.length) {
    parts.push("Off: " + off.join(", "));
  }
  return parts.join(" · ") || "No change from the defaults";
}
