import { render } from "preact";
import { useState } from "preact/hooks";
import { effect, untracked } from "@preact/signals";
import { historyTab, type Page } from "../../../comments/ts/index";
import { KINDS, linkSections, listed, plural } from "./changes";
import { Line } from "./pane";
import { HASH, type Section, type VersionsState } from "./state";
import { Entry } from "./view";

// How many of the newest versions the tab lists: the panel is narrow, and
// "See all versions" opens the rest.
const NEWEST = 10;

interface Listed { kind: (typeof KINDS)[number][0]; word: string; section: Section }

// The sections "Since you last looked" lists: none once marked seen.
function rowsOf(state: VersionsState): Listed[] {
  const found = state.changes.value;
  return found && !state.marked.value ?
    KINDS.flatMap(([kind, word]) => listed(found.sections, kind).map((section) => ({ kind, word, section }))) : [];
}

// One changed, new or removed section: its kind, its name, a link to its
// heading unless removed, and on a changed one with a line diff of its own,
// "Show the diff", which shows that diff under the row.
function Row({ kind, word, section }: Listed) {
  const [open, setOpen] = useState(false);
  const name = String(section.title || "");
  const lines = kind === "changed" && Array.isArray(section.lines) ? section.lines : null;
  return (
    <li class={"artifact-history-item artifact-history-item--" + kind}>
      <div class="artifact-history-row">
        <span class="artifact-history-kind">{word}</span>
        {section.id && kind !== "removed"
          ? <a class="artifact-history-section" href={"#" + encodeURIComponent(section.id)}>{name}</a>
          : <span class="artifact-history-section">{name}</span>}
        {lines && <button type="button" class="artifact-history-toggle" aria-expanded={open}
          onClick={() => setOpen(!open)}>{open ? "Hide the diff" : "Show the diff"}</button>}
      </div>
      {lines && open && (
        <>
          <div class="artifact-diff artifact-history-diff">{lines.map((line) => <Line line={line} />)}</div>
          {section.truncated === true && <p class="artifact-history-more">More changes not shown.</p>}
        </>
      )}
    </li>
  );
}

// The tab: what changed since the reader last looked, with Mark as seen
// while anything is unseen, then the newest versions and "See all versions".
// Mark as seen is for this load only: the visit is already recorded.
function Tab({ page, name, state }: { page: Page; name: string; state: VersionsState }) {
  const versions = state.versions.value ?? [];
  const found = state.changes.value;
  const marked = state.marked.value;
  const rows = rowsOf(state);
  const current = versions.find((version) => version.current);
  const seen = marked ? current?.commit : found?.since.commit;
  function mark(): void {
    document.getElementById("artifact-comments-tab-history")?.focus({ preventScroll: true });
    state.marked.value = true;
  }
  return (
    <div class="artifact-history">
      <div class="artifact-history-head">
        <h3 class="artifact-history-heading">Since you last looked</h3>
        {rows.length > 0 && <button type="button" class="artifact-history-mark" onClick={mark}>Mark as seen</button>}
      </div>
      {found && !marked ? (
        <>
          <p class="artifact-history-when">
            {"You last opened this on "}
            <time datetime={found.since.date}>{page.when(found.since.date)}</time>
            {" · " + plural(Number(found.behind) || 0, "version") + " ago"}
          </p>
          {rows.length
            ? <ul class="artifact-history-list">{rows.map((row) => <Row key={row.kind + row.section.title} {...row} />)}</ul>
            : <p class="artifact-history-none">No section's text changed.</p>}
        </>
      ) : <p class="artifact-history-none">Nothing new since you last looked.</p>}
      <h3 class="artifact-history-versions-heading">{"Versions · " + versions.length}</h3>
      <ol class="artifact-versions-list artifact-history-versions">
        {versions.slice(0, NEWEST).map((version) => (
          <Entry key={version.commit} page={page} name={name} version={version} seen={version.commit === seen} />
        ))}
      </ol>
      <a class="artifact-history-all" href={HASH}>See all versions</a>
    </div>
  );
}

// The comments panel's History tab: shown once the versions route answers
// with a list, counting the sections changed unseen, and drawn into the
// node the panel gives it once both are there.
export function historyTabPanel(page: Page, main: HTMLElement, name: string, state: VersionsState): void {
  effect(() => {
    const shown = state.versions.value !== null;
    historyTab.shown.value = shown;
    historyTab.unseen.value = shown ? rowsOf(state).length : 0;
  });
  effect(() => {
    const node = historyTab.node.value;
    if (!node || !state.versions.value) {
      return;
    }
    untracked(() => {
      const found = state.changes.value;
      if (found) {
        linkSections(main, found);
      }
      render(<Tab page={page} name={name} state={state} />, node);
    });
  });
}
