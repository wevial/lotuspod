// Bundled with Preact into src/lotuspod/features/index/ts/islands.js
// (web/build.ts), first in the index script: pods in tabs. A strip above the
// index header holds a "Lotuspod" button, which shows the listing, then a tab
// per open pod, each the pod's own page in an iframe as serve answers it, so
// switching tabs keeps its scroll position and any text not sent. Without
// this script the index is its listing alone.
//
// A plain click on a link to NAME.html beside the index, for a pod the
// listing has and with no version query, opens that pod in a tab with the
// link's fragment, in the listing or in a pod already open: just after the
// active tab, or by activating its tab. So does a link to the index as its
// address reads with a tab open (copied into a comment, say).
//
// The open tabs and the active one are kept in the address, #tabs=NAME,NAME
// &on=NAME, written with history.replaceState, and a load with it opens them
// again, a name the listing does not have dropped; &at=FRAGMENT after &on=
// (as a pod loaded on its own asks it, features/publish/ts/open-in-tabs.js)
// opens the active tab there and is never written again. The fragment ends
// &view=activity for Recent activity and is written again each time the
// index's own script shows a view ("lotuspod:view"), whose buttons would
// otherwise drop it. With no tab open it is the view's own again.
//
// The listing shown again is told to the index's own script
// ("lotuspod:listing"); its rows swapped in ("lotuspod:rows",
// features/live/ts/index-refresh.ts) are read again, each open tab taking its
// pod's title. A tab not active shows a dot from the seen route, read on
// load, when a tab is activated or closed, when the window is seen again and
// on a tick from serve's stream (features/live/ts/live-events.ts). A page with
// no revision (rendered, never published) has no script of its own to record
// its opening, so each time it loads in a tab it is posted at "".
//
// The pod finder (features/index/ts/pod-finder.ts) opens from the "+", the
// "Find a pod" button and Cmd+K on a Mac or Ctrl+K elsewhere, in the index or
// in a framed page ("lotuspod:find"), and hands back the pod chosen
// ("lotuspod:open"), opened as a link would be, its tab focused.

import { focusTab, focusing } from "./focus";
import { loadedAt, write } from "./fragment";
import { mountFrames } from "./frames";
import { askFinder, findKey, follow, openPod } from "./links";
import { moves } from "./moves";
import { TICKS, askSeen } from "./seen";
import { isOpen, pods, readPods, retitled, state } from "./state";
import { mountStrip, tabOf } from "./strip";
import { activate, add, close, showListing } from "./tabs";

function start(main: HTMLElement): void {
  readPods();
  const bar = document.createElement("div");
  bar.className = "pod-tabs-bar";
  const box = document.createElement("div");
  box.className = "pod-tabs-frames";
  const strip = mountStrip(bar, {
    home: () => {
      if (state.active.value !== null) showListing();
    },
    pick: (name) => {
      if (state.active.value !== name) activate(name);
    },
    close,
    find: () => askFinder(false),
  });
  mountFrames(box, main, { follow, findKey });
  document.body.prepend(bar);
  main.after(box);
  focusing(bar);
  moves(strip);

  window.addEventListener("keydown", findKey, true);
  // A pod listed since the index loaded comes with its title and link.
  document.addEventListener("lotuspod:open", (event) => {
    const { name, title, href } = (event as CustomEvent).detail || {};
    if (typeof name === "string" && typeof title === "string" && typeof href === "string") {
      pods.set(name, { title, href });
    }
    if (!pods.has(name)) return;
    openPod(name, "");
    focusTab(tabOf(name)!.title);
  });
  document.addEventListener("click", (event) => follow(event, null));
  // A pod open in a tab but no longer listed is kept as it was. The strip,
  // the active tab, the frames and the dots stay as they are.
  document.addEventListener("lotuspod:rows", () => {
    const was = new Map(pods);
    readPods();
    for (const tab of state.tabs.value) {
      const kept = was.get(tab.name);
      if (!pods.has(tab.name) && kept) pods.set(tab.name, kept);
    }
    retitled();
  });
  document.addEventListener("lotuspod:view", () => {
    if (state.tabs.value.length) write();
  });
  window.addEventListener("focus", askSeen);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") askSeen();
  });
  document.addEventListener("lotuspod:change", (event) => {
    if (TICKS.has((event as CustomEvent).detail.what)) askSeen();
  });

  // The tabs the address names, in its order, the listing's pods alone.
  const named = loadedAt();
  if (named) {
    for (const name of named.names) {
      if (pods.has(name) && !isOpen(name)) add(name, name === named.on && named.at ? `#${named.at}` : "");
    }
    if (named.on !== null && isOpen(named.on)) {
      activate(named.on);
      return;
    }
    write();
  }
  askSeen();
}

const main = document.querySelector<HTMLElement>("main.index");
if (main) start(main);
