import type { Thread } from "../bridge";
import { anchorOf } from "./anchor";

// The pin on each live block's frame (span.artifact-live-pin, which
// web/src/widgets.ts adds once): the number of open threads on the block,
// hidden at none. Pressing it opens the block's first open thread. Only its
// text and hidden change here, so no render recreates the chrome.
export function pins(bridge: {
  shown: Map<number, Thread>;
  resolved(thread: Thread): boolean;
  reach(thread: Thread, opener: HTMLElement): void;
}) {
  const wired = new WeakSet<HTMLElement>();

  // The open threads on the block id, oldest first.
  function openOn(id: string): Thread[] {
    return [...bridge.shown.values()].filter(thread => {
      const anchor = anchorOf(thread.root);
      return anchor.kind === "block" && anchor.id === id && Boolean(thread.box) && !bridge.resolved(thread);
    }).sort((a, b) => a.root.id - b.root.id);
  }

  function wire(pin: HTMLElement, id: string) {
    if (wired.has(pin)) return;
    wired.add(pin);
    const open = () => {
      const first = openOn(id)[0];
      if (first) bridge.reach(first, pin);
    };
    pin.addEventListener("click", open);
    pin.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }

  return {
    refresh() {
      document.querySelectorAll<HTMLElement>("figure.artifact-live[data-widget]").forEach(figure => {
        const pin = figure.querySelector<HTMLElement>(":scope > .artifact-live-pin");
        if (!pin) return;
        const id = figure.dataset.widget!;
        const n = openOn(id).length;
        wire(pin, id);
        if (pin.textContent !== String(n)) pin.textContent = String(n);
        pin.hidden = n === 0;
        pin.setAttribute("aria-label", n === 1 ? "1 open comment" : n + " open comments");
      });
    },
  };
}
