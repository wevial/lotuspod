import { render, type ComponentChildren, type VNode } from "preact";
import type { CommentRow, Page, Thread, ThreadBridge } from "../bridge";

export function threadRows(page: Page, bridge: ThreadBridge) {
  const states = new WeakMap<Thread, State>();
  interface Drawn { entry: CommentRow; key: string; mark: VNode | null; attach(node: HTMLDivElement | null): void }
  interface State { drawn: Map<number, Drawn>; waitKey: string | null; typing: VNode | null; unread: Set<number> }
  // Only the verified actor kind identifies an agent, never its address.
  const agent = (row: CommentRow) => row.actor?.kind === "agent" ? String(row.actor.handle || "agent") : "";
  const author = (row: CommentRow) => String(row.actor?.name || row.actor?.handle || "someone");
  const routed = (row: CommentRow) => String(row.owner || bridge.owner || "an agent");
  const rows = (thread: Thread) => [thread.root, ...thread.replies];
  function state(thread: Thread): State {
    let value = states.get(thread);
    if (!value) {
      value = { drawn: new Map(), waitKey: null, typing: null, unread: new Set() };
      states.set(thread, value);
    }
    return value;
  }
  function mark(kind: string) {
    return <span class={"artifact-comment-mark artifact-comment-mark--" + kind} aria-hidden="true">
      {kind === "dots" && <><i /><i /><i /></>}
    </span>;
  }
  function row(className: string, avatar: string, text: string, children: ComponentChildren, quiet = false) {
    return <li class={"artifact-comment-row " + className} aria-hidden={quiet ? "true" : undefined}>
      <span class={"artifact-comment-avatar " + avatar} aria-hidden="true">{text}</span>
      <div class="artifact-comment-col">{children}</div>
    </li>;
  }
  function agentName(handle: string, model?: string) {
    return <><span class="artifact-comment-handle">{handle}</span>{" "}<span class="artifact-comment-agent">AGENT</span>
      {model && <>{" "}<span class="artifact-comment-model">{String(model)}</span></>}</>;
  }
  function comment(drawn: Drawn, unread: boolean) {
    const entry = drawn.entry, handle = agent(entry), name = handle || author(entry);
    return row("artifact-comment-item artifact-comment-item--" + (handle ? "agent" : "reader") +
      (unread ? " artifact-comment--unread" : ""), handle ? "artifact-comment-avatar--agent" : "",
      handle ? name.charAt(0).toUpperCase() : name.slice(0, 2).toUpperCase(), <>
        <p class="artifact-comment-by">{unread && <span key="new" class="artifact-comment-new">New</span>}
          {handle ? agentName(handle, entry.model) : <span class="artifact-comment-author">{name}</span>}
          {" "}<time class="artifact-comment-time" dateTime={String(entry.createdAt || "")}>{page.when(entry.createdAt)}</time>
        </p>
        {entry.answer && typeof entry.answer === "object" && <p class="artifact-comment-answered">Answered: {String(entry.answer.label || entry.answer.choice || "")}</p>}
        <div class="artifact-comment-text" id={"artifact-comment-text-" + entry.id} ref={drawn.attach} />
      </>);
  }
  function notice(state: string, kind: string, title: string, lines: string[], quiet = false) {
    return <li class={"artifact-comment-notice artifact-comment-notice--" + state} data-state={state} role="note" aria-hidden={quiet ? "true" : undefined}>
      <p class="artifact-comment-notice-title">{mark(kind)}<span>{title}</span></p>
      {lines.map(text => <p class="artifact-comment-notice-text">{text}</p>)}
    </li>;
  }
  function after(entry: CommentRow) {
    const handle = routed(entry);
    if (agent(entry)) return entry.revision ? <li class="artifact-comment-event"><span>{agent(entry) + " "}<a href={encodeURIComponent(bridge.page) + ".html"}>revised the page → revision <code>{String(entry.revision)}</code></a></span></li> : null;
    switch (entry.state) {
      case "unavailable": return notice("unavailable", "hollow", handle + " is offline", ["Your comment goes to " + handle + " when it checks in again."], true);
      case "paused": return notice("paused", "pause", "The responder is paused", ["Your comment waits until it is resumed."], true);
      case "failed": return notice("failed", "bang", handle + " couldn't answer", [entry.reason ? String(entry.reason) : "No reason given", "To send it again, write a new comment."]);
      default: return null;
    }
  }
  function typing(entry: CommentRow) {
    const handle = routed(entry);
    if (entry.state === "pending") return row("artifact-comment-typing artifact-comment-typing--pending", "artifact-comment-avatar--ghost", handle.charAt(0).toUpperCase(),
      <p class="artifact-comment-bubble artifact-comment-bubble--ghost">{(bridge.checking() ? "Checking for a reply from " : "Waiting for ") + handle}{mark("dots")}</p>, true);
    if (entry.state === "claimed") return row("artifact-comment-typing artifact-comment-typing--claimed", "artifact-comment-avatar--agent", handle.charAt(0).toUpperCase(), <>
      <p class="artifact-comment-by">{agentName(handle)} is writing</p>
      <p class="artifact-comment-bubble artifact-comment-bubble--typing">{mark("dots")}<span class="artifact-comment-sr">{handle + " is writing a reply"}</span></p>
    </>, true);
    return null;
  }
  // The list is an independent root: placement may move its thread container.
  // Keys insert new rows without re-inserting earlier live-region children.
  function paint(thread: Thread, value: State) {
    const children: VNode[] = [];
    let divided = false;
    for (const { id } of rows(thread)) {
      const drawn = value.drawn.get(id);
      if (!drawn) continue;
      const unread = value.unread.has(id);
      if (unread && !divided) {
        // Replace the divider when its anchor changes. Reusing one key lets
        // Preact move an existing comment around it in this polite live region.
        children.push(<li key={"divider " + id} class="artifact-comment-divider" aria-hidden="true"><span>New since you last looked</span></li>);
        divided = true;
      }
      const item = comment(drawn, unread);
      item.key = "row " + id;
      children.push(item);
      if (drawn.mark) children.push(drawn.mark);
    }
    if (value.typing) children.push(value.typing);
    render(<>{children}</>, thread.list);
  }
  function markUnread(thread: Thread) {
    const value = state(thread), held = bridge.opening.get(thread.root.id);
    value.unread = new Set(rows(thread).filter(entry => bridge.counted(thread, entry) || held?.has(entry.id)).map(entry => entry.id));
    paint(thread, value);
  }
  function sync(thread: Thread) {
    const value = state(thread);
    let touched = false, count = 0, newest: CommentRow | null = null;
    for (const entry of rows(thread)) {
      let drawn = value.drawn.get(entry.id);
      if (!drawn) {
        // The DOM builders run once, on the stable keyed row's first mount.
        let attached = false;
        drawn = { entry, key: "", mark: null, attach(node) {
          if (!node || attached) return;
          attached = true;
          page.commentMarkdown(node, String(entry.text || ""));
          const images = page.commentImages(entry);
          if (images) { node.hidden = !entry.text; node.after(images); }
        } };
        value.drawn.set(entry.id, drawn);
        count++; touched = true;
      }
      if (!agent(entry)) newest = entry;
      const key = agent(entry) ? (entry.revision ? "revision " + entry.revision : "") : [entry.state, routed(entry), entry.reason || ""].join("\n");
      if (key !== drawn.key) {
        drawn.mark = after(entry);
        if (drawn.mark) drawn.mark.key = "mark " + entry.id + " " + key;
        drawn.key = key; touched = true;
      }
    }
    const waitKey = newest ? [newest.state, routed(newest), bridge.checking()].join("\n") : "";
    if (waitKey !== value.waitKey) {
      value.typing = newest && typing(newest);
      if (value.typing) value.typing.key = "typing " + waitKey;
      value.waitKey = waitKey; touched = true;
    }
    paint(thread, value);
    bridge.label(thread, newest || thread.root);
    if (count && thread.box) thread.box.dispatchEvent(new CustomEvent(page.events.drawn, { bubbles: true, detail: { rows: count } }));
    return touched;
  }
  function merge(thread: Thread, entries: (CommentRow | null)[]) {
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.id === thread.root.id) { thread.root = entry; continue; }
      const known = thread.replies.findIndex(reply => reply.id === entry.id);
      if (known < 0) thread.replies.push(entry);
      else thread.replies[known] = entry;
    }
    thread.replies.sort((a, b) => a.id - b.id);
    return sync(thread);
  }
  return { agent, author, routed, rows, sync, merge, markUnread };
}
