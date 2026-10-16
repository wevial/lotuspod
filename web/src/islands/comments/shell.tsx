import { createPortal, createRef, render } from "preact";
import type { Page } from "../bridge";
import type { Section, Shell, ShellHooks, Tally } from "./parts";

// A detached root owns only its portal. The groups list stays empty in the
// virtual tree: thread-list roots and the resize handle are never Preact children.
export function shell(page: Page, hooks: ShellHooks): Shell {
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
  let open = false;
  let resolvedShown = false;
  const resolvedKey = page.resolvedShownKey + location.pathname;
  try { open = localStorage.getItem(page.panelKey) === "open"; } catch { /* Unremembered. */ }
  try { resolvedShown = sessionStorage.getItem(resolvedKey) === "1"; } catch { /* Hidden. */ }
  let hidden = true;
  let sections: Section[] = [];
  let tally: Tally = { open: [], resolved: 0, none: true };
  let picking = false;
  let active = -1;
  const whole = () => sections.find(s => s.section === page.wholePage)
    || sections.find(s => s.section === "page");
  const focus = (control: "fold" | "opener" | "resolved" | HTMLElement) => {
    const node = control === "fold" ? fold.current : control === "opener" ? opener.current
      : control === "resolved" ? resolved.current
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
  function setOpen(show: boolean, remember: boolean): void {
    const was = open;
    open = show;
    if (show !== was) queueMicrotask(hooks.opened);
    draw();
    if (remember) {
      try { localStorage.setItem(page.panelKey, show ? "open" : "folded"); } catch { /* Unremembered. */ }
    }
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
    render(createPortal(
      <aside ref={panel} class="artifact-comments-panel"
        aria-label="Comments" hidden={hidden} onKeyDown={event => {
          if (event.key === "Escape" && open) {
            event.preventDefault(); setOpen(false, true); focus("opener");
          }
        }}>
        <div class="artifact-comments-rail" hidden={open} onClick={() => { setOpen(true, true); focus("fold"); }}>
          <button ref={opener} type="button" class="artifact-comments-opener" aria-label="Comments"
            aria-controls="artifact-comments-sheet" aria-describedby="artifact-comments-count" aria-expanded={open}>
            <span class="artifact-comments-icon" aria-hidden="true" />
          </button>
          <span class="artifact-comments-badge" hidden={!tally.open.length}>{tally.open.length}</span>
          <ol class="artifact-comments-dots" aria-hidden="true">
            {tally.open.map(thread => <li key={thread.id} class={`artifact-comments-dot artifact-comments-dot--${thread.standing}`} />)}
          </ol>
          <span class="artifact-comments-rail-label" aria-hidden="true">Comments</span>
        </div>
        <div class="artifact-comments-sheet" id="artifact-comments-sheet" hidden={!open}>
          <header class="artifact-comments-head">
            <h2 class="artifact-comments-title">Comments</h2>
            <div class="artifact-comments-tally">
              <p class="artifact-comments-count" id="artifact-comments-count">{tally.open.length} open · {tally.resolved} resolved</p>
              <button ref={resolved} type="button" class="artifact-comments-show-resolved" hidden={!tally.resolved}
                aria-pressed={resolvedShown} onClick={() => { setResolvedShown(!resolvedShown, true); hooks.resolvedChanged(); }}>
                {resolvedShown ? "Hide resolved" : `Show resolved (${tally.resolved})`}
              </button>
            </div>
            <button ref={fold} type="button" class="artifact-comments-fold" aria-label="Fold comments"
              onClick={() => { setOpen(false, true); focus("opener"); }}><span aria-hidden="true">»</span></button>
          </header>
          <div ref={start} class="artifact-comments-start">
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
          </div>
          <div ref={list} class="artifact-comments-groups" />
        </div>
      </aside>, document.body), root);
    // Other scripts own modifiers such as --resizing. Update only ours.
    panel.current!.classList.toggle("artifact-comments-panel--open", open);
    panel.current!.classList.toggle("artifact-comments-panel--resolved-shown", resolvedShown);
  }
  draw();
  document.addEventListener("click", event => {
    if (!picking || (event.target instanceof Node && start.current?.contains(event.target))) return;
    unpick(document.activeElement === document.body || !!start.current?.contains(document.activeElement));
  }, true);
  return {
    list: list.current!, isOpen: () => open, resolvedShown: () => resolvedShown,
    setOpen, setResolvedShown, unpick, focus,
    hidden(hide) { hidden = hide; draw(); },
    sections(next) { sections = next; active = -1; draw(); },
    refresh(next) { tally = next; draw(); },
    empty(none) { if (tally.none !== none) { tally = { ...tally, none }; draw(); } },
    unlit() { if (picking) light(-1); },
  };
}
