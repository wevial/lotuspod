import { createPortal, createRef, render } from "preact";
import { effect, untracked } from "@preact/signals";
import type { Page } from "../bridge";
import type { Section, Shell, ShellHooks, Tab, Tally } from "./parts";
import { decisionsTab, historyTab } from "./tabs";

// A detached root owns only its portal. The groups list stays empty in the
// virtual tree: thread-list roots and the resize handle are never Preact children,
// nor are the Decisions and History tabs' roots, which the decisions and
// history islands draw.
// On a page that asks questions, or lists its versions, the head is tabs:
// Decisions while it asks, Comments while it takes comments and History
// while it lists versions, in that order. The panel shows Decisions, else
// Comments, until something chooses a tab, and the threads are in view only
// while the Comments tab shows them. On a page that takes no comments
// (comments false) there is no Comments tab, no way to start a thread, and
// the rail holds only "N to answer" and the History mark. History opens only
// when the reader chooses it.
export function shell(page: Page, hooks: ShellHooks, comments = true): Shell {
  const root = document.createElement("div");
  const panel = createRef<HTMLElement>();
  const list = createRef<HTMLDivElement>();
  const scroller = createRef<HTMLDivElement>();
  const fold = createRef<HTMLButtonElement>();
  const opener = createRef<HTMLButtonElement>();
  const resolved = createRef<HTMLButtonElement>();
  const pick = createRef<HTMLButtonElement>();
  const onPage = createRef<HTMLButtonElement>();
  const choices = createRef<HTMLUListElement>();
  const start = createRef<HTMLDivElement>();
  const decisions = createRef<HTMLDivElement>();
  const history = createRef<HTMLDivElement>();
  const tabs = {
    decisions: createRef<HTMLButtonElement>(), comments: createRef<HTMLButtonElement>(),
    history: createRef<HTMLButtonElement>(),
  };
  const toAnswer = createRef<HTMLButtonElement>();
  let open = false;
  let chosen: Tab | null = null;
  let resolvedShown = false;
  const resolvedKey = page.resolvedShownKey + location.pathname;
  try { open = localStorage.getItem(page.panelKey) === "open"; } catch { /* Unremembered. */ }
  try { resolvedShown = sessionStorage.getItem(resolvedKey) === "1"; } catch { /* Hidden. */ }
  let hidden = true;
  let sections: Section[] = [];
  let tally: Tally = { open: [], resolved: 0, none: true };
  let picking = false;
  let active = -1;
  // The tabs the head holds, in order.
  const present = (): Tab[] => (["decisions", "comments", "history"] as const).filter(tab =>
    tab === "decisions" ? decisionsTab.asks.peek() : tab === "comments" ? comments : historyTab.shown.peek());
  const showing = (): Tab => {
    const order = present();
    return chosen && order.includes(chosen) ? chosen : order[0] ?? "decisions";
  };
  // Whether the threads are in view: the panel open on its Comments tab.
  const seen = () => open && showing() === "comments";
  // Whether the questions are: the panel open on its Decisions tab.
  const deciding = () => open && showing() === "decisions";
  // Whether what changed is: the panel open on its History tab.
  const reading = () => open && showing() === "history";
  const whole = () => sections.find(s => s.section === page.wholePage)
    || sections.find(s => s.section === "page");
  const focus = (control: "fold" | "opener" | "resolved" | "decisions" | HTMLElement) => {
    const node = control === "fold" ? fold.current : control === "opener" ? opener.current ?? toAnswer.current
      : control === "resolved" ? resolved.current : control === "decisions" ? tabs.decisions.current
      : control === whole()?.box ? onPage.current : pick.current;
    node?.focus({ preventScroll: true });
    if (node) show(node);
  };
  // The start controls scroll with the threads: bring one the focus returns
  // to back into the panel's view, never scrolling the page.
  function show(node: HTMLElement): void {
    const area = scroller.current;
    if (!area?.contains(node)) return;
    const outer = area.getBoundingClientRect();
    const inner = node.getBoundingClientRect();
    if (inner.top < outer.top || inner.bottom > outer.bottom) area.scrollTop += inner.top - outer.top - 8;
  }
  function light(index: number): void {
    active = index;
    draw();
    const option = choices.current?.children[index] as HTMLElement | undefined;
    const node = choices.current;
    if (!option || !node) return;
    if (option.offsetTop < node.scrollTop) node.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > node.scrollTop + node.clientHeight) {
      node.scrollTop = option.offsetTop + option.offsetHeight - node.clientHeight;
    }
  }
  function unpick(focused: boolean): void {
    if (!picking) return;
    picking = false;
    light(-1);
    if (focused && pick.current) {
      pick.current.focus({ preventScroll: true });
      show(pick.current);
    }
  }
  function choose(section: Section): void {
    unpick(false);
    hooks.compose(section.box);
  }
  // Opened, the panel shows tab.
  function setOpen(show: boolean, remember: boolean, tab: Tab = "comments"): void {
    const was = open;
    const wasSeen = seen();
    open = show;
    if (show) chosen = tab;
    if (show !== was || seen() !== wasSeen) queueMicrotask(hooks.opened);
    draw();
    if (remember) {
      try { localStorage.setItem(page.panelKey, show ? "open" : "folded"); } catch { /* Unremembered. */ }
    }
  }
  function select(tab: Tab, focused: boolean): void {
    const wasSeen = seen();
    chosen = tab;
    if (seen() !== wasSeen) queueMicrotask(hooks.opened);
    draw();
    if (focused) tabs[tab].current?.focus({ preventScroll: true });
  }
  // The title bar's count: the panel opens on Decisions, the focus on the
  // first question to answer, else on the tab.
  function decide(): void {
    setOpen(true, true, "decisions");
    const question = decisions.current?.querySelector<HTMLElement>(".artifact-decisions-entry .artifact-decisions-question");
    (question ?? tabs.decisions.current)?.focus({ preventScroll: true });
  }
  // The title bar's "N changed" and the header's "Versions · N": the panel
  // opens on History, the focus on the tab.
  function openHistory(): void {
    setOpen(true, true, "history");
    tabs.history.current?.focus({ preventScroll: true });
  }
  function tabKey(event: KeyboardEvent): void {
    const order = present();
    const last = order.length - 1;
    if (last < 1) return;
    const at = order.indexOf(showing());
    const to = event.key === "ArrowRight" ? order[at === last ? 0 : at + 1]
      : event.key === "ArrowLeft" ? order[at === 0 ? last : at - 1]
      : event.key === "Home" ? order[0] : event.key === "End" ? order[last] : null;
    if (!to) return;
    event.preventDefault();
    select(to, true);
  }
  function setResolvedShown(show: boolean, remember: boolean): void {
    resolvedShown = show;
    draw();
    if (remember) {
      try {
        if (show) sessionStorage.setItem(resolvedKey, "1");
        else sessionStorage.removeItem(resolvedKey);
      } catch { /* Unremembered. */ }
    }
  }
  function keydown(event: KeyboardEvent): void {
    const last = sections.length - 1;
    if (event.key === "ArrowDown") light(Math.min(active + 1, last));
    else if (event.key === "ArrowUp") light(active < 0 ? last : Math.max(active - 1, 0));
    else if (event.key === "Home") light(0);
    else if (event.key === "End") light(last);
    else if (event.key === "Enter" || event.key === " ") {
      if (active >= 0) choose(sections[active]);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      unpick(true);
    } else {
      if (event.key === "Tab") unpick(false);
      return;
    }
    event.preventDefault();
  }
  // Synchronous renders let callers inspect layout and move groups immediately.
  function draw(): void {
    const asks = decisionsTab.asks.peek();
    const listed = historyTab.shown.peek();
    const unseen = historyTab.unseen.peek();
    const tabbed = asks || listed;
    const names = present().map((tab, at) => at ? tab : tab[0].toUpperCase() + tab.slice(1));
    const shown = showing();
    const count = decisionsTab.count.peek();
    const counts = (
      <div class="artifact-comments-tally">
        <p class="artifact-comments-count" id="artifact-comments-count">{tally.open.length} open · {tally.resolved} resolved</p>
        <button ref={resolved} type="button" class="artifact-comments-show-resolved" hidden={!tally.resolved}
          aria-pressed={resolvedShown} onClick={() => { setResolvedShown(!resolvedShown, true); hooks.resolvedChanged(); }}>
          {resolvedShown ? "Hide resolved" : `Show resolved (${tally.resolved})`}
        </button>
      </div>
    );
    render(createPortal(
      <aside ref={panel} class="artifact-comments-panel"
        aria-label={comments ? "Comments" : "Decisions"} hidden={hidden} onKeyDown={event => {
          if (event.key === "Escape" && open) {
            event.preventDefault(); setOpen(false, true); focus("opener");
          }
        }}>
        <div class="artifact-comments-rail" hidden={open} onClick={() => { setOpen(true, true); focus("fold"); }}>
          {comments && <button ref={opener} type="button" class="artifact-comments-opener" aria-label="Comments"
            aria-controls="artifact-comments-sheet" aria-describedby="artifact-comments-count" aria-expanded={open}>
            <span class="artifact-comments-icon" aria-hidden="true" />
          </button>}
          {comments && <span class="artifact-comments-badge" hidden={!tally.open.length}>{tally.open.length}</span>}
          {asks && <button ref={toAnswer} type="button" hidden={count === null}
            class={"artifact-comments-to-answer" + (count === 0 ? " artifact-comments-to-answer--done" : "")}
            aria-label={(count ? `${count} to answer` : "All answered") + ": open the questions"}
            aria-controls="artifact-comments-decisions" onClick={event => {
              event.stopPropagation(); setOpen(true, true, "decisions"); focus("decisions");
            }}>
            <span class="artifact-comments-to-answer-count" aria-hidden="true">{count ? String(count) : "✓"}</span>
            <span class="artifact-comments-to-answer-label" aria-hidden="true">{count ? "to answer" : "answered"}</span>
          </button>}
          {unseen > 0 && <button type="button" class="artifact-comments-rail-history"
            aria-label="Changed since you last looked: open History" aria-controls="artifact-comments-history"
            onClick={event => { event.stopPropagation(); openHistory(); }}>
            <span class="artifact-comments-rail-history-dot" aria-hidden="true" />
            <span class="artifact-comments-rail-history-label" aria-hidden="true">changed</span>
          </button>}
          {comments && <ol class="artifact-comments-dots" aria-hidden="true">
            {tally.open.map(thread => <li key={thread.id} class={`artifact-comments-dot artifact-comments-dot--${thread.standing}`} />)}
          </ol>}
          <span class="artifact-comments-rail-label" aria-hidden="true">{comments ? "Comments" : "Decisions"}</span>
        </div>
        <div class="artifact-comments-sheet" id="artifact-comments-sheet" hidden={!open}>
          <header class={"artifact-comments-head" + (tabbed ? " artifact-comments-head--tabs" : "")}>
            {tabbed ? <div class="artifact-comments-tabs" role="tablist"
              aria-label={names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0]}
              onKeyDown={tabKey}>
              {asks && <button ref={tabs.decisions} type="button" role="tab" class="artifact-comments-tab"
                id="artifact-comments-tab-decisions" aria-controls="artifact-comments-decisions"
                aria-selected={shown === "decisions"} tabIndex={shown === "decisions" ? 0 : -1}
                onClick={() => select("decisions", false)}>
                Decisions
                <span class={"artifact-comments-tab-badge" + (count === 0 ? " artifact-comments-tab-badge--done" : "")}
                  hidden={count === null}>{count ? String(count) : "✓"}</span>
              </button>}
              {comments && <button ref={tabs.comments} type="button" role="tab" class="artifact-comments-tab"
                id="artifact-comments-tab-comments" aria-controls="artifact-comments-sheet-comments"
                aria-selected={shown === "comments"} tabIndex={shown === "comments" ? 0 : -1}
                onClick={() => select("comments", false)}>
                Comments
                <span class="artifact-comments-tab-badge">{tally.open.length}</span>
              </button>}
              {listed && <button ref={tabs.history} type="button" role="tab" class="artifact-comments-tab"
                id="artifact-comments-tab-history" aria-controls="artifact-comments-history"
                aria-selected={shown === "history"} tabIndex={shown === "history" ? 0 : -1}
                onClick={() => select("history", false)}>
                <span>History{unseen > 0 && <span class="artifact-comments-tab-unseen">
                  {`, ${unseen} ${unseen === 1 ? "section" : "sections"} changed`}</span>}</span>
                {unseen > 0 && <span class="artifact-comments-tab-dot" aria-hidden="true" />}
              </button>}
            </div> : <h2 class="artifact-comments-title">Comments</h2>}
            {!tabbed && counts}
            <button ref={fold} type="button" class="artifact-comments-fold"
              aria-label={comments ? "Fold comments" : "Fold decisions"}
              onClick={() => { setOpen(false, true); focus("opener"); }}><span aria-hidden="true">»</span></button>
          </header>
          <div ref={decisions} class="artifact-comments-decisions" id="artifact-comments-decisions" role="tabpanel"
            aria-labelledby="artifact-comments-tab-decisions" hidden={shown !== "decisions"} />
          {/* The Comments tab's panel holds the ways to start a thread and the
              threads themselves, and scrolls them together. */}
          <div ref={scroller} class="artifact-comments-threads" id="artifact-comments-sheet-comments" hidden={shown !== "comments"}
            role={tabbed ? "tabpanel" : undefined} aria-labelledby={tabbed ? "artifact-comments-tab-comments" : undefined}>
            {comments && <div ref={start} class="artifact-comments-start">
              {tabbed && counts}
              {page.archived && <p class="artifact-comments-closed">{page.closed}</p>}
              <p class="artifact-comments-none" hidden={!tally.none}>No comments yet</p>
              {whole() && <button ref={onPage} type="button" class="artifact-comments-on-page" disabled={page.archived}
                onClick={() => choose(whole()!)}>Comment on this page</button>}
              <button ref={pick} type="button" class="artifact-comments-pick" disabled={page.archived}
                aria-haspopup="listbox" aria-expanded={picking} aria-controls="artifact-comments-choices" onClick={() => {
                  if (picking) { unpick(true); return; }
                  picking = true; light(-1); choices.current?.focus({ preventScroll: true });
                }}>Comment on a section</button>
              <ul ref={choices} class="artifact-comments-choices" id="artifact-comments-choices" role="listbox"
                aria-label="Sections" tabIndex={-1} hidden={!picking} onKeyDown={keydown}
                aria-activedescendant={active < 0 ? undefined : `artifact-comments-choice-${sections[active]?.id}`}>
                {sections.map((section, index) => <li key={section.id} class="artifact-comments-choice"
                  id={`artifact-comments-choice-${section.id}`} role="option" aria-selected={index === active}
                  onClick={() => choose(section)}>{section.title}</li>)}
              </ul>
            </div>}
            <div ref={list} class="artifact-comments-groups" />
          </div>
          {/* The History tab's panel scrolls on its own, beside the threads. */}
          <div ref={history} class="artifact-comments-history" id="artifact-comments-history" role="tabpanel"
            aria-labelledby="artifact-comments-tab-history" hidden={shown !== "history"} />
        </div>
      </aside>, document.body), root);
    // Other scripts own modifiers such as --resizing. Update only ours.
    panel.current!.classList.toggle("artifact-comments-panel--open", open);
    panel.current!.classList.toggle("artifact-comments-panel--resolved-shown", resolvedShown);
  }
  draw();
  decisionsTab.node.value = decisions.current;
  historyTab.node.value = history.current;
  // Whether the page asks questions, how many are to answer, whether it
  // lists its versions and how many sections changed unseen, draw the head
  // and the rail again.
  effect(() => {
    decisionsTab.asks.value;
    decisionsTab.count.value;
    historyTab.shown.value;
    historyTab.unseen.value;
    untracked(draw);
  });
  document.addEventListener("click", event => {
    if (!picking || (event.target instanceof Node && start.current?.contains(event.target))) return;
    unpick(document.activeElement === document.body || !!start.current?.contains(document.activeElement));
  }, true);
  return {
    list: list.current!, scroller: scroller.current!, isOpen: seen, deciding, reading, resolvedShown: () => resolvedShown,
    setOpen, decide, history: openHistory, setResolvedShown, unpick, focus,
    hidden(hide) { hidden = hide; draw(); },
    sections(next) { sections = next; active = -1; draw(); },
    refresh(next) { tally = next; draw(); },
    empty(none) { if (tally.none !== none) { tally = { ...tally, none }; draw(); } },
    unlit() { if (picking) light(-1); },
  };
}
