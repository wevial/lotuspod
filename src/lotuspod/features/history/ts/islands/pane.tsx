import type { Page } from "../../../comments/ts/index";
import { SectionList } from "./changes";
import type { Changes, DiffLine } from "./state";

const NO_SOURCE = "This page has no kept source for that version, so it compares by section.";

export function Line({ line }: { line: DiffLine }) {
  const op = String(line.op);
  const Tag = op === "+" ? "ins" : op === "-" ? "del" : "div";
  const kind = op === "+" ? "added" : op === "-" ? "removed" : op === "@" ? "hunk" : "same";
  return (
    <Tag class={"artifact-diff-line artifact-diff-line--" + kind}>
      {op !== "@" && <span class="artifact-diff-op" aria-hidden="true">{op === " " ? "" : op}</span>}
      <span class="artifact-diff-text">{String(line.text)}</span>
    </Tag>
  );
}

// The pane beside the versions list: that version against the current one,
// a line diff of the source or else the sections.
export function Pane({ page, found }: { page: Page; found: Changes }) {
  return (
    <aside class="artifact-versions-diff" aria-labelledby="artifact-versions-diff-heading">
      <h3 class="artifact-versions-diff-heading" id="artifact-versions-diff-heading">
        <time datetime={found.since.date}>{page.when(found.since.date)}</time>{" → current"}
      </h3>
      {Array.isArray(found.lines) ? (
        <>
          <div class="artifact-diff">{found.lines.map((line) => <Line line={line} />)}</div>
          {found.truncated === true && <p class="artifact-versions-diff-more">More changes not shown.</p>}
        </>
      ) : (
        <>
          <p class="artifact-versions-diff-note">{NO_SOURCE}</p>
          <SectionList sections={found.sections} />
        </>
      )}
    </aside>
  );
}
