import { all } from "./checklist";
import { expand } from "./collapse";

// The marks other islands add to a heading, which are no part of its title.
const MARKS = ".artifact-section-mark, .artifact-changed-tag, .artifact-review-open";

// The questions of one section, in page order, under its title.
export interface Section {
  // The heading's id, "" for the questions before the first h2; for a live
  // block's group, "about:" and the block's id.
  key: string;
  title: string;
  forms: HTMLFormElement[];
}

function words(node: Element | null): string {
  return node ? (node.textContent ?? "").replace(/\s+/g, " ").trim() : "";
}

// A heading's own words: its fold button's, without the marks in it.
function headingTitle(heading: HTMLElement): string {
  const copy = (heading.querySelector(".artifact-section-toggle") ?? heading).cloneNode(true) as Element;
  for (const mark of all(MARKS, copy)) mark.remove();
  return words(copy);
}

// The nearest h2 before the form, null before the first.
export function headingOf(form: HTMLFormElement): HTMLElement | null {
  const body = document.querySelector("section.artifact-body");
  let heading: HTMLElement | null = null;
  for (const h2 of body ? all<HTMLElement>("h2", body) : []) {
    if (h2.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING) {
      heading = h2;
    }
  }
  return heading;
}

// One group per h2 asking one of forms, in page order, each followed by one
// per live block its questions are about (data-about), under the block's
// title; a question before the first h2 is under the page's title.
export function sectionsOf(forms: readonly HTMLFormElement[]): Section[] {
  const sections = new Map<HTMLElement | null, { own: Section; blocks: Map<string, Section> }>();
  for (const form of forms) {
    const heading = headingOf(form);
    let section = sections.get(heading);
    if (!section) {
      section = {
        own: {
          key: heading?.id ?? "",
          title: heading ? headingTitle(heading) : words(document.querySelector(".artifact-title")),
          forms: [],
        },
        blocks: new Map(),
      };
      sections.set(heading, section);
    }
    const about = form.dataset.about;
    if (!about) {
      section.own.forms.push(form);
      continue;
    }
    let block = section.blocks.get(about);
    if (!block) {
      const figure = document.querySelector(`figure.artifact-live[data-widget="${CSS.escape(about)}"]`);
      block = { key: "about:" + about, title: words(figure?.querySelector(".artifact-live-title") ?? null) || about, forms: [] };
      section.blocks.set(about, block);
    }
    block.forms.push(form);
  }
  const groups: Section[] = [];
  for (const { own, blocks } of sections.values()) {
    if (own.forms.length) {
      groups.push(own);
    }
    groups.push(...blocks.values());
  }
  return groups;
}

// Where the title bar ends, in the window, as the comments panel reads it.
function barBottom(): number {
  const bar = document.querySelector(".artifact-topbar");
  return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
}

// Open a form's section if it is folded, as a row's "change" does, open the
// form if it is collapsed, and put it just below the title bar.
export function place(form: HTMLFormElement): void {
  expand(form);
  const wrapper = form.closest("div.artifact-section-body");
  if (wrapper && wrapper.hasAttribute("hidden")) {
    wrapper.dispatchEvent(new Event("beforematch"));
  }
  window.scrollBy({ top: form.getBoundingClientRect().top - barBottom() - 16, left: 0, behavior: "instant" });
}

// Place a form, then focus its first option, or its "change" (a
// dismissal's Undo) when it is folded to its answer.
export function jump(form: HTMLFormElement): void {
  place(form);
  const target = form.classList.contains("artifact-decision--saved") ?
    form.querySelector<HTMLElement>(".artifact-decision-saved :is(.artifact-decision-change, " +
      ".artifact-decision-undo)") :
    form.querySelector<HTMLElement>("input");
  target?.focus({ preventScroll: true });
}
