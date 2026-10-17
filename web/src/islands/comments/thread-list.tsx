import { Component, createRef, render } from "preact";
import type { Page, Thread, ThreadListBridge } from "../bridge";
import type { Shell, Group, Entry } from "./parts";
import { anchorOf } from "./anchor";

// Each movable container is its own root. Thread bodies and forms are
// inserted by the page, never represented as children in the virtual tree.
export function threadList(page: Page, shell: Shell, bridge: ThreadListBridge) {
  const list = shell.list;
  const groups = new Map<HTMLElement, Group>();
  // The open entry, and the resolved entry explicitly opened to read.
  let current: Thread | null = null;
  let toRead: Thread | null = null;
  let serial = 0;
  function field(box: HTMLElement): HTMLTextAreaElement {
    return bridge.forms.get(box)!.elements.namedItem("text") as HTMLTextAreaElement;
  }
  function shellSections(): void {
    shell.sections(bridge.boxes.filter(box => groups.has(box)).map(box => {
      const made = groups.get(box)!;
      return { box, title: made.heading.textContent || "", id: made.optionId, section: box.dataset.section! };
    }));
  }
  function mount(box: HTMLElement, at: number): void {
    const made = group(title(box), box, serial++);
    made.node.hidden = true;
    const next = groups.get(bridge.boxes[at + 1]);
    list.insertBefore(made.node, (next || strays).node);
    groups.set(box, made);
    shellSections();
  }
  // The text of a box's section heading, without the mark a folded
  // heading ends in or the tag saying it changed.
  function title(box: HTMLElement) {
    var heading = document.getElementById(box.dataset.section!);
    if (!heading || heading.tagName !== "H2") {
      return "This page";
    }
    var copy = heading.cloneNode(true) as HTMLElement;
    bridge.all(".artifact-section-mark, .artifact-changed-tag, .artifact-review-open", copy).forEach(function (mark) { mark.remove(); });
    return (copy.textContent || "").replace(/\s+/g, " ").trim() || "This page";
  }

  // Only a popover or sheet shows the group's compose control; the panel
  // starts forms through the shell and returns focus there on Cancel or Escape.
  function group(name: string, box: HTMLElement | null, index: number): Group {
    const node = document.createElement("section");
    node.className = "artifact-comments-group";
    const heading = createRef<HTMLHeadingElement>();
    const entries = createRef<HTMLOListElement>();
    render(<><h3 ref={heading} class="artifact-comments-group-title">{name}</h3>
      <ol ref={entries} class="artifact-comments-entries" /></>, node);
    list.appendChild(node);
    // These containers move independently into narrow.js's surfaces.
    const toggle = document.createElement("button");
    const holder = document.createElement("div");
    const made: Group = { optionId: index, node, heading: heading.current!, entries: entries.current!, box, toggle, holder };
    if (box) {
      toggle.type = "button";
      toggle.className = "artifact-comments-new";
      holder.className = "artifact-comments-compose";
      holder.id = "artifact-comments-compose-" + index;
      holder.hidden = true;
      toggle.setAttribute("aria-controls", holder.id);
      toggle.setAttribute("aria-expanded", "false");
      toggle.disabled = page.archived;
      toggle.addEventListener("click", () => compose(made, Boolean(holder.hidden)));
      render(box.dataset.section === page.wholePage ? "Comment on this page" : "Comment on this section", toggle);
      render(<button type="button" class="artifact-comments-cancel" onClick={() => uncompose(made)}>Cancel</button>, holder);
      holder.addEventListener("keydown", event => {
        if (event.key === "Escape" && bridge.wide()) {
          event.preventDefault(); event.stopPropagation(); uncompose(made);
        }
      });
      node.append(toggle, holder);
    }
    return made;
  }

  // Whether a group holds a thread that is listed: an open one, or a
  // resolved one while they are shown.
  function showing(made: Group) {
    return Boolean(shell.resolvedShown() ? made.entries.firstChild :
      made.entries.querySelector(":scope > .artifact-comments-entry:not(.artifact-comments-entry--resolved)"));
  }

  // Whether a group is listed: it holds a listed thread, or a form open
  // in it.
  function busy(made: Group) {
    return showing(made) ||
      (!made.holder.hidden && made.node.contains(made.holder)) ||
      Boolean(made.node.querySelector(".artifact-passage-composer"));
  }

  // Keep the reader's place: the group at the top of the list stays where it is.
  function tidy() {
    shell.empty(bridge.shown.size === 0);
    strays.node.hidden = !showing(strays);
    var changes: Group[] = [];
    groups.forEach(function (made) {
      if (made.node.hidden === busy(made)) {
        changes.push(made);
      }
    });
    if (!changes.length) {
      return;
    }
    var top = list.getBoundingClientRect().top;
    var anchor = bridge.all(":scope > .artifact-comments-group:not([hidden])", list).filter(function (node) {
      return node.getBoundingClientRect().bottom > top;
    })[0];
    var before = anchor ? anchor.getBoundingClientRect().top : 0;
    changes.forEach(function (made) {
      made.node.hidden = !made.node.hidden;
    });
    if (anchor) {
      list.scrollTop += anchor.getBoundingClientRect().top - before;
    }
  }

  // Opening a panel form folds other empty forms, keeping drafts intact.
  function compose(made: Group, show: boolean) {
    if (show && page.archived) {
      return;
    }
    if (show && bridge.wide()) {
      groups.forEach(function (other) {
        if (other !== made && !other.holder.hidden && !field(other.box!).value) {
          other.holder.hidden = true;
          other.toggle.setAttribute("aria-expanded", "false");
        }
      });
    }
    made.holder.hidden = !show;
    made.toggle.setAttribute("aria-expanded", show ? "true" : "false");
    tidy();
    if (show) {
      if (bridge.wide()) {
        reveal(made.holder);
      } else {
        bridge.uncover(made.holder);
      }
      field(made.box!).focus({ preventScroll: true });
    }
  }

  // Fold a group's form in the panel; the focus goes to the control
  // that starts it again.
  function uncompose(made: Group) {
    compose(made, false);
    shell.focus(made.box!);
  }

  // Scroll the panel's list, never the page, until node is in view.
  function reveal(node: HTMLElement) {
    var outer = list.getBoundingClientRect();
    var inner = node.getBoundingClientRect();
    if (inner.top < outer.top || inner.bottom > outer.bottom) {
      list.scrollTop += inner.top - outer.top - 8;
    }
  }

  // The newest reader comment in a thread.
  function asked(thread: Thread) {
    var found = thread.root;
    bridge.rows(thread).forEach(function (entry) {
      if (!bridge.agent(entry)) {
        found = entry;
      }
    });
    return found;
  }

  function standing(thread: Thread) {
    switch (asked(thread).state) {
      case "claimed":
        return "writing";
      case "failed":
        return "failed";
      case "pending":
      case "unavailable":
      case "paused":
        return "waiting";
      default:
        return "answered";
    }
  }

  // Of some threads, the one whose newest reader comment is newest.
  function latest(threads: Thread[]): Thread | null {
    var found: Thread | null = null;
    threads.forEach(function (thread) {
      if (!found || asked(thread).id > asked(found).id) {
        found = thread;
      }
    });
    return found;
  }

  function unresolvedOf(box: HTMLElement) {
    return bridge.threadsOf(box).filter(function (thread) { return !bridge.resolved(thread); });
  }

  function plural(n: number, one: string, many: string) {
    return n + " " + (n === 1 ? one : many);
  }

  // The first words of what a thread's first comment says.
  function opening(text: string | undefined) {
    var words = String(text || "").replace(/\s+/g, " ").trim();
    return words.length > 80 ? words.slice(0, 80).replace(/\s\S*$/, "") + "…" : words;
  }

  function Tick() {
    return <span class="artifact-comments-tick" aria-hidden="true">✓</span>;
  }
  function tick(): HTMLSpanElement {
    const root = document.createElement("div");
    render(<Tick />, root);
    return root.firstElementChild as HTMLSpanElement;
  }

  function mark(thread: Thread): string {
    const anchor = anchorOf(thread.root);
    switch (anchor.kind) {
      case "passage": return thread.n ? String(thread.n) : "";
      case "decision": return bridge.decisionOf(thread) ? "?" : "§";
      case "page": case "section": return "§";
      default: { const missing: never = anchor; return missing; }
    }
  }

  function Words({ thread }: { thread: Thread }) {
    const anchor = anchorOf(thread.root);
    switch (anchor.kind) {
      case "passage": return <span class="artifact-comments-entry-words" ref={node => {
        if (node) node.replaceChildren(...bridge.passages.said(thread));
      }} />;
      case "decision": {
        const decision = bridge.decisionOf(thread);
        return <span class="artifact-comments-entry-words">{decision
          ? <><span class="artifact-comments-entry-kind">{decision.name}</span>{" · " + decision.question}</>
          : opening(thread.root.text || bridge.imageWords(thread.root))}</span>;
      }
      case "page": case "section": return <span class="artifact-comments-entry-words">{opening(thread.root.text || bridge.imageWords(thread.root))}</span>;
      default: { const missing: never = anchor; return missing; }
    }
  }
  // These components redraw only when draw changes their key. Polls and
  // layout moves leave the lead and status DOM intact.
  class Lead extends Component<{ thread: Thread }> {
    shouldComponentUpdate() { return false; }
    render() {
      const { thread } = this.props;
      return <><span class="artifact-comments-entry-mark" aria-hidden="true">{mark(thread)}</span>
        <Words thread={thread} /></>;
    }
  }
  function Said({ thread }: { thread: Thread }) {
    const kind = standing(thread);
    const handle = bridge.routed(asked(thread));
    return <span class={"artifact-comments-entry-said artifact-comments-entry-said--" + kind}>
      {kind === "answered" ? <><Tick />{" Answered"}</>
        : kind === "writing" ? handle + " is writing" : kind === "waiting" ? "Waiting for " + handle : handle + " couldn't answer"}
    </span>;
  }
  class SaidCount extends Component<{ thread: Thread }> {
    shouldComponentUpdate() { return false; }
    render() {
      const { thread } = this.props;
      return <><Said thread={thread} />{" · "}<span class="artifact-comments-entry-count">{plural(thread.replies.length, "reply", "replies")}</span></>;
    }
  }
  // narrow.js needs a movable DOM node for the same status words.
  function said(thread: Thread): HTMLElement {
    const root = document.createElement("div");
    render(<Said thread={thread} />, root);
    return root.firstElementChild as HTMLElement;
  }
  function entry(thread: Thread): Entry {
    if (!thread.entry) {
      const item = document.createElement("li");
      item.className = "artifact-comments-entry";
      item.dataset.thread = String(thread.root.id);
      item.addEventListener("mouseenter", () => bridge.passages.point(thread, "entry"));
      item.addEventListener("mouseleave", () => bridge.passages.point(null, "entry"));
      draw(thread, item);
    }
    return thread.entry!;
  }
  function draw(thread: Thread, item = thread.entry?.item): void {
    if (!item) { entry(thread); return; }
    const done = bridge.resolved(thread);
    if (!done && toRead === thread) toRead = null;
    const opened = done ? current === thread && toRead === thread : current === thread || bridge.holds(thread);
    const viewed = opened && (bridge.holds(thread) || (bridge.wide() && shell.isOpen()));
    if (!bridge.moving() && viewed !== thread.lit) {
      thread.lit = viewed;
      bridge.looked(thread, viewed);
    }
    const decision = bridge.decisionOf(thread);
    const leadKey = (decision ? "decision " + decision.name + "\n" + decision.question + "\n" : "") + bridge.passages.key(thread);
    const key = [standing(thread), bridge.routed(asked(thread)), thread.replies.length].join("\n");
    const anchor = anchorOf(thread.root);
    item.classList.toggle("artifact-comments-entry--resolved", done);
    item.classList.toggle("artifact-comments-entry--open", opened);
    item.classList.toggle("artifact-comments-entry--passage", anchor.kind === "passage");
    item.classList.toggle("artifact-comments-entry--detached", bridge.passages.detached(thread));
    item.classList.toggle("artifact-comments-entry--decision", Boolean(decision));
    const head = createRef<HTMLButtonElement>(), body = createRef<HTMLDivElement>();
    const resolve = createRef<HTMLButtonElement>(), reopen = createRef<HTMLButtonElement>(), status = createRef<HTMLParagraphElement>();
    const id = "artifact-comments-entry-" + thread.root.id;
    render(<>
      <button ref={head} type="button" class="artifact-comments-entry-head" hidden={done} aria-controls={id} aria-expanded={opened}
        onClick={() => { if (current === thread) expand(null); else { expand(thread); bridge.bring(thread); } }}>
        <Lead key={leadKey} thread={thread} /><span class="artifact-comments-entry-state"><SaidCount key={key} thread={thread} /></span>
      </button>
      <div class="artifact-comments-entry-resolved" hidden={!done}>
        <button type="button" class="artifact-comments-entry-read" aria-controls={id} aria-expanded={opened} onClick={() => {
          const was = current === thread && toRead === thread;
          toRead = was ? null : thread;
          expand(was ? null : thread);
          if (!was) bridge.bring(thread);
        }}><Lead key={leadKey} thread={thread} /></button>
        <span class="artifact-comments-entry-done"><Tick />{" resolved · "}
          <button ref={reopen} type="button" class="artifact-comments-reopen" onClick={() => settle(thread, false)}>Reopen</button></span>
      </div>
      <div ref={body} class="artifact-comments-entry-body" id={id} hidden={!opened}>
        <div class="artifact-comments-entry-tools"><span class="artifact-comments-entry-note"><SaidCount key={key} thread={thread} /></span>
          <button ref={resolve} type="button" class="artifact-comments-resolve" hidden={done} onClick={() => settle(thread, true)}>Resolve</button></div>
      </div>
      <p ref={status} class="artifact-comments-entry-status" role="status" />
    </>, item);
    thread.entry = { item, head: head.current!, body: body.current!, resolve: resolve.current!, reopen: reopen.current!, status: status.current! };
  }

  function expand(thread: Thread | null) {
    var before = current;
    current = thread;
    if (before && before !== thread) {
      draw(before);
      bridge.passages.shine(before);
    }
    if (thread) {
      draw(thread);
      bridge.passages.shine(thread);
      reveal(thread.entry!.item);
    }
  }

  async function settle(thread: Thread, resolve: boolean) {
    var made = entry(thread);
    var control = resolve ? made.resolve : made.reopen;
    var focused = document.activeElement === control;
    control.disabled = true;
    made.status.textContent = "Saving...";
    try {
      var response = await fetch(page.commentsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: bridge.page, thread: thread.root.id, resolved: resolve }),
      });
      var payload = await bridge.json(response);
      if (response.status !== 200 || !payload || !payload.resolution) {
        made.status.textContent = bridge.failure(response, payload);
        return;
      }
      made.status.textContent = "";
      thread.resolution = payload.resolution;
      if (resolve && current === thread) {
        current = null;
      }
      if (!resolve) {
        expand(thread);
      }
      bridge.refresh();
      if (focused) {
        // A popover or the sheet shows no head: Resolve takes the focus.
        // A thread resolved in the panel while resolved ones are hidden
        // leaves the list: the control showing them takes it.
        var gone = resolve && bridge.wide() && !shell.resolvedShown();
        if (gone) {
          shell.focus("resolved");
        } else {
          (resolve ? made.reopen : bridge.wide() ? made.head : made.resolve).focus({ preventScroll: true });
        }
      }
    } catch (ignored) {
      made.status.textContent = "Not saved: the site did not answer. Try again.";
    } finally {
      control.disabled = false;
    }
  }

  // Every thread in page order: each box's, oldest first, then those
  // on sections the page no longer has.
  function ordered() {
    var found: Thread[] = [];
    bridge.boxes.forEach(function (box) {
      found.push.apply(found, bridge.threadsOf(box));
    });
    var rest: Thread[] = [];
    bridge.shown.forEach(function (thread) {
      if (!thread.box) {
        rest.push(thread);
      }
    });
    return found.concat(rest.sort(function (a, b) { return a.root.id - b.root.id; }));
  }

  // Where a thread is listed in its group: its passages by number, then
  // its resolved passages, then its decisions' threads in the decisions'
  // order, then its § threads, each oldest first.
  function rank(thread: Thread): [number, number, number] {
    const anchor = anchorOf(thread.root);
    switch (anchor.kind) {
      case "passage": return thread.n ? [0, thread.n, 0] : [1, thread.root.id, 0];
      case "decision": {
        const decision = bridge.decisionOf(thread);
        return decision ? [2, bridge.decisions.indexOf(decision.form), thread.root.id] : [3, 0, thread.root.id];
      }
      case "page": case "section": return [3, 0, thread.root.id];
      default: { const missing: never = anchor; return missing; }
    }
  }

  // Put a group's entries in order, moving only those out of place.
  function sort(made: Group) {
    var threads = bridge.all(":scope > li", made.entries).map(function (item) {
      return bridge.shown.get(Number(item.dataset.thread))!;
    });
    threads.sort(function (a, b) {
      var left = rank(a);
      var right = rank(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });
    threads.forEach(function (thread, index) {
      var at = made.entries.children[index];
      if (at !== thread.entry!.item) {
        made.entries.insertBefore(thread.entry!.item, at);
      }
    });
  }

  function refreshList() {
    var threads = ordered();
    var unresolved = threads.filter(function (thread) { return !bridge.resolved(thread); });
    shell.refresh({
      open: unresolved.map(function (thread) { return { id: thread.root.id, standing: standing(thread) }; }),
      resolved: threads.length - unresolved.length,
      none: bridge.shown.size === 0,
    });
    threads.forEach(thread => draw(thread));
    groups.forEach(sort);
    sort(strays);
    tidy();
  }

  const strays = group(page.changedGroup, null, -1);
  strays.node.hidden = true;
  bridge.boxes.forEach(mount);
  function replace(old: HTMLElement, box: HTMLElement): void {
    const made = groups.get(old)!;
    groups.delete(old);
    groups.set(box, made);
    made.box = box;
    render(title(box), made.heading);
    shellSections();
  }
  return { groups, strays, mount, replace, shellSections, title, showing, tidy, compose, reveal,
    asked, standing, latest, unresolvedOf, plural, opening, tick, entry, draw, said, expand, ordered, sort,
    refresh: refreshList,
    get current() { return current; },
    get toRead() { return toRead; }, set toRead(value: Thread | null) { toRead = value; },
  };
}
