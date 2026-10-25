import { render } from "preact";
import type { Page } from "../../../comments/ts/index";
import { HASH, type Changes, type Section, type Sections } from "./state";

// What the comparison calls the text before the first h2, the whole text of
// a body without one (lotuspod.features.history.versions.PAGE_TEXT).
const PAGE_TEXT = "The page text";
const KINDS = [["changed", "Changed"], ["added", "New"], ["removed", "Removed"]] as const;
const TAGS = [["changed", "changed"], ["added", "new"]] as const;

function listed(sections: Sections, kind: keyof Sections): Section[] {
  const found = sections[kind];
  return Array.isArray(found) ? found : [];
}

export function plural(count: number, noun: string): string {
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
  copy.querySelectorAll(".artifact-section-mark, .artifact-changed-tag, .artifact-review-open")
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
// outline would make it) so the box can link to it. The text before the
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

function Box({ page, found, dismiss }: { page: Page; found: Changes; dismiss(): void }) {
  return (
    <>
      <h2 class="artifact-changes-heading" id="artifact-changes-heading">What changed since you last looked</h2>
      <p class="artifact-changes-when">
        {"You last opened this on "}
        <time datetime={found.since.date}>{page.when(found.since.date)}</time>
        {" · " + plural(Number(found.behind) || 0, "version") + " ago"}
      </p>
      <SectionList sections={found.sections} />
      <p class="artifact-changes-actions">
        <a class="artifact-changes-diff" href={HASH}>See the full diff</a>
        <button type="button" class="artifact-changes-dismiss" onClick={dismiss}>Dismiss</button>
      </p>
    </>
  );
}

// The box under the header, and the "changed" or "new" tags on the
// sections' headings. The headings are found, and given ids, before the box
// is drawn, so its links and the pane's name them.
export function box(page: Page, main: HTMLElement, found: Changes): void {
  const header = main.querySelector("header.artifact-header");
  if (!header) {
    return;
  }
  const tagged: [HTMLElement, string][] = [];
  for (const [kind, tag] of TAGS) {
    for (const section of listed(found.sections, kind)) {
      const target = sectionHeading(main, section);
      if (target && !target.querySelector(".artifact-changed-tag")) {
        tagged.push([target, tag]);
      }
    }
  }
  const node = page.element("section", "artifact-changes");
  node.setAttribute("aria-labelledby", "artifact-changes-heading");
  render(<Box page={page} found={found} dismiss={() => node.remove()} />, node);
  main.insertBefore(node, header.nextSibling);
  for (const [target, tag] of tagged) {
    target.appendChild(page.element("span", "artifact-changed-tag", tag));
  }
}
