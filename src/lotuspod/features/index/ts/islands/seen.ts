import { answered, type Seen, type SeenEntry } from "./state";

const SEEN = "/api/seen";

// The ticks from serve's stream (features/live/ts/live-events.ts) that read
// the route again.
export const TICKS = new Set(["publish", "index", "comment", "resync"]);

export type Dot = "version" | "replies";

// The dot a tab not active shows from its pod's entry: amber when the pod
// was published since the reader last opened it, else orchid when someone
// else has commented since; none on the active tab, nor with no answer of
// 200.
export function dotOf(seen: Seen | null, name: string, active: string | null): Dot | null {
  const entry: SeenEntry | undefined = seen && Object.prototype.hasOwnProperty.call(seen, name) ? seen[name] : undefined;
  if (!entry || name === active) return null;
  if (typeof entry.seen === "string" && entry.seen !== entry.revision) return "version";
  if (Number.isInteger(entry.replies) && (entry.replies as number) > 0) return "replies";
  return null;
}

// At most one read of ask in flight, and one more asked after it however
// many callers ask meanwhile: each caller's promise settles once a read
// begun after its call has. A read of the seen route can take seconds on a
// busy serve, and a pile of them, with the change stream's connection,
// would leave a framed page none of the browser's connections to load on.
function single(ask: () => Promise<void>): () => Promise<void> {
  let flying: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const run = (): Promise<void> => {
    if (!flying) {
      flying = ask().finally(() => {
        flying = null;
      });
      return flying;
    }
    if (!queued) {
      queued = flying.then(() => {
        queued = null;
        return run();
      });
    }
    return queued;
  };
  return run;
}

// Answers are drawn in the order they were asked: a later read wins.
let asked = 0;
export const askSeen = single(async () => {
  const ask = ++asked;
  let pages: Seen | null = null;
  try {
    const response = await fetch(SEEN, { cache: "no-store" });
    if (response.status === 200) {
      const payload = await response.json();
      if (payload && typeof payload.pages === "object" && payload.pages) pages = payload.pages;
    }
  } catch {
    // Shown as if the route had not answered.
  }
  if (ask !== asked) return;
  answered(pages);
});

// The revision the framed page was rendered at: "" once a page with no
// stamp has loaded, null before.
export function revisionOf(frame: HTMLIFrameElement | null): string | null {
  try {
    const framed = frame!.contentDocument!;
    const stamp = framed.querySelector<HTMLMetaElement>('meta[name="lotuspod:revision"]');
    if (stamp) return stamp.content.trim();
    return framed.URL !== "about:blank" && framed.readyState === "complete" ? "" : null;
  } catch {
    return null;
  }
}

// Mark the pod read at the revision its frame shows, then read the route.
export async function markSeen(name: string, frame: HTMLIFrameElement | null): Promise<void> {
  const revision = revisionOf(frame);
  if (revision !== null) {
    try {
      await fetch(SEEN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: name, revision }),
      });
    } catch {
      // Read as it is.
    }
  }
  await askSeen();
}
