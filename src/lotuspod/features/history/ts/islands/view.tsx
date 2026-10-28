import { render } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { Page } from "../../../comments/ts/index";
import { Pane } from "./pane";
import { SHOWN, type Version, type VersionsState } from "./state";

// One version: its date and time, a note saying what it changed, "you last
// looked" and "current" where those apply, and its "View" link, stretched
// over the row (features/history/theme/versions.css), so a click anywhere on
// it is a click on the link: the current one's to the page, every other's to
// its read-only old version.
export function Entry({ page, name, version, seen }: { page: Page; name: string; version: Version; seen: boolean }) {
  const stamp = page.when(version.date);
  const file = encodeURIComponent(name) + ".html";
  return (
    <li class={"artifact-versions-entry" + (seen ? " artifact-versions-entry--seen" : "") +
      (version.current ? " artifact-versions-entry--current" : "")}>
      <div class="artifact-versions-when">
        <time class="artifact-versions-date" datetime={version.date}>{stamp}</time>
        <p class="artifact-versions-note">{String(version.summary || "") || "First version"}</p>
      </div>
      {seen && <span class="artifact-versions-seen">you last looked</span>}
      {version.current && <span class="artifact-versions-current">current</span>}
      {version.current
        ? <a class="artifact-versions-view" href={file} aria-label="View the current version">View</a>
        : <a class="artifact-versions-view" href={file + "?version=" + encodeURIComponent(version.commit)}
          aria-label={"View the version of " + stamp}>View</a>}
    </li>
  );
}

function count(total: number): string {
  return total === 0 ? "This page has no versions yet." :
    total === 1 ? "This is the only version." : total + ", newest first";
}

// The view's breadcrumb back to the page, heading, the versions newest first
// as far as shown, "Show older versions", and the pane when anything changed.
function View({ page, name, back, state }: { page: Page; name: string; back: string; state: VersionsState }) {
  const versions = state.versions.value ?? [];
  const found = state.changes.value;
  const shown = state.shown.value;
  const list = useRef<HTMLOListElement>(null);
  // The first entry "Show older versions" added, whose link takes the focus
  // once it is drawn.
  const focusAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = focusAt.current;
    focusAt.current = null;
    if (at !== null) {
      list.current?.children[at]?.querySelector("a")?.focus();
    }
  });
  const more = () => {
    focusAt.current = Math.min(shown, versions.length);
    state.shown.value = shown + SHOWN;
  };
  return (
    <>
      <nav class="artifact-versions-crumbs" aria-label="Breadcrumb">
        <a class="artifact-versions-back" href="#top">{back}</a>
        <span class="artifact-versions-sep">{" › "}</span>
        <span class="artifact-versions-here" aria-current="page">Versions</span>
      </nav>
      <h2 class="artifact-versions-heading" id="artifact-versions-heading" tabIndex={-1}>Versions</h2>
      <p class="artifact-versions-count">{count(versions.length)}</p>
      <ol class="artifact-versions-list" ref={list}>
        {versions.slice(0, shown).map((version) => (
          <Entry page={page} name={name} version={version}
            seen={Boolean(found && version.commit === found.since.commit)} />
        ))}
      </ol>
      <button type="button" class="artifact-versions-more" hidden={shown >= versions.length}
        onClick={more}>Show older versions</button>
      {found && <Pane page={page} found={found} />}
    </>
  );
}

// The #versions view, made hidden the first time it is shown, before the
// page's footer.
export function view(page: Page, main: HTMLElement, name: string, back: string,
  state: VersionsState): HTMLElement {
  const node = page.element("section", "artifact-versions" +
    (state.changes.value ? " artifact-versions--diff" : ""));
  node.id = "versions";
  node.hidden = true;
  node.setAttribute("aria-labelledby", "artifact-versions-heading");
  render(<View page={page} name={name} back={back} state={state} />, node);
  main.insertBefore(node, main.querySelector(".artifact-footer"));
  return node;
}
