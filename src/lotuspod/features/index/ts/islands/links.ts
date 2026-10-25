import { FRAGMENT } from "./fragment";
import { frameOf } from "./frames";
import { isOpen, pods } from "./state";
import { activate, add, showListing } from "./tabs";

const MAC = /^Mac/.test(navigator.platform);

// The directory the index is served from, where every pod sits beside it.
const root = new URL(".", location.href).pathname;

// The pod a link names, else null: NAME.html beside the index on this
// origin, a NAME the listing has, asked with no version.
function podOf(url: URL): string | null {
  if (url.origin !== location.origin || url.searchParams.has("version")) return null;
  if (!url.pathname.startsWith(root)) return null;
  let file: string;
  try {
    file = decodeURIComponent(url.pathname.slice(root.length));
  } catch {
    return null;
  }
  const match = /^([^/]+)\.html$/.exec(file);
  return match && pods.has(match[1]!) ? match[1]! : null;
}

function isIndex(url: URL): boolean {
  return url.origin === location.origin && (url.pathname === root || url.pathname === `${root}index.html`);
}

// The active pod an index address names, #tabs=...&on=NAME as the address
// reads while a tab is open, a NAME the listing has, with its &at=FRAGMENT;
// else null.
function podShown(url: URL): { name: string; hash: string } | null {
  const named = isIndex(url) ? FRAGMENT.exec(url.hash) : null;
  if (!named || named[2] === undefined) return null;
  try {
    const name = decodeURIComponent(named[2]);
    if (!pods.has(name)) return null;
    return { name, hash: named[3] ? `#${decodeURIComponent(named[3])}` : "" };
  } catch {
    return null;
  }
}

// The pod opened in a tab at the link's fragment, or its tab activated with
// its page moved to that fragment, which reaches the page as a hashchange,
// the fragment it already holds included. exact (a link marked
// data-pod-exact, a Recent activity row's): an open pod's page moves to the
// link's fragment even when that is none, leaving any view a fragment
// shows, such as its versions.
export function openPod(name: string, hash: string, exact = false): void {
  const frame = isOpen(name) ? frameOf(name) : null;
  if (!isOpen(name)) {
    add(name, hash);
  } else if (!hash && exact) {
    try {
      const view = frame!.contentWindow as Window & typeof globalThis;
      const framed = view.location;
      if (framed.hash && framed.pathname === new URL(pods.get(name)!.href, location.href).pathname) {
        // Dropped in place, so the page keeps its state; it is told as a
        // fragment it left.
        const was = framed.href;
        view.history.replaceState(view.history.state, "", `${framed.pathname}${framed.search}`);
        view.dispatchEvent(new view.HashChangeEvent("hashchange", { oldURL: was, newURL: framed.href }));
      }
    } catch {
      // The frame stays where it is.
    }
  } else if (hash) {
    // To the fragment within the pod's page once it is there; until then
    // (the frame still blank, its page on the way) the pod's page anew, at
    // the fragment.
    const target = new URL(pods.get(name)!.href, location.href);
    try {
      const view = frame!.contentWindow as Window & typeof globalThis;
      const framed = view.location;
      if (framed.origin === target.origin && framed.pathname === target.pathname) {
        const held = framed.hash === hash;
        framed.replace(`${framed.pathname}${framed.search}${hash}`);
        if (held) {
          // The fragment it already holds is scrolled to again but fires no
          // hashchange: the page is told as if it had, so a link to a thread
          // opens it again.
          view.dispatchEvent(new view.HashChangeEvent("hashchange", { oldURL: framed.href, newURL: framed.href }));
        }
      } else {
        target.hash = hash;
        framed.replace(target.href);
      }
    } catch {
      // The frame stays where it is.
    }
  }
  activate(name);
}

// A plain click (main button, no modifier key) on a link with no target and
// no download, in the index (framed null) or in a framed page. Any other
// click is the browser's, so Cmd-click and Ctrl-click still open a browser
// tab. In a framed page, a link to the index shows the listing, and one
// elsewhere loads in the whole window.
export function follow(event: MouseEvent, framed: Document | null): void {
  if (event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target as Element | null;
  const link = target && target.closest ? target.closest("a[href]") : null;
  if (!link || link.hasAttribute("target") || link.hasAttribute("download")) return;
  let url: URL;
  try {
    url = new URL(link.getAttribute("href")!, link.baseURI);
  } catch {
    return;
  }
  if (framed) {
    // A link within the framed page itself only scrolls it.
    const here = new URL(framed.location.href);
    if (url.hash && url.origin === here.origin && url.pathname === here.pathname &&
        url.search === here.search) return;
  }
  const name = podOf(url);
  const shown = name === null ? podShown(url) : null;
  if (name !== null) {
    event.preventDefault();
    openPod(name, url.hash, link.hasAttribute("data-pod-exact"));
  } else if (shown) {
    event.preventDefault();
    openPod(shown.name, shown.hash);
  } else if (framed && isIndex(url)) {
    event.preventDefault();
    showListing();
  } else if (framed && /^https?:$/.test(url.protocol)) {
    event.preventDefault();
    location.assign(url.href);
  }
}

// Ask the finder (features/index/ts/pod-finder.ts) to open, or with the key
// to close again.
export function askFinder(toggle: boolean): void {
  document.dispatchEvent(new CustomEvent("lotuspod:find", { detail: { toggle } }));
}

// Cmd+K on a Mac, Ctrl+K elsewhere, taken in the capture phase so the
// browser keeps none of it (Chromium's own search box).
export function findKey(event: KeyboardEvent): void {
  if (typeof event.key !== "string" || event.key.toLowerCase() !== "k" ||
      event.shiftKey || event.altKey ||
      (MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  if (!event.repeat) askFinder(true);
}
