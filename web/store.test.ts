// The comments store's state in signals (src/lotuspod/features/comments/
// ts/islands/comments/state.ts), filled by the store's reads of the comments
// and answers routes (comments/route.ts, comments/answers.ts), against
// stubbed routes, as the islands bundle holds them (islands.ts).

import { afterEach, expect, test } from "bun:test";
import { islands } from "./islands";

const { answerStore, readThreads, storeState } = await islands();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const page = {
  commentsURL: "/api/comments",
  async json<T>(response: Response): Promise<T | null> {
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  },
};

// The comments route, answering each read with the next of answers.
function route(...answers: object[]): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return Response.json(answers.shift());
  }) as typeof fetch;
  return asked;
}

const reader = { kind: "reader", handle: "ana", name: "Ana" };
const A = { id: 1, actor: reader, section: "intro", text: "Why this way?", state: "answered" };
const B = { id: 2, actor: reader, section: "plan", text: "And this?", state: "pending" };
const reply = { id: 3, actor: { kind: "agent", handle: "hermes" }, section: "intro", text: "Because." };

test("a read that changes only thread A runs A's consumer once more, and B's not at all", async () => {
  const state = storeState();
  const asked = route(
    { threads: [{ root: A, replies: [], resolution: null }, { root: B, replies: [], resolution: null }], unread: [] },
    { threads: [{ root: A, replies: [reply], resolution: null }, { root: B, replies: [], resolution: null }], unread: [3] },
  );
  expect(await readThreads(page, "pond", state)).not.toBeNull();
  expect(asked).toEqual(["/api/comments?page=pond"]);
  expect(state.threadIds.value).toEqual([1, 2]);

  // Each consumer runs once as it subscribes, then on each change.
  const seen = { a: [] as number[], b: [] as number[] };
  const stopA = state.thread(1).subscribe((thread) => seen.a.push(thread!.replies.length));
  const stopB = state.thread(2).subscribe((thread) => seen.b.push(thread!.replies.length));
  expect(seen).toEqual({ a: [0], b: [0] });

  await readThreads(page, "pond", state);
  expect(seen).toEqual({ a: [0, 1], b: [0] });
  expect(state.thread(1).value!.replies.map((each) => each.id)).toEqual([3]);
  expect([...state.unread.value]).toEqual([3]);
  stopA();
  stopB();
});

test("a read that changes nothing runs no consumer, and a 401 writes nothing", async () => {
  const state = storeState();
  const threads = [{ root: A, replies: [reply], resolution: null }];
  route({ threads, unread: [] }, { threads, unread: [] });
  await readThreads(page, "pond", state);
  let runs = 0;
  const stop = state.thread(1).subscribe(() => { runs += 1; });
  await readThreads(page, "pond", state);
  expect(runs).toBe(1);
  globalThis.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  expect(await readThreads(page, "pond", state)).toBe("signed out");
  expect(runs).toBe(1);
  stop();
});

const answer = (id: number, question: string, choice: string) =>
  ({ id, question, version: "v1", choice, createdAt: "2026-10-24T09:00:00Z", actor: reader });

test("a read of the answers that changes only question A runs A's consumer, and a read a newer one replaced writes nothing", async () => {
  const state = storeState();
  const answers = answerStore({ ...page, answersURL: "/api/answers" }, state);
  const first = { questions: { "decision-1": { current: answer(1, "decision-1", "a"), earlier: [] },
    "decision-2": { current: answer(2, "decision-2", "b"), earlier: [] } } };
  const second = { questions: { "decision-1": { current: answer(3, "decision-1", "c"), earlier: [answer(1, "decision-1", "a")] },
    "decision-2": { current: answer(2, "decision-2", "b"), earlier: [] } } };
  route(first, second);
  expect(await answers.read("pond")).toBe(true);
  const seen = { a: [] as (string | undefined)[], b: [] as (string | undefined)[] };
  state.answer("decision-1").subscribe((value) => seen.a.push(value.current?.choice));
  state.answer("decision-2").subscribe((value) => seen.b.push(value.current?.choice));
  expect(await answers.read("pond")).toBe(true);
  expect(seen).toEqual({ a: ["a", "c"], b: ["b"] });
  expect(state.currents.value.map((each) => each.id)).toEqual([3, 2]);

  // Two reads under way: the older one's answer is never written.
  const letGo: (() => void)[] = [];
  const replies = [{ questions: {} }, second];
  globalThis.fetch = (() => new Promise<Response>((resolve) => {
    const reply = replies.shift()!;
    letGo.push(() => resolve(Response.json(reply)));
  })) as unknown as typeof fetch;
  const older = answers.read("pond");
  const newer = answers.read("pond");
  letGo[0]!();
  expect(await older).toBeNull();
  letGo[1]!();
  expect(await newer).toBe(true);
  expect(seen.a).toEqual(["a", "c"]);
});
