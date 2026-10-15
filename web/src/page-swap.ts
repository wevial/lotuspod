// Lotuspod page script: once an open page learns it was published again
// (js/live-page.js), it fetches the new revision and swaps in only the parts
// whose digest render stamped (data-digest, data-intro-digest) changed: the
// header's authored text, the outline's links, the intro, and each changed,
// added or removed section. Every other node stays as it was, and with it the
// scroll position and the folds. A section swapped in folds as the one it
// replaces was; one added starts open unless the reader's kept folds name it.
// Once applied, "lotuspod:swapped" (SWAPPED) tells the other page scripts what
// changed.
//
// The page falls back to the banner or a reload (the swap answers null,
// nothing touched) when its theme or policy changed, when either copy
// predates the digests, when the two differ in having an outline or sections,
// when their shared sections moved, when the references changed, when either
// holds a comment box, or when a changed part, old or new, holds a feature not
// yet mounted on new markup (SWAP_UNMOUNTED). A swap that throws partway has
// the page reload.

// What a swapped part may not hold yet, old or new: each later ticket mounts
// one and takes it off.
const SWAP_UNMOUNTED = "details.artifact-comment, form.artifact-decision, pre.mermaid, button.artifact-ref, table";

function pageSwap(): void {
  // What the page script adds to the body outside any part, left where it is.
  const ADDED = "div.artifact-answered, .artifact-comments-changed";
  const HEAD_METAS = ["lotuspod:revision", "lotuspod:updated", "lotuspod:labels", "lotuspod:owner"];

  interface Part {
    id: string;
    digest: string;
    heading: HTMLElement;
    wrapper: HTMLElement;
  }

  // The page's theme address, the ?v= of its stylesheet link.
  const themeOf = (doc: Document): string => {
    const link = doc.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="?v="]');
    return /[?&]v=([^&#]*)/.exec(link?.getAttribute("href") ?? "")?.[1] ?? "";
  };

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
      if (!(node instanceof Element && node.matches(ADDED))) nodes.push(node);
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
    if (!bodyOf(document) || document.querySelector("details.artifact-comment")) return null;
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
    if (themeOf(doc) !== themeOf(document) || policyOf(doc) !== policyOf(document)) return null;
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
    if (document.querySelector("details.artifact-comment") || doc.querySelector("details.artifact-comment")) {
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

    // Applied from here on: a throw has the page reload.
    const units: SwappedUnit[] = [];
    const inBody: Node[] = [];
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
    if (introChanged) {
      intro.forEach((node) => node.parentNode?.removeChild(node));
      const after = freshIntro.map(brought);
      body.prepend(...after);
      body.setAttribute("data-intro-digest", freshBody.getAttribute("data-intro-digest") ?? "");
      inBody.push(...after);
      units.push({ kind: "intro", id: "", change: "changed", before: intro, after });
    }
    for (const part of removed) {
      foldSection.drop(part.wrapper);
      part.heading.remove();
      part.wrapper.remove();
      units.push({ kind: "section", id: part.id, change: "removed", before: [part.heading, part.wrapper], after: [] });
    }
    // The open page's wrapper of each section, as the swap goes.
    const shown = new Map(parts.filter((part) => freshIds.has(part.id)).map((part) => [part.id, part.wrapper]));
    for (const part of changed) {
      const old = byId.get(part.id)!;
      const fold = old.wrapper.hasAttribute("hidden");
      foldSection.drop(old.wrapper);
      const heading = brought(part.heading) as HTMLElement;
      const wrapper = brought(part.wrapper) as HTMLElement;
      // The old ones go first, so the new ones keep their ids.
      old.heading.replaceWith(heading);
      old.wrapper.replaceWith(wrapper);
      foldSection(heading, wrapper, part.id, fold);
      shown.set(part.id, wrapper);
      inBody.push(heading, wrapper);
      units.push({
        kind: "section", id: part.id, change: "changed",
        before: [old.heading, old.wrapper], after: [heading, wrapper],
      });
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
      foldSection(heading, wrapper, part.id);
      shown.set(part.id, wrapper);
      inBody.push(heading, wrapper);
      units.push({ kind: "section", id: part.id, change: "added", before: [], after: [heading, wrapper] });
    }
    for (const node of inBody) {
      if (node instanceof Element) {
        if (node.matches("a[href]:not([target])")) linkTab(node);
        all("a[href]:not([target])", node).forEach(linkTab);
      }
    }
    swapHead(doc);
    document.dispatchEvent(new CustomEvent(SWAPPED, { detail: { revision, units } }));
    return revision;
  }

  live.swapWith(swap);
}

pageSwap();
