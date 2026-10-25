import { signal, type Signal } from "@preact/signals";
import type { Page } from "../../../comments/ts/index";

const VERSIONS = "/api/versions";
const CHANGES = "/api/changes";
export const HASH = "#versions";
// How many versions the list shows at first, and how many more each "Show
// older versions" shows.
export const SHOWN = 20;

// One version as the versions route lists it, newest first.
export interface Version {
  commit: string;
  date: string;
  summary?: string | null;
  current?: boolean;
}

// A section the changes route names; a heading found by its words is given
// an id here, which the box and the pane then link to.
export interface Section { id?: string; title?: string }
export interface Sections { changed?: Section[]; added?: Section[]; removed?: Section[] }
export interface DiffLine { op: string; text: string }

// The changes route's answer when anything changed since the revision the
// reader last opened the page at.
export interface Changes {
  changed: true;
  since: { commit: string; date: string };
  behind?: number;
  sections: Sections;
  // The source's line diff, absent when that version kept no source.
  lines?: DiffLine[];
  truncated?: boolean;
}

// What the island draws from. changes is set first, once the changes route
// answers (null when nothing changed or it failed); versions only after it,
// and only when the versions route answers 200 with a list, so it stays null
// for good on any other answer.
export interface VersionsState {
  versions: Signal<Version[] | null>;
  changes: Signal<Changes | null>;
  // How many of the versions the list shows.
  shown: Signal<number>;
  // Whether #versions is the address, so the view shows.
  open: Signal<boolean>;
}

export function versionsState(): VersionsState {
  return { versions: signal(null), changes: signal(null), shown: signal(SHOWN), open: signal(false) };
}

// Ask the changes route what changed since the reader last looked, then the
// versions route for the list.
export function read(page: Page, name: string, state: VersionsState): void {
  const changes = page.live.previous().then(async (previous) => {
    if (!previous || previous === page.live.revision()) {
      return null;
    }
    const response = await fetch(CHANGES + "?page=" + encodeURIComponent(name) +
      "&since=" + encodeURIComponent(previous));
    const payload = response.status === 200 ? await page.json<Partial<Changes>>(response) : null;
    return payload && payload.changed === true && payload.since && payload.sections ?
      payload as Changes : null;
  }).catch(() => null);

  void changes.then((found) => {
    state.changes.value = found;
  });

  void (async () => {
    try {
      const response = await fetch(VERSIONS + "?page=" + encodeURIComponent(name));
      if (response.status !== 200) {
        return;
      }
      const payload = await page.json<{ versions?: unknown }>(response);
      if (payload && Array.isArray(payload.versions)) {
        const list = payload.versions as Version[];
        await changes;
        state.versions.value = list;
      }
    } catch {
      // No list: the page shows no versions.
    }
  })();
}
