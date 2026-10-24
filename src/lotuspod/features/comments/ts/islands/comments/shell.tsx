import { createPortal, createRef, render } from "preact";
import { effect, untracked } from "@preact/signals";
import type { Page } from "../bridge";
import type { Section, Shell, ShellHooks, Tab, Tally } from "./parts";
import { decisionsTab } from "./tabs";

// A detached root owns only its portal. The groups list stays empty in the
// virtual tree: thread-list roots and the resize handle are never Preact children,
// nor is the Decisions tab's root, which the decisions island draws.
// On a page that asks questions the head is two tabs, Decisions and Comments:
// the panel shows Decisions until something chooses a tab, and the threads
// are in view only while the Comments tab shows them. On a page that takes
// no comments (comments false) the head is the Decisions tab alone, with no
// way to start a thread, and the rail holds only "N to answer".
export function shell(page: Page, hooks: ShellHooks, comments = true): Shell {
  const root = document.createElement("div");
  const panel = createRef<HTMLElement>();
  const list = createRef<HTMLDivElement>();
  const fold = createRef<HTMLButtonElement>();
  const opener = createRef<HTMLButtonElement>();
  const resolved = createRef<HTMLButtonElement>();
  const pick = createRef<HTMLButtonElement>();
  const onPage = createRef<HTMLButtonElement>();
  const choices = createRef<HTMLUListElement>();
  const start = createRef<HTMLDivElement>();
  const decisions = createRef<HTMLDivElement>();
  const tabs = { decisions: createRef<HTMLButtonElement>(), comments: createRef<HTMLButtonElement>() };
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
  const tabbed = () => decisionsTab.asks.peek();
  const showing = (): Tab => !comments ? "decisions" : tabbed() ? chosen ?? "decisions" : "comments";
  // Whether the threads are in view: the panel open on its Comments tab.
  const seen = () => open && showing() === "comments";
  const whole = () => sections.find(s => s.section === page.wholePage)
    || sections.find(s => s.section === "page");
  const focus = (control: "fold" | "opener" | "resolved" | "decisions" | HTMLElement) => {
    const node = control === "fold" ? fold.current : control === "opener" ? opener.current ?? toAnswer.current
      : control === "resolved" ? resolved.current : control === "decisions" ? tabs.decisions.current
      : control === whole()?.box ? onPage.current : pick.current;
    node?.focus({ preventScroll: true });
  };
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
    if (focused) pick.current?.focus({ preventScroll: true });
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
  function tabKey(event: KeyboardEvent): void {
    if (!comments) return;
    const order: Tab[] = ["decisions", "comments"];
    const at = order.indexOf(showing());
    const to = event.key === "ArrowRight" || event.key === "ArrowLeft" ? order[(at + 1) % 2]
      : event.key === "Home" ? order[0] : event.key === "End" ? order[1] : null;
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
    const asks = tabbed();
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
          {comments && <ol class="artifact-comments-dots" aria-hidden="true">
            {tally.open.map(thread => <li key={thread.id} class={`artifact-comments-dot artifact-comments-dot--${thread.standing}`} />)}
          </ol>}
          <span class="artifact-comments-rail-label" aria-hidden="true">{comments ? "Comments" : "Decisions"}</span>
        </div>
        <div class="artifact-comments-sheet" id="artifact-comments-sheet" hidden={!open}>
          <header class={"artifact-comments-head" + (asks ? " artifact-comments-head--tabs" : "")}>
            {asks ? <div class="artifact-comments-tabs" role="tablist"
              aria-label={comments ? "Decisions and comments" : "Decisions"} onKeyDown={tabKey}>
              <button ref={tabs.decisions} type="button" role="tab" class="artifact-comments-tab"
                id="artifact-comments-tab-decisions" aria-controls="artifact-comments-decisions"
                aria-selected={shown === "decisions"} tabIndex={shown === "decisions" ? 0 : -1}
                onClick={() => select("decisions", false)}>
                Decisions
                <span class={"artifact-comments-tab-badge" + (count === 0 ? " artifact-comments-tab-badge--done" : "")}
                  hidden={count === null}>{count ? String(count) : "✓"}</span>
              </button>
              {comments && <button ref={tabs.comments} type="button" role="tab" class="artifact-comments-tab"
                id="artifact-comments-tab-comments" aria-controls="artifact-comments-sheet-comments"
                aria-selected={shown === "comments"} tabIndex={shown === "comments" ? 0 : -1}
                onClick={() => select("comments", false)}>
                Comments
                <span class="artifact-comments-tab-badge">{tally.open.length}</span>
              </button>}
            </div> : <h2 class="artifact-comments-title">Comments</h2>}
            {!asks && counts}
            <button ref={fold} type="button" class="artifact-comments-fold"
              aria-label={comments ? "Fold comments" : "Fold decisions"}
              onClick={() => { setOpen(false, true); focus("opener"); }}><span aria-hidden="true">»</span></button>
          </header>
          <div ref={decisions} class="artifact-comments-decisions" id="artifact-comments-decisions" role="tabpanel"
            aria-labelledby="artifact-comments-tab-decisions" hidden={shown !== "decisions"} />
          {/* The Comments tab's panel holds the ways to start a thread and the
              threads themselves. */}
          <div class="artifact-comments-threads" id="artifact-comments-sheet-comments" hidden={shown !== "comments"}
            role={asks ? "tabpanel" : undefined} aria-labelledby={asks ? "artifact-comments-tab-comments" : undefined}>
            {comments && <div ref={start} class="artifact-comments-start">
              {asks && counts}
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
        </div>
      </aside>, document.body), root);
    // Other scripts own modifiers such as --resizing. Update only ours.
    panel.current!.classList.toggle("artifact-comments-panel--open", open);
    panel.current!.classList.toggle("artifact-comments-panel--resolved-shown", resolvedShown);
  }
  draw();
  decisionsTab.node.value = decisions.current;
  // Whether the page asks questions, and how many are to answer, draw the
  // head and the rail again.
  effect(() => {
    decisionsTab.asks.value;
    decisionsTab.count.value;
    untracked(draw);
  });
  document.addEventListener("click", event => {
    if (!picking || (event.target instanceof Node && start.current?.contains(event.target))) return;
    unpick(document.activeElement === document.body || !!start.current?.contains(document.activeElement));
  }, true);
  return {
    list: list.current!, isOpen: seen, resolvedShown: () => resolvedShown,
    setOpen, decide, setResolvedShown, unpick, focus,
    hidden(hide) { hidden = hide; draw(); },
    sections(next) { sections = next; active = -1; draw(); },
    refresh(next) { tally = next; draw(); },
    empty(none) { if (tally.none !== none) { tally = { ...tally, none }; draw(); } },
    unlit() { if (picking) light(-1); },
  };
}
