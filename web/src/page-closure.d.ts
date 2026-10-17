// The names the page script's sources share in the closure the join wraps
// them in (THEME_CLOSURES in src/lotuspod/cli.py), as a page source written
// in TypeScript (web/src/page-swap.ts) calls them: declared once here, each
// with the source that defines it. A source's own top-level names join these
// in the one closure, so none may repeat another source's.

// js/live-page.js: what the page keeps of its revision while it is open.
interface PageLive {
  // A revision the page learned it is now published at.
  seen(revision: unknown): void;
  // The revision the page shows now: its own as it loaded, then each one a
  // swap brought in; "" on a page with no revision.
  revision(): string;
  // The swap to try first once a newer revision is seen: the revision the
  // page then shows, or null to show the banner or reload as before.
  swapWith(swap: (revision: string) => Promise<string | null>): void;
  // Show one line in the banner's place for a few seconds: what a swap
  // changed.
  note(text: string): void;
  // Reload the page now, keeping where the reader was and what they wrote.
  reload(): void;
}
declare const live: PageLive;

// js/shared.js.
declare function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string | null, text?: string): HTMLElementTagNameMap[K];
// js/page-open.js: the elements selector matches under root (the document
// when none), in document order.
declare function all<E extends Element = HTMLElement>(selector: string, root?: ParentNode): E[];
// js/page-open.js: a response's JSON, null when it is none.
declare function json(response: Response): Promise<unknown>;
// js/link-tab.js: a link off the site opens in a new tab.
declare function linkTab(link: Element): void;
// js/decisions.js: what reads and saves the page's decision forms, null on a
// page that loaded with neither a form nor a comment box.
declare const answering: object | null;

// js/page-open.js: fold a section's wrapper under its heading's button, as
// fold says (else as the reader left it), marked "changed" while folded when
// changed says a newer revision changed or added it, and forget one taken
// away.
interface FoldSection {
  (heading: HTMLElement, wrapper: HTMLElement, id: string | number, fold?: boolean, changed?: boolean): void;
  // Mark a folded section "changed", or clear the mark.
  mark(wrapper: HTMLElement, changed: boolean): void;
  drop(wrapper: HTMLElement): void;
}
declare const foldSection: FoldSection;

// One part of the page a swap changed: the header, the outline, the intro, a
// section (by its id; "" for any other part) or the references block, with
// the nodes it took out, detached, and put in.
interface SwappedUnit {
  kind: "header" | "outline" | "intro" | "section" | "refs";
  id: string;
  change: "changed" | "added" | "removed";
  before: Node[];
  after: Node[];
}

// The revision the page now shows, and each part the swap changed.
interface SwappedDetail {
  revision: string;
  units: SwappedUnit[];
}

// js/page-open.js: sent on the document once a swap is applied.
declare const SWAPPED: "lotuspod:swapped";

// The diagrams (pre.mermaid) a swap brought in, for the template's start-up
// module to draw.
interface DiagramsDetail {
  nodes: HTMLElement[];
}

// js/page-open.js: sent on the document once a swap is applied, naming the
// diagrams it brought in, when it brought in any.
declare const DIAGRAMS: "lotuspod:diagrams";

interface DocumentEventMap {
  "lotuspod:swapped": CustomEvent<SwappedDetail>;
  "lotuspod:diagrams": CustomEvent<DiagramsDetail>;
}

// web/src/page-swap.ts: hold back from a swap each part whose nodes (a
// section's heading and wrapper, or the intro's) test says to, told whether
// the new revision took the part away.
declare function holdSwap(test: (nodes: readonly Element[], removed: boolean) => boolean): void;

// web/src/widgets.ts: accepted notifications dispatched on the widget frame.
declare var WIDGET: "lotuspod:widget";
interface WidgetDetail {
  kind: "ready" | "error" | "escape" | "state";
  // The error's message, or the state's label; "" for the others.
  message: string;
}
interface HTMLElementEventMap {
  "lotuspod:widget": CustomEvent<WidgetDetail>;
}

// A live block as a comment thread is anchored to it: its id, the 12 hex
// digits of its widget file's hash and the state its widget showed.
interface BlockAnchor {
  kind: "block";
  id: string;
  hash: string;
  state: string;
}
// web/src/islands/bridge.ts: open the form for a new thread on the block's
// section, on the block. Declared by web/src/widgets.ts and set by the
// comments island once it starts, on a page that takes new comments; else
// undefined.
declare var startComment: ((request: { anchor: BlockAnchor }) => void) | undefined;
