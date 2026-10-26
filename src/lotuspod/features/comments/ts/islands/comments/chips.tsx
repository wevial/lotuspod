import { Fragment, render, type ComponentChildren } from "preact";
import type { ChipsBridge, CommentRow, Page, Thread } from "../bridge";
import { anchorOf } from "./anchor";
import { Tick } from "./thread-list";

export function chips(page: Page, bridge: ChipsBridge) {
  const { list, resolved, author, agent, routed, rows, unreadIn } = bridge;
  const decisions = new Map<HTMLFormElement, HTMLButtonElement>();
  const roots = new WeakSet<HTMLElement>();

  function mute(node: HTMLElement): HTMLElement {
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function Face({ text, agentFace = false }: { text: string; agentFace?: boolean }) {
    return <span class={"artifact-comment-chip-face" + (agentFace ? " artifact-comment-chip-face--agent" : "")}
      data-initial={text.charAt(0).toUpperCase()} />;
  }

  // Status comes from the same list helpers as the panel and narrow surfaces.
  function line(threads: Thread[], fresh: number, act = "Comment", totalResolved = 0) {
    const newest = list.latest(threads);
    const kind = totalResolved ? "resolved" : newest ? list.standing(newest) : "none";
    const signature: (string | number)[] = [kind, fresh];
    let faces: ComponentChildren = <span class="artifact-comment-chip-icon" />;
    let words: ComponentChildren = <>No comments{" · "}<span class="artifact-comment-chip-act">{act}</span></>;
    if (totalResolved) {
      signature.push(totalResolved);
      words = totalResolved + " resolved";
    } else if (newest) {
      const question = list.asked(newest);
      const handle = routed(question);
      signature.push(author(question).charAt(0).toUpperCase());
      faces = <Face text={author(question)} />;
      if (kind === "writing") {
        signature.push(handle);
        faces = <>{faces}<Face text={handle} agentFace /></>;
        words = <><span class="artifact-comment-chip-pulse" aria-hidden="true" />{handle + " is writing…"}</>;
      } else if (kind === "waiting") {
        const messages = threads.reduce((n, thread) => n + rows(thread).length, 0);
        signature.push(messages);
        words = <>{list.plural(messages, "comment", "comments")}{" · "}<span class="artifact-comment-chip-hollow" aria-hidden="true" />waiting</>;
      } else if (kind === "failed") {
        signature.push(handle);
        words = <><span class="artifact-comment-chip-bang" aria-hidden="true" />{handle + " couldn't answer"}</>;
      } else {
        let replies = 0;
        let answer: CommentRow | null = null;
        for (const thread of threads) {
          replies += thread.replies.length;
          for (const reply of thread.replies) {
            if (agent(reply) && (!answer || reply.id > answer.id)) answer = reply;
          }
        }
        const answerer = answer ? agent(answer) : handle;
        signature.push(replies, answerer);
        faces = <>{faces}<Face text={answerer} agentFace /></>;
        words = <>{list.plural(replies, "reply", "replies")}{" · "}<span class="artifact-comment-chip-done"><Tick />{" " + answerer + " answered"}</span></>;
      }
    }
    if (!newest && !totalResolved) signature.push(act);
    // Replace a changed line as a unit, as the served chip did. Retaining
    // text nodes across status changes would report their movement as CLS.
    return { kind, content: <Fragment key={signature.join("\n")}><span class="artifact-comment-chip-faces" aria-hidden="true">{faces}</span><span class="artifact-comment-chip-text">{words}{fresh > 0 && <>{" · "}<span class="artifact-comment-chip-unread">{fresh} new</span></>}</span></Fragment> };
  }

  function paint(node: HTMLElement, className: string, drawn: ReturnType<typeof line>) {
    // A served summary has a fallback line. Preact must never adopt it.
    if (!roots.has(node)) {
      node.replaceChildren();
      roots.add(node);
    }
    node.className = className + " artifact-comment-chip artifact-comment-chip--" + drawn.kind;
    render(drawn.content, node);
  }

  // A passage's, a live block's or a spot's thread counts on its section;
  // placement may use its mark, its block or its target instead.
  function anchor(thread: Thread): HTMLElement | null {
    const target = anchorOf(thread.root);
    switch (target.kind) {
      case "decision": {
        const decision = bridge.decisionOf(thread);
        return (decision && decisions.get(decision.form)) || thread.box?.querySelector("summary") || null;
      }
      case "passage":
      case "block":
      case "spot":
      case "section":
      case "page": return thread.box?.querySelector("summary") || null;
      default: { const missing: never = target; return missing; }
    }
  }

  function threadsOn(form: HTMLFormElement): Thread[] {
    return [...bridge.shown.values()].filter(thread => {
      const target = anchorOf(thread.root);
      switch (target.kind) {
        case "decision": return bridge.decisionOf(thread)?.form === form;
        case "passage":
        case "block":
        case "spot":
        case "section":
        case "page": return false;
        default: { const missing: never = target; return missing; }
      }
    }).sort((a, b) => a.root.id - b.root.id);
  }

  function openDecision(form: HTMLFormElement) {
    const threads = threadsOn(form);
    const thread = list.latest(threads.filter(each => !resolved(each))) || list.latest(threads);
    if (thread) bridge.reach(thread, decisions.get(form) || null, false);
  }

  function decisionChip(form: HTMLFormElement) {
    const threads = threadsOn(form);
    if (!threads.length) return;
    let node = decisions.get(form);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.addEventListener("click", () => openDecision(form));
      form.after(node);
      decisions.set(form, node);
    }
    const unresolved = threads.filter(thread => !resolved(thread));
    paint(node, "artifact-decision-chip", line(unresolved, unreadIn(threads), undefined,
      unresolved.length ? 0 : threads.length));
  }

  function mount(box: HTMLElement) {
    const summary = box.querySelector("summary")!;
    summary.addEventListener("click", event => {
      event.preventDefault();
      bridge.chipped(box);
    });
    summary.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        bridge.chipped(box);
      }
    });
    summary.addEventListener("keyup", event => {
      if (event.key === " ") event.preventDefault();
    });
    box.addEventListener("toggle", () => {
      if ((box as HTMLDetailsElement).open) (box as HTMLDetailsElement).open = false;
    });
  }

  return {
    anchor, mount, mute,
    forget(form: HTMLFormElement) {
      const node = decisions.get(form);
      if (node) render(null, node);
      decisions.delete(form);
    },
    refresh() {
      // A line drawn before the threads are read would say there are none.
      if (!bridge.settled()) return;
      bridge.boxes.forEach(box => {
        const threads = bridge.threadsOf(box);
        const unresolved = threads.filter(thread => !resolved(thread));
        paint(box.querySelector("summary")!, "artifact-comment-summary",
          line(unresolved, unreadIn(threads),
            box.dataset.section === page.wholePage ? "Comment on this page" : "Comment",
            unresolved.length ? 0 : threads.length));
      });
      bridge.decisions.forEach(decisionChip);
    },
  };
}
