import { render } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { effect } from "@preact/signals";
import { dotOf, type Dot } from "./seen";
import { state, type Tab } from "./state";

const MAC = /^Mac/.test(navigator.platform);

// What the strip's buttons do.
export interface StripActions {
  home(): void;
  pick(name: string): void;
  close(name: string): void;
  find(): void;
}

// A tab's own nodes, by its pod's name, while it is drawn.
export interface TabNodes {
  tab: HTMLDivElement;
  title: HTMLButtonElement;
}

const drawn = new Map<string, TabNodes>();

export function tabOf(name: string): TabNodes | null {
  return drawn.get(name) ?? null;
}

function DotMark({ kind }: { kind: Dot }) {
  return (
    <span class={`pod-tab-dot pod-tab-dot--${kind}`} data-kind={kind}>
      <span class="pod-tab-dot-text">{kind === "version" ? "new version" : "new replies"}</span>
    </span>
  );
}

interface TabProps {
  tab: Tab;
  on: boolean;
  dot: Dot | null;
  actions: StripActions;
}

function PodTab({ tab: { name, title }, on, dot, actions }: TabProps) {
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const nodes = { tab: box.current!, title: button.current! };
    drawn.set(name, nodes);
    return () => {
      if (drawn.get(name) === nodes) drawn.delete(name);
    };
  }, [name]);
  return (
    <div ref={box} class={on ? "pod-tab pod-tab--active" : "pod-tab"} data-page={name}>
      <button ref={button} type="button" class="pod-tab-title" aria-current={on ? "page" : undefined}
        onClick={() => actions.pick(name)}>
        <span class="pod-tab-name">{title}</span>
        {dot && <DotMark kind={dot} />}
      </button>
      <button type="button" class="pod-tab-close" aria-label={`Close ${title}`}
        onClick={() => actions.close(name)}>✕</button>
    </div>
  );
}

interface BarProps {
  tabs: readonly Tab[];
  active: string | null;
  seen: Parameters<typeof dotOf>[0];
  said: string;
  actions: StripActions;
  strip: { current: HTMLDivElement | null };
}

// The "Lotuspod" button, the strip of tabs with its "+", "Find a pod" and
// the polite live region a key move speaks in.
function Bar({ tabs, active, seen, said, actions, strip }: BarProps) {
  return (
    <>
      <button type="button" class="pod-tabs-home" aria-current={active === null ? "page" : undefined}
        onClick={actions.home}>Lotuspod</button>
      <div ref={strip} class="pod-tabs" role="group" aria-label="Open pods">
        {tabs.map((tab) => (
          <PodTab key={tab.name} tab={tab} on={tab.name === active} dot={dotOf(seen, tab.name, active)} actions={actions} />
        ))}
        <button type="button" class="pod-tabs-new" aria-label="Open a pod in a new tab" onClick={actions.find}>+</button>
      </div>
      <button type="button" class="pod-tabs-find" aria-keyshortcuts={MAC ? "Meta+K" : "Control+K"} onClick={actions.find}>
        <span class="pod-tabs-find-text">Find a pod</span>
        <kbd class="pod-tabs-find-key">{MAC ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <div class="pod-tabs-said" aria-live="polite">{said}</div>
    </>
  );
}

// Draws the bar into its node each time the state changes, at once, so the
// tabs are in place when the change's writer goes on; the strip is given
// back.
export function mountStrip(bar: HTMLElement, actions: StripActions): HTMLDivElement {
  const strip: { current: HTMLDivElement | null } = { current: null };
  effect(() => {
    render(<Bar tabs={state.tabs.value} active={state.active.value} seen={state.seen.value}
      said={state.said.value} actions={actions} strip={strip} />, bar);
  });
  return strip.current!;
}
