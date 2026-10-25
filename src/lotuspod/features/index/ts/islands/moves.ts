import { pods, state, told } from "./state";
import { tabOf } from "./strip";
import { move } from "./tabs";

// A tab moves along the strip: pressed (not on its ✕) and dragged more than
// SLOP pixels with a mouse or pen, or held HOLD ms then dragged on touch, so
// a quick swipe still scrolls the strip and a touch held then lifted is
// still a tap. While dragged it follows the pointer and the others shift to
// show where it lands; Escape, or the browser taking the pointer, puts it
// back. A press that never starts a drag is a click as any other. With its
// title focused, Alt+Shift+Left or Right moves it one place, though not while
// a drag is under way. The transforms and classes of a drag are set here on
// the tabs' nodes; where it ends is the state's.

const SLOP = 5;
const HOLD = 300;

interface Other {
  name: string;
  middle: number;
}

// The press on a tab that may become a drag: held once a touch has stayed
// long enough to drag, started once the tab follows the pointer, cancelled
// once Escape has put it back; others, the other tabs with their middles
// when it started.
interface Press {
  name: string;
  from: number;
  pointer: number;
  x: number;
  y: number;
  held: boolean;
  started: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  touch: boolean;
  width: number;
  min: number;
  max: number;
  others: Other[];
}

const names = (): string[] => state.tabs.value.map((tab) => tab.name);

function nodeOf(name: string): HTMLDivElement | null {
  return tabOf(name)?.tab ?? null;
}

// Where the dragged tab would land: before the first other tab whose middle
// is right of the pointer.
function landing({ others }: Press, x: number): number {
  const at = others.findIndex((other) => x < other.middle);
  return at < 0 ? others.length : at;
}

export function moves(strip: HTMLElement): void {
  let drag: Press | null = null;
  // A drag ended, so the click its release makes is not the tab's.
  let swallow = false;

  const settle = (): void => {
    for (const name of names()) {
      const tab = nodeOf(name);
      if (!tab) continue;
      tab.style.transform = "";
      tab.classList.remove("pod-tab--dragging", "pod-tab--shifting");
    }
    strip.classList.remove("pod-tabs--dragging");
  };

  const begin = (press: Press): void => {
    press.started = true;
    press.from = names().indexOf(press.name);
    const box = nodeOf(press.name)!.getBoundingClientRect();
    press.width = box.width;
    press.others = names().filter((name) => name !== press.name).map((name) => {
      const rect = nodeOf(name)!.getBoundingClientRect();
      return { name, middle: rect.left + rect.width / 2 };
    });
    const bounds = strip.getBoundingClientRect();
    press.min = Math.min(0, bounds.left - box.left);
    press.max = Math.max(0, bounds.right - box.right);
    try {
      strip.setPointerCapture(press.pointer);
    } catch {
      // Followed as far as the strip's own events reach.
    }
    strip.classList.add("pod-tabs--dragging");
    nodeOf(press.name)!.classList.add("pod-tab--dragging");
    for (const other of press.others) nodeOf(other.name)?.classList.add("pod-tab--shifting");
  };

  const drift = (press: Press, x: number): void => {
    const dx = Math.min(press.max, Math.max(press.min, x - press.x));
    const dragged = nodeOf(press.name);
    if (dragged) dragged.style.transform = `translateX(${dx}px)`;
    const to = landing(press, x);
    const order = names();
    press.others.forEach((other, k) => {
      const i = order.indexOf(other.name);
      let shift = 0;
      if (i < press.from && k >= to) shift = press.width;
      else if (i > press.from && k < to) shift = -press.width;
      const tab = nodeOf(other.name);
      if (tab) tab.style.transform = shift ? `translateX(${shift}px)` : "";
    });
  };

  const end = (drop: boolean, x: number): void => {
    const was = drag!;
    drag = null;
    clearTimeout(was.timer);
    if (!was.started) return;
    if (was.cancelled) drop = false;
    swallow = true;
    setTimeout(() => {
      swallow = false;
    }, 0);
    settle();
    // Where the dragged pod is now, should the strip have changed under it.
    const from = names().indexOf(was.name);
    if (drop && from >= 0) {
      const to = landing(was, x);
      if (to !== from) move(from, to);
    }
  };

  strip.addEventListener("pointerdown", (event) => {
    swallow = false;
    // A press whose release never reached the strip is over.
    if (drag && !drag.started) end(false, event.clientX);
    if (drag || !event.isPrimary || event.button !== 0) return;
    const target = event.target as Element;
    const tab = target.closest<HTMLElement>(".pod-tab");
    if (!tab || target.closest(".pod-tab-close")) return;
    const name = names().find((each) => nodeOf(each) === tab);
    if (name === undefined) return;
    const press: Press = {
      name, from: names().indexOf(name), pointer: event.pointerId, x: event.clientX, y: event.clientY,
      held: false, started: false, cancelled: false, timer: undefined, touch: event.pointerType === "touch",
      width: 0, min: 0, max: 0, others: [],
    };
    drag = press;
    if (press.touch) {
      press.timer = setTimeout(() => {
        press.held = true;
      }, HOLD);
    }
  });
  strip.addEventListener("pointermove", (event) => {
    if (!drag || drag.cancelled || event.pointerId !== drag.pointer) return;
    // Its release went elsewhere (a framed page): the press is over.
    if (event.buttons === 0) {
      end(false, event.clientX);
      return;
    }
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= SLOP) return;
      // A touch moved before its hold is the strip's to scroll.
      if (drag.touch && !drag.held) {
        end(false, event.clientX);
        return;
      }
      begin(drag);
    }
    drift(drag, event.clientX);
  });
  // Taken on the window, so a release off the strip ends the press too.
  window.addEventListener("pointerup", (event) => {
    if (drag && event.pointerId === drag.pointer) end(true, event.clientX);
  }, true);
  strip.addEventListener("pointercancel", (event) => {
    if (drag && event.pointerId === drag.pointer) end(false, event.clientX);
  });
  // The strip's own capture lost, not a touch's implicit one on the tab
  // pressed, which the strip takes over.
  strip.addEventListener("lostpointercapture", (event) => {
    if (event.target === strip && drag && drag.started && event.pointerId === drag.pointer) end(false, event.clientX);
  });
  // A touch held into a drag scrolls nothing.
  strip.addEventListener("touchmove", (event) => {
    if (drag && (drag.held || drag.started)) event.preventDefault();
  }, { passive: false });
  strip.addEventListener("click", (event) => {
    if (!swallow) return;
    swallow = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !drag || !drag.started) return;
    event.preventDefault();
    // Put back, the pointer still down: its release drops nothing and is no
    // click.
    settle();
    drag.cancelled = true;
  }, true);

  strip.addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    const title = (event.target as Element).closest(".pod-tab-title");
    const from = names().findIndex((name) => tabOf(name)?.title === title);
    if (from < 0) return;
    event.preventDefault();
    // The drag under way places the tabs until it ends.
    if (drag && drag.started) return;
    const to = from + (event.key === "ArrowLeft" ? -1 : 1);
    const count = names().length;
    if (to < 0 || to >= count) return;
    const tab = move(from, to);
    told(`${pods.get(tab.name)?.title ?? tab.title} moved to position ${to + 1} of ${count}`);
  });
}
