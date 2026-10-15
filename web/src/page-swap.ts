// Lotuspod page script: once an open page learns it was published again
// (js/live-page.js), it fetches the new revision and swaps in only the parts
// whose digest render stamped (data-digest, data-intro-digest) changed: the
// header's authored text, the outline's links, the intro, and each changed,
// added or removed section. Every other node stays as it was, and with it the
// scroll position and the folds. A section swapped in folds as the one it
// replaces was; one added starts open unless the reader's kept folds name it.
// Once applied, "lotuspod:swapped" (SWAPPED) tells the other page scripts what
// changed, the parts brought in are tinted for a moment, and the banner's
// status region says "Page updated", with how many sections changed (the
// intro counting as one). The first section heading at or below the title
// bar stays where it was in the window, as do the next one kept when the swap
// takes it away and the new one when it replaces it.
//
// A changed or removed part any test registered with holdSwap holds (the
// swap's own: the focus is in it; js/comments.js's: an open passage
// composer's words are in it, or it is a section taken away whose form holds
// text not sent) stays as it is, under a bar saying so with an Update button,
// which applies the part's newest nodes as a swap would.
// The page still takes the new revision; a later swap replaces the kept nodes
// when the part changed again, and takes the bar away when it is back to the
// open page's digest.
//
// The page falls back to the banner or a reload (the swap answers null,
// nothing touched) when its theme, policy or render variant changed, when
// either copy predates the digests, when the two differ in having an outline
// or sections, when their shared sections moved, when the references changed,
// when the outline changed on a page with decision forms (whose review marks
// sit on its links), when a changed part, old or new, holds a feature not yet
// mounted on new markup (SWAP_UNMOUNTED), or when one copy takes comments and
// the other does not. A swap that throws partway has the page reload.

// What a swapped part may not hold yet, old or new: each later ticket mounts
// one and takes it off.
const SWAP_UNMOUNTED = "form.artifact-decision, pre.mermaid, button.artifact-ref, table";

// Each test a changed or removed part, as the open page has it, is put to
// before a swap: a part any test holds is kept as it is under a bar until the
// reader presses its Update (holdSwap).
const SWAP_HOLDS: ((nodes: readonly Element[], removed: boolean) => boolean)[] = [];

// Hold back from a swap each part whose nodes (a section's heading and
// wrapper, or the intro's) test says to, told whether the new revision took
// the part away.
function holdSwap(test: (nodes: readonly Element[], removed: boolean) => boolean): void {
  SWAP_HOLDS.push(test);
}

function pageSwap(): void {
  // What the page script adds to the body outside any part, left where it is.
  const ADDED = "div.artifact-answered, .artifact-comments-changed";
  // The bar over a part held back, which the intro leaves out.
  const HELD = "div.artifact-swap-held";
  const CHANGED_TEXT = "This section changed";
  const REMOVED_TEXT = "This section was removed";
  const TINTED = "artifact-swapped";
  const TINT = 2000;
  const HEAD_METAS = ["lotuspod:revision", "lotuspod:updated", "lotuspod:labels", "lotuspod:owner"];

  interface Part {
    id: string;
    digest: string;
    heading: HTMLElement;
    wrapper: HTMLElement;
  }

  // A part held back: its bar and the new page's nodes for it.
  interface HeldSection {
    bar: HTMLElement;
    text: HTMLElement;
    fresh: Part | null;
  }
  interface HeldIntro {
    bar: HTMLElement;
    text: HTMLElement;
    fresh: Node[];
    digest: string;
  }
  // Each section held back, by id, and the intro when it is.
  const held = new Map<string, HeldSection>();
  let heldIntro: HeldIntro | null = null;

  // The page's theme address, the ?v= of its stylesheet link.
  const themeOf = (doc: Document): string => {
    const link = doc.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="?v="]');
    return /[?&]v=([^&#]*)/.exec(link?.getAttribute("href") ?? "")?.[1] ?? "";
  };

  // The render variant main.artifact names (artifact--report, ...), leaving
  // out the class js/versions.js toggles while its view shows.
  const variantOf = (doc: Document): string =>
    Array.from(doc.querySelector("main.artifact")?.classList ?? [])
      .filter((name) => name.startsWith("artifact--") && name !== "artifact--versions")
      .sort().join(" ");

  const policyOf = (doc: Document): string =>
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";

  const digestOf = (node: Element | null, name = "data-digest"): string | null =>
    node ? node.getAttribute(name) : null;

  const bodyOf = (doc: Document) => doc.querySelector<HTMLElement>("section.artifact-body[data-intro-digest]");

  // The body's sections, in order, each its wrapper and the h2 before it.
  const partsOf = (body: HTMLElement): Part[] =>
    all(":scope > div.artifact-section-body", body).flatMap((wrapper) => {
      const heading = wrapper.previousElementSibling;
      return heading instanceof HTMLElement && heading.tagName === "H2"
        ? [{ id: wrapper.dataset.section ?? "", digest: wrapper.dataset.digest ?? "", heading, wrapper }]
        : [];
    });

  // The body's nodes before its first section heading (all of a body with
  // none), leaving out what the page script added.
  const introOf = (body: HTMLElement, parts: Part[]): Node[] => {
    const nodes: Node[] = [];
    const end = parts.length ? parts[0]!.heading : null;
    for (let node = body.firstChild; node && node !== end; node = node.nextSibling) {
      if (!(node instanceof Element && node.matches(`${ADDED}, ${HELD}`))) nodes.push(node);
    }
    return nodes;
  };

  const unmounted = (nodes: Node[]): boolean =>
    nodes.some((node) => node instanceof Element &&
      (node.matches(SWAP_UNMOUNTED) || node.querySelector(SWAP_UNMOUNTED) !== null));

  const brought = (node: Node): Node => document.importNode(node, true);

  // The open page's node, or null, given the new page's text in place of
  // its children; the nodes taken out and put in.
  function retext(old: Element | null, fresh: Element | null, place: (node: Node) => void) {
    const before: Node[] = [];
    const after: Node[] = [];
    if (old && fresh) {
      before.push(...old.childNodes);
      after.push(...Array.from(fresh.childNodes, brought));
      old.replaceChildren(...after);
    } else if (old) {
      old.remove();
      before.push(old);
    } else if (fresh) {
      const node = brought(fresh);
      place(node);
      after.push(node);
    }
    return { before, after };
  }

  // The header keeps every node a script added (the versions link, the
  // archive button, a comment chip): only its authored text is swapped.
  function swapHeader(header: HTMLElement, fresh: HTMLElement, doc: Document) {
    const before: Node[] = [];
    const after: Node[] = [];
    const take = (done: { before: Node[]; after: Node[] }) => {
      before.push(...done.before);
      after.push(...done.after);
    };
    const title = header.querySelector("h1.artifact-title");
    take(retext(header.querySelector(":scope > .artifact-kicker"), fresh.querySelector(":scope > .artifact-kicker"),
      (node) => header.insertBefore(node, title)));
    take(retext(title, fresh.querySelector("h1.artifact-title"), (node) => header.prepend(node)));
    // The date line's own nodes are its text, times and labels; the rest a
    // script added after them.
    const line = header.querySelector(":scope > .artifact-meta");
    const freshLine = fresh.querySelector(":scope > .artifact-meta");
    if (line && freshLine) {
      const own = Array.from(line.childNodes).filter((node) =>
        node.nodeType === Node.TEXT_NODE || (node instanceof Element && node.matches("time, span.artifact-label")));
      own.forEach((node) => node.remove());
      const made = Array.from(freshLine.childNodes, brought);
      line.prepend(...made);
      before.push(...own);
      after.push(...made);
    }
    const summary = header.querySelector(":scope > .artifact-summary");
    take(retext(header.querySelector(":scope > .artifact-owner"), fresh.querySelector(":scope > .artifact-owner"),
      (node) => header.insertBefore(node, summary)));
    take(retext(summary, fresh.querySelector(":scope > .artifact-summary"), (node) => header.append(node)));
    const words = fresh.querySelector("h1.artifact-title")?.textContent ?? "";
    const top = document.querySelector(".artifact-topbar-title");
    if (top) top.textContent = words;
    document.title = doc.title;
    header.setAttribute("data-digest", fresh.getAttribute("data-digest") ?? "");
    return { before, after };
  }

  function swapHead(doc: Document): void {
    for (const name of HEAD_METAS) {
      const selector = `meta[name="${name}"]`;
      const old = document.head.querySelector<HTMLMetaElement>(selector);
      const fresh = doc.head.querySelector<HTMLMetaElement>(selector);
      if (old && fresh) old.content = fresh.content;
      else if (old) old.remove();
      else if (fresh) document.head.append(brought(fresh));
    }
  }

  // Swap in the parts of doc whose digests differ from the open page's; the
  // revision it shows then, else null with nothing touched.
  async function swap(): Promise<string | null> {
    // What the open page alone rules out, before anything is fetched.
    if (!bodyOf(document)) return null;
    let text: string;
    try {
      const response = await fetch(location.pathname + location.search, { cache: "reload" });
      if (response.status !== 200) return null;
      text = await response.text();
    } catch {
      return null;
    }
    const doc = new DOMParser().parseFromString(text, "text/html");
    const revision = doc.querySelector<HTMLMetaElement>('meta[name="lotuspod:revision"]')?.content.trim() ?? "";
    if (!revision || revision === live.revision()) return null;
    if (themeOf(doc) !== themeOf(document) || policyOf(doc) !== policyOf(document) ||
      variantOf(doc) !== variantOf(document)) {
      return null;
    }
    const body = bodyOf(document);
    const freshBody = bodyOf(doc);
    if (!body || !freshBody) return null;
    const outline = document.querySelector<HTMLElement>("nav.artifact-outline");
    const freshOutline = doc.querySelector<HTMLElement>("nav.artifact-outline");
    const parts = partsOf(body);
    const freshParts = partsOf(freshBody);
    if (!outline !== !freshOutline || !parts.length !== !freshParts.length) return null;
    const ids = new Set(parts.map((part) => part.id));
    const freshIds = new Set(freshParts.map((part) => part.id));
    const shared = parts.filter((part) => freshIds.has(part.id)).map((part) => part.id);
    const freshShared = freshParts.filter((part) => ids.has(part.id)).map((part) => part.id);
    if (shared.join("\n") !== freshShared.join("\n")) return null;
    if (digestOf(document.querySelector(".artifact-ref-cards")) !== digestOf(doc.querySelector(".artifact-ref-cards"))) {
      return null;
    }
    // Comments turned on or off: the comments page is set up once, at load.
    if (!document.querySelector("details.artifact-comment") !== !doc.querySelector("details.artifact-comment")) {
      return null;
    }

    // What changed, each as the open page has it and as the new one does.
    const header = document.querySelector<HTMLElement>("header.artifact-header");
    const freshHeader = doc.querySelector<HTMLElement>("header.artifact-header");
    const headerChanged = digestOf(header) !== digestOf(freshHeader);
    const list = outline?.querySelector("ol.artifact-outline-list") ?? null;
    const freshList = freshOutline?.querySelector("ol.artifact-outline-list") ?? null;
    const outlineChanged = digestOf(outline) !== digestOf(freshOutline);
    const introChanged = digestOf(body, "data-intro-digest") !== digestOf(freshBody, "data-intro-digest");
    const intro = introOf(body, parts);
    const freshIntro = introOf(freshBody, freshParts);
    const byId = new Map(parts.map((part) => [part.id, part]));
    const removed = parts.filter((part) => !freshIds.has(part.id));
    const changed = freshParts.filter((part) => byId.has(part.id) && byId.get(part.id)!.digest !== part.digest);
    const added = freshParts.filter((part) => !ids.has(part.id));
    const touched: Node[] = [
      ...(headerChanged ? [header, freshHeader] : []),
      ...(outlineChanged ? [list, freshList] : []),
      ...(introChanged ? [...intro, ...freshIntro] : []),
      ...[...removed, ...added].flatMap((part) => [part.heading, part.wrapper]),
      ...changed.flatMap((part) => {
        const old = byId.get(part.id)!;
        return [old.heading, old.wrapper, part.heading, part.wrapper];
      }),
    ].filter((node): node is Node => node !== null);
    if (unmounted(touched)) return null;
    // The review sheet marks the outline's links of sections with questions,
    // and draws no marks on links swapped in yet.
    if (outlineChanged && (document.querySelector("form.artifact-decision") || doc.querySelector("form.artifact-decision"))) {
      return null;
    }

    // Each changed or removed part, as the open page has it, that a test
    // holds back: kept as it is, its new nodes kept for the reader's Update.
    const holds = (nodes: Node[], gone: boolean): boolean => {
      const elements = nodes.filter((node): node is Element => node instanceof Element);
      return SWAP_HOLDS.some((test) => test(elements, gone));
    };
    // A part held already stays held until its Update, or until its text
    // is the open page's again.
    const introHeld = introChanged && (heldIntro !== null || holds(intro, false));
    const sectionHeld = new Set([...removed, ...changed.map((part) => byId.get(part.id)!)]
      .filter((part) => held.has(part.id) || holds([part.heading, part.wrapper], !freshIds.has(part.id)))
      .map((part) => part.id));
    // The first section heading at or below the title bar, and its top.
    const line = document.querySelector(".artifact-topbar")?.getBoundingClientRect().bottom ?? 0;
    const anchorAt = parts.findIndex((part) => part.heading.getBoundingClientRect().top >= line);
    const anchorTop = anchorAt >= 0 ? parts[anchorAt]!.heading.getBoundingClientRect().top : 0;

    // Applied from here on: a throw has the page reload.
    const units: SwappedUnit[] = [];
    if (headerChanged && header && freshHeader) {
      units.push({ kind: "header", id: "", change: "changed", ...swapHeader(header, freshHeader, doc) });
    }
    if (outlineChanged && list && freshList) {
      const before = Array.from(list.childNodes);
      const after = Array.from(freshList.childNodes, brought);
      list.replaceChildren(...after);
      if (outline && freshOutline) outline.setAttribute("data-digest", freshOutline.getAttribute("data-digest") ?? "");
      units.push({ kind: "outline", id: "", change: "changed", before, after });
    }
    const introDigest = freshBody.getAttribute("data-intro-digest") ?? "";
    if (introHeld) {
      holdIntro(body, freshIntro, introDigest);
    } else if (introChanged) {
      units.push(applyIntro(body, intro, freshIntro, introDigest));
    } else {
      unholdIntro();
    }
    // The open page's heading of each section the swap replaced, and of each
    // it took away, for where the reader was.
    const replaced = new Map<HTMLElement, HTMLElement>();
    const gone = new Set<HTMLElement>();
    for (const part of removed) {
      if (sectionHeld.has(part.id)) {
        holdSection(part, null);
        continue;
      }
      gone.add(part.heading);
      units.push(applyRemoved(part));
    }
    // The open page's wrapper of each section, as the swap goes.
    const shown = new Map(parts.filter((part) => freshIds.has(part.id)).map((part) => [part.id, part.wrapper]));
    for (const part of changed) {
      const old = byId.get(part.id)!;
      if (sectionHeld.has(part.id)) {
        holdSection(old, part);
        continue;
      }
      const unit = applyChanged(old, part);
      const [heading, wrapper] = unit.after as [HTMLElement, HTMLElement];
      replaced.set(old.heading, heading);
      shown.set(part.id, wrapper);
      units.push(unit);
    }
    for (const part of added) {
      const heading = brought(part.heading) as HTMLElement;
      const wrapper = brought(part.wrapper) as HTMLElement;
      const at = freshParts.indexOf(part);
      const previous = at > 0 ? shown.get(freshParts[at - 1]!.id) : undefined;
      if (previous) {
        previous.after(heading, wrapper);
      } else {
        // First: after the intro, before the first section or what the page
        // script added.
        const first = all(":scope > div.artifact-section-body", body)[0];
        const next = first?.previousElementSibling ?? body.querySelector(`:scope > :is(${ADDED})`);
        body.insertBefore(heading, next);
        body.insertBefore(wrapper, next);
      }
      foldSection(heading, wrapper, part.id, undefined, true);
      shown.set(part.id, wrapper);
      units.push({ kind: "section", id: part.id, change: "added", before: [], after: [heading, wrapper] });
    }
    // A section held back whose new digest is the open one's again is
    // current once more.
    for (const id of Array.from(held.keys())) {
      if (!sectionHeld.has(id)) unholdSection(id);
    }

    // The reader's place: the anchor heading, else the one that replaced it,
    // else the next one kept, back where it was, measured once the browser's
    // own scroll anchoring has moved the page.
    if (anchorAt >= 0) {
      const kept = parts.slice(anchorAt).find((part) => !gone.has(part.heading));
      const node = kept ? replaced.get(kept.heading) ?? kept.heading : null;
      const moved = node ? node.getBoundingClientRect().top - anchorTop : 0;
      if (moved) window.scrollBy({ top: moved, behavior: "instant" });
    }
    swapHead(doc);
    swapped(revision, units);
    return revision;
  }

  // The intro's nodes taken out for the new ones.
  function applyIntro(body: HTMLElement, intro: Node[], freshIntro: Node[], digest: string): SwappedUnit {
    unholdIntro();
    intro.forEach((node) => node.parentNode?.removeChild(node));
    const after = freshIntro.map(brought);
    body.prepend(...after);
    body.setAttribute("data-intro-digest", digest);
    return { kind: "intro", id: "", change: "changed", before: intro, after };
  }

  function applyRemoved(part: Part): SwappedUnit {
    held.delete(part.id);
    foldSection.drop(part.wrapper);
    part.heading.remove();
    part.wrapper.remove();
    return { kind: "section", id: part.id, change: "removed", before: [part.heading, part.wrapper], after: [] };
  }

  // The open page's section old replaced by the new page's part; the unit's
  // after is its new heading and wrapper.
  function applyChanged(old: Part, part: Part): SwappedUnit {
    held.delete(part.id);
    const fold = old.wrapper.hasAttribute("hidden");
    foldSection.drop(old.wrapper);
    const heading = brought(part.heading) as HTMLElement;
    const wrapper = brought(part.wrapper) as HTMLElement;
    // The old ones go first, so the new ones keep their ids.
    old.heading.replaceWith(heading);
    old.wrapper.replaceWith(wrapper);
    foldSection(heading, wrapper, part.id, fold, true);
    return {
      kind: "section", id: part.id, change: "changed",
      before: [old.heading, old.wrapper], after: [heading, wrapper],
    };
  }

  // What follows once parts are applied, by a swap or an Update: their
  // links, a brief tint on what came in, the event naming them, and the
  // status line saying how many sections changed.
  function swapped(revision: string, units: SwappedUnit[]): void {
    const shown = units.filter((unit) => unit.kind === "intro" || unit.kind === "section")
      .flatMap((unit) => unit.after)
      .filter((node): node is Element => node instanceof Element);
    for (const node of shown) {
      if (node.matches("a[href]:not([target])")) linkTab(node);
      all("a[href]:not([target])", node).forEach(linkTab);
      node.classList.add(TINTED);
    }
    if (shown.length) {
      setTimeout(() => shown.forEach((node) => node.classList.remove(TINTED)), TINT);
    }
    document.dispatchEvent(new CustomEvent(SWAPPED, { detail: { revision, units } }));
    const count = units.filter((unit) => unit.kind === "intro" || unit.kind === "section").length;
    if (count) live.note(`Page updated \u00b7 ${count} ${count === 1 ? "section" : "sections"} changed`);
    else if (units.length) live.note("Page updated");
  }

  // The bar over a part held back: what changed, and Update.
  function heldBar(update: () => void) {
    const bar = element("div", "artifact-swap-held");
    const text = element("span", "artifact-swap-held-text");
    const dot = element("span", "artifact-swap-held-dot", "\u00b7");
    dot.setAttribute("aria-hidden", "true");
    const button = element("button", "artifact-swap-update", "Update");
    button.type = "button";
    button.addEventListener("click", update);
    bar.append(text, dot, button);
    return { bar, text };
  }

  // The fold button of a section's heading, or its link when it has none,
  // for the focus once a bar has taken its own away.
  const toggleOf = (heading: Element | undefined) =>
    heading?.querySelector<HTMLElement>("button.artifact-section-toggle, a[href]") ?? null;

  // Take a bar away, the focus it holds going to heading.
  function unbar(bar: HTMLElement, heading: Element | undefined): void {
    const focused = bar.contains(document.activeElement);
    bar.remove();
    if (focused) toggleOf(heading)?.focus();
  }

  // Keep part as it is, the new page's part kept for Update (null for one
  // the new revision took away).
  function holdSection(part: Part, fresh: Part | null): void {
    let entry = held.get(part.id);
    if (!entry) {
      entry = { ...heldBar(() => updateSection(part.id)), fresh };
      part.wrapper.prepend(entry.bar);
      held.set(part.id, entry);
    }
    // Folded, its bar does not show: its heading says it changed.
    foldSection.mark(part.wrapper, true);
    entry.fresh = fresh;
    entry.text.textContent = fresh ? CHANGED_TEXT : REMOVED_TEXT;
  }

  function unholdSection(id: string): void {
    const entry = held.get(id);
    const wrapper = entry?.bar.parentElement;
    if (wrapper) foldSection.mark(wrapper, false);
    if (entry) unbar(entry.bar, wrapper?.previousElementSibling ?? undefined);
    held.delete(id);
  }

  function updateSection(id: string): void {
    const entry = held.get(id);
    const body = bodyOf(document);
    if (!entry || !body) return;
    const parts = partsOf(body);
    const at = parts.findIndex((part) => part.id === id);
    if (at < 0) return;
    const old = parts[at]!;
    const unit = entry.fresh ? applyChanged(old, entry.fresh) : applyRemoved(old);
    swapped(live.revision(), [unit]);
    const heading = entry.fresh ? unit.after[0] as HTMLElement : (parts[at + 1] ?? parts[at - 1])?.heading;
    toggleOf(heading)?.focus();
  }

  function holdIntro(body: HTMLElement, fresh: Node[], digest: string): void {
    if (!heldIntro) {
      const made = heldBar(updateIntro);
      made.text.textContent = CHANGED_TEXT;
      body.prepend(made.bar);
      heldIntro = { ...made, fresh, digest };
    }
    heldIntro.fresh = fresh;
    heldIntro.digest = digest;
  }

  function unholdIntro(): void {
    if (heldIntro) {
      const body = bodyOf(document);
      unbar(heldIntro.bar, body ? partsOf(body)[0]?.heading : undefined);
    }
    heldIntro = null;
  }

  function updateIntro(): void {
    const entry = heldIntro;
    const body = bodyOf(document);
    if (!entry || !body) return;
    const parts = partsOf(body);
    swapped(live.revision(), [applyIntro(body, introOf(body, parts), entry.fresh, entry.digest)]);
    toggleOf(parts[0]?.heading)?.focus();
  }

  // The reader's focus is not swapped out from under them.
  holdSwap((nodes) => {
    const focused = document.activeElement;
    return focused !== null && focused !== document.body && nodes.some((node) => node.contains(focused));
  });
  live.swapWith(swap);
}

pageSwap();
