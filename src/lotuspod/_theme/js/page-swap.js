// Built from web/src/page-swap.ts by web/build.ts. Edit that file, not this one.
const SWAP_UNMOUNTED = "details.artifact-comment, form.artifact-decision, pre.mermaid";
function pageSwap() {
  const ADDED = "div.artifact-answered, .artifact-comments-changed";
  const HEAD_METAS = ["lotuspod:revision", "lotuspod:updated", "lotuspod:labels", "lotuspod:owner"];
  const themeOf = (doc) => {
    const link = doc.querySelector('link[rel="stylesheet"][href*="?v="]');
    return /[?&]v=([^&#]*)/.exec(link?.getAttribute("href") ?? "")?.[1] ?? "";
  };
  const variantOf = (doc) => Array.from(doc.querySelector("main.artifact")?.classList ?? []).filter((name) => name.startsWith("artifact--") && name !== "artifact--versions").sort().join(" ");
  const policyOf = (doc) => doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  const digestOf = (node, name = "data-digest") => node ? node.getAttribute(name) : null;
  const bodyOf = (doc) => doc.querySelector("section.artifact-body[data-intro-digest]");
  const partsOf = (body) => all(":scope > div.artifact-section-body", body).flatMap((wrapper) => {
    const heading = wrapper.previousElementSibling;
    return heading instanceof HTMLElement && heading.tagName === "H2" ? [{ id: wrapper.dataset.section ?? "", digest: wrapper.dataset.digest ?? "", heading, wrapper }] : [];
  });
  const introOf = (body, parts) => {
    const nodes = [];
    const end = parts.length ? parts[0].heading : null;
    for (let node = body.firstChild;node && node !== end; node = node.nextSibling) {
      if (!(node instanceof Element && node.matches(ADDED)))
        nodes.push(node);
    }
    return nodes;
  };
  const unmounted = (nodes) => nodes.some((node) => node instanceof Element && (node.matches(SWAP_UNMOUNTED) || node.querySelector(SWAP_UNMOUNTED) !== null));
  const brought = (node) => document.importNode(node, true);
  function retext(old, fresh, place) {
    const before = [];
    const after = [];
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
  function swapHeader(header, fresh, doc) {
    const before = [];
    const after = [];
    const take = (done) => {
      before.push(...done.before);
      after.push(...done.after);
    };
    const title = header.querySelector("h1.artifact-title");
    take(retext(header.querySelector(":scope > .artifact-kicker"), fresh.querySelector(":scope > .artifact-kicker"), (node) => header.insertBefore(node, title)));
    take(retext(title, fresh.querySelector("h1.artifact-title"), (node) => header.prepend(node)));
    const line = header.querySelector(":scope > .artifact-meta");
    const freshLine = fresh.querySelector(":scope > .artifact-meta");
    if (line && freshLine) {
      const own = Array.from(line.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE || node instanceof Element && node.matches("time, span.artifact-label"));
      own.forEach((node) => node.remove());
      const made = Array.from(freshLine.childNodes, brought);
      line.prepend(...made);
      before.push(...own);
      after.push(...made);
    }
    const summary = header.querySelector(":scope > .artifact-summary");
    take(retext(header.querySelector(":scope > .artifact-owner"), fresh.querySelector(":scope > .artifact-owner"), (node) => header.insertBefore(node, summary)));
    take(retext(summary, fresh.querySelector(":scope > .artifact-summary"), (node) => header.append(node)));
    const words = fresh.querySelector("h1.artifact-title")?.textContent ?? "";
    const top = document.querySelector(".artifact-topbar-title");
    if (top)
      top.textContent = words;
    document.title = doc.title;
    header.setAttribute("data-digest", fresh.getAttribute("data-digest") ?? "");
    return { before, after };
  }
  function swapHead(doc) {
    for (const name of HEAD_METAS) {
      const selector = `meta[name="${name}"]`;
      const old = document.head.querySelector(selector);
      const fresh = doc.head.querySelector(selector);
      if (old && fresh)
        old.content = fresh.content;
      else if (old)
        old.remove();
      else if (fresh)
        document.head.append(brought(fresh));
    }
  }
  async function swap() {
    if (!bodyOf(document) || document.querySelector("details.artifact-comment"))
      return null;
    let text;
    try {
      const response = await fetch(location.pathname + location.search, { cache: "reload" });
      if (response.status !== 200)
        return null;
      text = await response.text();
    } catch {
      return null;
    }
    const doc = new DOMParser().parseFromString(text, "text/html");
    const revision = doc.querySelector('meta[name="lotuspod:revision"]')?.content.trim() ?? "";
    if (!revision || revision === live.revision())
      return null;
    if (themeOf(doc) !== themeOf(document) || policyOf(doc) !== policyOf(document) || variantOf(doc) !== variantOf(document)) {
      return null;
    }
    const body = bodyOf(document);
    const freshBody = bodyOf(doc);
    if (!body || !freshBody)
      return null;
    const outline = document.querySelector("nav.artifact-outline");
    const freshOutline = doc.querySelector("nav.artifact-outline");
    const parts = partsOf(body);
    const freshParts = partsOf(freshBody);
    if (!outline !== !freshOutline || !parts.length !== !freshParts.length)
      return null;
    const ids = new Set(parts.map((part) => part.id));
    const freshIds = new Set(freshParts.map((part) => part.id));
    const shared = parts.filter((part) => freshIds.has(part.id)).map((part) => part.id);
    const freshShared = freshParts.filter((part) => ids.has(part.id)).map((part) => part.id);
    if (shared.join(`
`) !== freshShared.join(`
`))
      return null;
    if (document.querySelector("details.artifact-comment") || doc.querySelector("details.artifact-comment")) {
      return null;
    }
    const header = document.querySelector("header.artifact-header");
    const freshHeader = doc.querySelector("header.artifact-header");
    const headerChanged = digestOf(header) !== digestOf(freshHeader);
    const list = outline?.querySelector("ol.artifact-outline-list") ?? null;
    const freshList = freshOutline?.querySelector("ol.artifact-outline-list") ?? null;
    const outlineChanged = digestOf(outline) !== digestOf(freshOutline);
    const refs = document.querySelector("div.artifact-ref-cards");
    const freshRefs = doc.querySelector("div.artifact-ref-cards");
    const refsChanged = digestOf(refs) !== digestOf(freshRefs);
    const introChanged = digestOf(body, "data-intro-digest") !== digestOf(freshBody, "data-intro-digest");
    const intro = introOf(body, parts);
    const freshIntro = introOf(freshBody, freshParts);
    const byId = new Map(parts.map((part) => [part.id, part]));
    const removed = parts.filter((part) => !freshIds.has(part.id));
    const changed = freshParts.filter((part) => byId.has(part.id) && byId.get(part.id).digest !== part.digest);
    const added = freshParts.filter((part) => !ids.has(part.id));
    const touched = [
      ...headerChanged ? [header, freshHeader] : [],
      ...outlineChanged ? [list, freshList] : [],
      ...introChanged ? [...intro, ...freshIntro] : [],
      ...[...removed, ...added].flatMap((part) => [part.heading, part.wrapper]),
      ...changed.flatMap((part) => {
        const old = byId.get(part.id);
        return [old.heading, old.wrapper, part.heading, part.wrapper];
      })
    ].filter((node) => node !== null);
    if (unmounted(touched))
      return null;
    if (outlineChanged && (document.querySelector("form.artifact-decision") || doc.querySelector("form.artifact-decision"))) {
      return null;
    }
    const units = [];
    const inBody = [];
    if (headerChanged && header && freshHeader) {
      units.push({ kind: "header", id: "", change: "changed", ...swapHeader(header, freshHeader, doc) });
    }
    if (outlineChanged && list && freshList) {
      const before = Array.from(list.childNodes);
      const after = Array.from(freshList.childNodes, brought);
      list.replaceChildren(...after);
      if (outline && freshOutline)
        outline.setAttribute("data-digest", freshOutline.getAttribute("data-digest") ?? "");
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
    const shown = new Map(parts.filter((part) => freshIds.has(part.id)).map((part) => [part.id, part.wrapper]));
    for (const part of changed) {
      const old = byId.get(part.id);
      const fold = old.wrapper.hasAttribute("hidden");
      foldSection.drop(old.wrapper);
      const heading = brought(part.heading);
      const wrapper = brought(part.wrapper);
      old.heading.replaceWith(heading);
      old.wrapper.replaceWith(wrapper);
      foldSection(heading, wrapper, part.id, fold);
      shown.set(part.id, wrapper);
      inBody.push(heading, wrapper);
      units.push({
        kind: "section",
        id: part.id,
        change: "changed",
        before: [old.heading, old.wrapper],
        after: [heading, wrapper]
      });
    }
    for (const part of added) {
      const heading = brought(part.heading);
      const wrapper = brought(part.wrapper);
      const at = freshParts.indexOf(part);
      const previous = at > 0 ? shown.get(freshParts[at - 1].id) : undefined;
      if (previous) {
        previous.after(heading, wrapper);
      } else {
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
    if (refsChanged) {
      const before = refs ? [refs] : [];
      const after = freshRefs ? [brought(freshRefs)] : [];
      refs?.remove();
      if (after.length)
        body.after(...after);
      const change = !refs ? "added" : !freshRefs ? "removed" : "changed";
      units.push({ kind: "refs", id: "", change, before, after });
    }
    for (const node of inBody) {
      if (node instanceof Element) {
        if (node.matches("a[href]:not([target])"))
          linkTab(node);
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
