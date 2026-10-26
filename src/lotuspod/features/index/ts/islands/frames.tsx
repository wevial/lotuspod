import { render } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { effect } from "@preact/signals";
import { markSeen, revisionOf } from "./seen";
import { state, type Frame } from "./state";

// What a framed document's window hands on: its clicks, after every handler
// of the page's own, and its keys, in the capture phase.
export interface Framing {
  follow(event: MouseEvent, framed: Document): void;
  findKey(event: KeyboardEvent): void;
}

const drawn = new Map<string, HTMLIFrameElement>();

export function frameOf(name: string): HTMLIFrameElement | null {
  return drawn.get(name) ?? null;
}

// Each document a frame loads is taken as soon as it exists, before it has
// loaded: a new frame's first, and the next one whenever its page goes (a
// reload, such as the reload banner's), asked for until it is there. The
// frame's window cannot key this: it is the same object across loads, each
// of which brings a new document and a new window behind it with no handler.
const watched = new WeakSet<Document>();
const WAIT = 50;
const TRIES = 200;

function watch(frame: HTMLIFrameElement, framing: Framing): () => void {
  const listen = (): boolean => {
    let framed: Document | null;
    try {
      framed = frame.contentDocument;
    } catch {
      framed = null;
    }
    if (!framed || framed.URL === "about:blank" || watched.has(framed)) return false;
    const view = framed.defaultView;
    if (!view) return false;
    watched.add(framed);
    const taken = framed;
    view.addEventListener("click", (event) => framing.follow(event, taken));
    view.addEventListener("keydown", framing.findKey, true);
    view.addEventListener("pagehide", soon);
    return true;
  };
  // Ask for the next document until it is there, the frame is gone, or its
  // load takes it anyway.
  function soon(): void {
    let tries = 0;
    const ask = (): void => {
      if (!frame.isConnected || listen() || ++tries > TRIES) return;
      setTimeout(ask, WAIT);
    };
    setTimeout(ask, 0);
  }
  frame.addEventListener("load", listen);
  return soon;
}

interface FrameProps {
  frame: Frame;
  title: string;
  on: boolean;
  framing: Framing;
}

function PodFrame({ frame: { name, src }, title, on, framing }: FrameProps) {
  const node = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const frame = node.current!;
    drawn.set(name, frame);
    const soon = watch(frame, framing);
    // A page with no stamp records nothing itself: its opening is posted here.
    frame.addEventListener("load", () => {
      if (revisionOf(frame) === "") markSeen(name, frame);
    });
    soon();
    return () => {
      if (drawn.get(name) === frame) drawn.delete(name);
    };
  }, [name]);
  return <iframe ref={node} class={on ? "pod-frame pod-frame--active" : "pod-frame"} title={title} src={src} />;
}

// Draws a frame per open pod into the box, in the order they were opened:
// an iframe moved in the document loads its page again, so a move of the
// tabs never reorders them. The active one fills the window under the
// strip, the others stay loaded but hidden, and the listing is hidden while
// one is active.
export function mountFrames(box: HTMLElement, listing: HTMLElement, framing: Framing): void {
  effect(() => {
    const active = state.active.value;
    const titles = new Map(state.tabs.value.map((tab) => [tab.name, tab.title]));
    render(<>{state.frames.value.map((frame) => (
      <PodFrame key={frame.name} frame={frame} title={titles.get(frame.name) ?? ""} on={frame.name === active} framing={framing} />
    ))}</>, box);
    listing.hidden = active !== null;
    box.classList.toggle("pod-tabs-frames--active", active !== null);
  });
}
