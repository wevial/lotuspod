// Built from web/src/pod-finder.ts by web/build.ts. Edit that file, not this one.
(() => {
  const main = document.querySelector("main.index");
  const bar = document.querySelector(".pod-tabs-bar");
  if (!main || !bar)
    return;
  const SEEN = "/api/seen";
  const MAC = /^Mac/.test(navigator.platform);
  const RESULTS = "pod-finder-results";
  const modified = (event) => MAC ? event.metaKey : event.ctrlKey;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className)
      node.className = className;
    if (text !== undefined)
      node.textContent = text;
    return node;
  };
  const listing = (doc) => {
    const found = [];
    for (const row of doc.querySelectorAll(".index-table tbody tr[data-page]")) {
      const link = row.cells[0] ? row.cells[0].querySelector("a[href]") : null;
      if (!link)
        continue;
      const title = link.textContent.trim();
      const labels = (row.dataset.labels || "").split(",").filter(Boolean);
      const summaryCell = row.querySelector("td.episode-summary");
      const summary = summaryCell ? summaryCell.textContent.trim() : "";
      const time = row.cells[1] ? row.cells[1].querySelector("time[datetime]") : null;
      found.push({
        name: row.dataset.page,
        title,
        href: link.getAttribute("href"),
        labels,
        summary,
        updated: time ? time.getAttribute("datetime") : "",
        text: [title, labels.join(" "), summary].join(" ").toLowerCase()
      });
    }
    return found;
  };
  let pods = listing(document);
  const backdrop = element("div", "pod-finder-backdrop");
  backdrop.hidden = true;
  const dialog = element("div", "pod-finder");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Find a pod");
  const input = element("input", "pod-finder-input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Find a pod by title, label or summary";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Find a pod");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", RESULTS);
  const list = element("div", "pod-finder-results");
  list.id = RESULTS;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Pods");
  const empty = element("p", "pod-finder-empty");
  empty.hidden = true;
  const hint = element("p", "pod-finder-hint");
  const key = MAC ? "⌘" : "Ctrl ";
  for (const [keys, words] of [
    ["↑ ↓", "move"],
    ["Enter", "open in a tab"],
    [`${key}Enter`, "open in a browser tab"],
    ["Esc", "close"]
  ]) {
    const part = element("span", "pod-finder-hint-part");
    part.append(element("kbd", null, keys), ` ${words}`);
    hint.append(part);
  }
  dialog.append(input, list, empty, hint);
  backdrop.append(dialog);
  document.body.append(backdrop);
  let seen = null;
  let answered = false;
  const pending = new Set;
  let shown = [];
  let selected = -1;
  let back = null;
  const seenAt = (pod) => {
    const entry = seen && Object.prototype.hasOwnProperty.call(seen, pod.name) ? seen[pod.name] : null;
    return entry && typeof entry.seenAt === "string" ? entry.seenAt : null;
  };
  const newest = (a, b) => {
    const left = seenAt(a);
    const right = seenAt(b);
    return left < right ? 1 : left > right ? -1 : 0;
  };
  const groups = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = pods.filter((pod) => words.every((word) => pod.text.includes(word)));
    if (seen === null)
      return [{ heading: null, pods: matching }];
    const recent = matching.filter(seenAt).sort(newest);
    const other = matching.filter((pod) => !seenAt(pod));
    return [{ heading: "Recent", pods: recent }, { heading: "Other pods", pods: other }].filter((group) => group.pods.length);
  };
  const inTabs = () => new Set(Array.from(bar.querySelectorAll(".pod-tab[data-page]"), (tab) => tab.dataset.page));
  const option = (pod, at, open) => {
    const node = element("div", "pod-finder-option");
    node.id = `pod-finder-option-${at}`;
    node.setAttribute("role", "option");
    node.setAttribute("aria-selected", "false");
    node.dataset.page = pod.name;
    const line = element("span", "pod-finder-line");
    line.append(element("span", "pod-finder-title", pod.title));
    if (open)
      line.append(element("span", "pod-finder-open", "in a tab"));
    if (pod.updated) {
      const updated = element("span", "pod-finder-updated", "updated ");
      const time = element("time", null, pod.updated.slice(0, 10));
      time.dateTime = pod.updated;
      updated.append(time);
      line.append(updated);
    }
    node.append(line);
    if (pod.summary)
      node.append(element("span", "pod-finder-summary", pod.summary));
    if (pod.labels.length) {
      const tags = element("span", "index-tags pod-finder-tags");
      for (const label of pod.labels)
        tags.append(element("span", "index-tag", label));
      node.append(tags);
    }
    node.addEventListener("pointermove", () => select(at));
    node.addEventListener("click", (event) => choose(at, modified(event)));
    return node;
  };
  const select = (at) => {
    if (at === selected || !shown[at])
      return;
    if (shown[selected])
      shown[selected].node.setAttribute("aria-selected", "false");
    selected = at;
    const { node } = shown[at];
    node.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", node.id);
    node.scrollIntoView({ block: "nearest" });
  };
  const render = (keep) => {
    const was = keep && shown[selected] ? shown[selected].pod.name : null;
    const open = inTabs();
    shown = [];
    selected = -1;
    input.removeAttribute("aria-activedescendant");
    list.replaceChildren();
    for (const group of groups()) {
      const holder = group.heading === null ? list : element("div", "pod-finder-group");
      if (group.heading !== null) {
        const heading = element("div", "pod-finder-heading", group.heading);
        heading.id = `pod-finder-heading-${list.childElementCount}`;
        heading.setAttribute("role", "presentation");
        holder.setAttribute("role", "group");
        holder.setAttribute("aria-labelledby", heading.id);
        holder.append(heading);
        list.append(holder);
      }
      for (const pod of group.pods) {
        const node = option(pod, shown.length, open.has(pod.name));
        shown.push({ pod, node });
        holder.append(node);
      }
    }
    const query = input.value.trim();
    list.hidden = !shown.length;
    empty.hidden = shown.length > 0;
    empty.textContent = query ? `No pod matches “${query}”.` : "No pod is listed.";
    const at = was === null ? -1 : shown.findIndex((each) => each.pod.name === was);
    select(at >= 0 ? at : answered ? 0 : -1);
  };
  const settled = (read) => {
    pending.delete(read);
    if (!pending.size)
      list.removeAttribute("aria-busy");
  };
  let asked = 0;
  const askSeen = async () => {
    const ask = ++asked;
    let pages = null;
    try {
      const response = await fetch(SEEN, { cache: "no-store" });
      if (response.status === 200) {
        const payload = await response.json();
        if (payload && typeof payload.pages === "object" && payload.pages)
          pages = payload.pages;
      }
    } catch (ignored) {}
    if (ask !== asked)
      return;
    seen = pages;
    answered = true;
    settled("seen");
    if (!backdrop.hidden)
      render(true);
  };
  let read = 0;
  const askIndex = async () => {
    const ask = ++read;
    let fresh = null;
    try {
      const response = await fetch(location.pathname, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 200) {
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        if (doc.querySelector(".index-table"))
          fresh = listing(doc);
      }
    } catch (ignored) {}
    if (ask !== read)
      return;
    settled("index");
    if (fresh === null)
      return;
    pods = fresh;
    if (!backdrop.hidden)
      render(true);
  };
  const show = () => {
    const at = document.activeElement;
    let inner = null;
    if (at && at.tagName === "IFRAME") {
      const frame = at;
      try {
        inner = frame.contentDocument ? frame.contentDocument.activeElement : null;
      } catch (ignored) {
        inner = null;
      }
    }
    back = { at, inner };
    input.value = "";
    backdrop.hidden = false;
    answered = false;
    pending.add("seen");
    pending.add("index");
    list.setAttribute("aria-busy", "true");
    render(false);
    input.focus();
    askSeen();
    askIndex();
  };
  const hide = (restore) => {
    if (backdrop.hidden)
      return;
    backdrop.hidden = true;
    list.replaceChildren();
    shown = [];
    selected = -1;
    input.removeAttribute("aria-activedescendant");
    const was = back;
    back = null;
    if (!restore || !was)
      return;
    if (was.at && was.at !== document.body && was.at.isConnected)
      was.at.focus({ preventScroll: true });
    else
      input.blur();
    if (was.inner && was.inner.isConnected)
      was.inner.focus({ preventScroll: true });
  };
  const choose = (at, browser) => {
    const choice = shown[at];
    if (!choice)
      return;
    if (browser) {
      window.open(new URL(choice.pod.href, location.href).href, "_blank", "noopener");
      hide(true);
      return;
    }
    hide(false);
    document.dispatchEvent(new CustomEvent("lotuspod:open", { detail: {
      name: choice.pod.name,
      title: choice.pod.title,
      href: choice.pod.href
    } }));
  };
  input.addEventListener("input", () => {
    render(false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length)
        return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = selected >= 0 ? selected : step > 0 ? -1 : 0;
      select((from + step + shown.length) % shown.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat)
        choose(selected, modified(event));
    } else if (event.key === "Tab") {
      event.preventDefault();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide(true);
    }
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target !== input)
      event.preventDefault();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop)
      hide(true);
  });
  document.addEventListener("lotuspod:find", (event) => {
    if (backdrop.hidden)
      show();
    else if (event.detail && event.detail.toggle)
      hide(true);
  });
  askSeen();
})();
