import type { Page } from "../../../comments/ts/index";
import type { Changes, Section, Sections } from "./state";

// What the comparison calls the text before the first h2, the whole text of
// a body without one (lotuspod.features.history.versions.PAGE_TEXT).
const PAGE_TEXT = "The page text";
export const KINDS = [["changed", "Changed"], ["added", "New"], ["removed", "Removed"]] as const;
// What a changed or added section's heading carries, drawn as a rule while
// History is shown.
export const CHANGED = "artifact-history-changed";

export function listed(sections: Sections, kind: keyof Sections): Section[] {
  const found = sections[kind];
  return Array.isArray(found) ? found : [];
}

function plural(count: number, noun: string): string {
  return count + " " + noun + (count === 1 ? "" : "s");
}

// One item per changed, added or removed section, each changed or added one
// a link to its section.
export function SectionList({ sections }: { sections: Sections }) {
  const items = KINDS.flatMap(([kind, word]) => listed(sections, kind).map((section) => {
    const name = String(section.title || "");
    return (
      <li class={"artifact-changes-item artifact-changes-item--" + kind}>
        <span class="artifact-changes-kind">{word}</span>{" "}
        {section.id && kind !== "removed"
          ? <a class="artifact-changes-section" href={"#" + encodeURIComponent(section.id)}>{name}</a>
          : <span class="artifact-changes-section">{name}</span>}
      </li>
    );
  }));
  return (
    <ul class="artifact-changes-list">
      {items.length ? items : <li class="artifact-changes-item">No section's text changed.</li>}
    </ul>
  );
}

// The words of a heading, without the marks the page script adds.
function headingText(heading: HTMLElement): string {
  const copy = heading.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".artifact-section-mark, .artifact-review-open")
    .forEach((mark) => mark.remove());
  return (copy.textContent || "").replace(/\s+/g, " ").trim();
}

// A free id from base, as the outline makes them.
function freeId(base: string): string {
  let id = base;
  for (let n = 2; document.getElementById(id); n += 1) {
    id = base + "-" + n;
  }
  return id;
}

// The body's h2 for a changed or added section: by its id, else, as a page
// left with one heading gives it none, by its words, given an id here (as the
// outline would make it) so History can link to it. The text before the
// first h2 has no heading: its link goes to the start of the body, given an
// id for it.
function sectionHeading(main: HTMLElement, section: Section): HTMLElement | null {
  if (section.id) {
    const named = document.getElementById(section.id);
    return named && named.tagName === "H2" && named.closest(".artifact-body") ? named : null;
  }
  const title = String(section.title || "");
  const found = Array.from(document.querySelectorAll<HTMLElement>(".artifact-body h2:not([id])"))
    .find((heading) => !heading.closest("pre") && headingText(heading) === title) ?? null;
  if (found) {
    found.id = freeId(title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      "section");
    section.id = found.id;
  } else if (title === PAGE_TEXT) {
    const body = main.querySelector<HTMLElement>("section.artifact-body");
    if (body) {
      body.id = body.id || freeId("page-text");
      section.id = body.id;
    }
  }
  return found;
}

// "You last opened this on DATE · K versions ago", in the History tab.
export function LastOpened({ page, found }: { page: Page; found: Changes }) {
  return (
    <>
      {"You last opened this on "}
      <time datetime={found.since.date}>{page.when(found.since.date)}</time>
      {" · " + plural(Number(found.behind) || 0, "version") + " ago"}
    </>
  );
}

// The headings of the changed and added sections, each given CHANGED,
// found and given ids before anything links to them, so the pane's links
// and the History tab's name them. Run again, it finds the same ones.
export function linkSections(main: HTMLElement, found: Changes): HTMLElement[] {
  const marked: HTMLElement[] = [];
  for (const kind of ["changed", "added"] as const) {
    for (const section of listed(found.sections, kind)) {
      const target = sectionHeading(main, section);
      if (target) {
        target.classList.add(CHANGED);
        marked.push(target);
      }
    }
  }
  return marked;
}
