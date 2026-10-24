import { batch } from "@preact/signals";
import type { Read, StoreState } from "./state";
import { shared } from "./state";

// What the comments route's read gives.
export interface Payload { threads?: Read[] | null; unread?: unknown; revision?: unknown; maxImageBytes?: unknown }

// What the read reaches the page by.
interface RoutePage {
  commentsURL: string;
  json<T>(response: Response): Promise<T | null>;
}

export const SIGNED_OUT = "signed out";

// One read of the comments route for page name, as the store makes it: its
// payload once answered 200, SIGNED_OUT on 401, else null. The threads and
// the replies to the reader it names are written to their signals in one
// batch, each thread's only when it changed. A fetch that fails throws.
export async function readThreads(page: RoutePage, name: string,
  state: StoreState = shared): Promise<Payload | typeof SIGNED_OUT | null> {
  const response = await fetch(page.commentsURL + "?page=" + encodeURIComponent(name));
  if (response.status === 401) return SIGNED_OUT;
  const payload = response.status === 200 ? await page.json<Payload>(response) : null;
  if (payload) {
    batch(() => {
      state.write.named(payload.unread);
      (payload.threads || []).forEach(state.write.take);
    });
  }
  return payload;
}
