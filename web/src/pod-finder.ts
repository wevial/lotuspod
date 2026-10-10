// Lotuspod index script: the pod finder. Asked by the tabs ("lotuspod:find",
// from their "+" and "Find a pod" buttons and from Cmd+K on a Mac or Ctrl+K
// elsewhere), a dialog over a dimmed backdrop lists every pod the listing has:
// its title, "in a tab" while it is open in one, its summary on one line, its
// labels as the listing's tags and the day it was updated, all read from the
// listing's rows. Each opening draws the pods it has at once and reads the
// index again, so a pod published since it loaded is listed too once that
// read answers 200, the options drawn again with the same pod selected.
// Typing filters them: each word of the query, ignoring case, must appear
// in the pod's title, labels and summary joined.
//
// The pods this reader has opened, by their seenAt in the seen route, come
// first under "Recent", newest first, and the rest follow under "Other pods"
// in the listing's order, newest update first. Any answer but 200 (signed
// out, or the demo) leaves the listing's order alone, with no heading.
// The route is asked at load and again at each opening, whose options are
// grouped by its last answer and again by the new one. No option is selected
// until the new one has answered, so the selection never moves under the
// reader: from then on, or once the reader has moved it, it stays on its pod
// while that is listed. The list is aria-busy until both reads have answered.
//
// ↑ and ↓ move the selection, wrapping at either end, and Tab stays in the
// input. Enter or a click opens the pod in a tab ("lotuspod:open"), whose
// button then has focus; Cmd+Enter or a Cmd-click on a Mac (Ctrl elsewhere)
// opens its page in a new browser tab instead. Esc, the key again or a click
// on the backdrop closes the finder, and focus goes back where it was, into a
// framed pod's page too.
(() => {
  // A pod the listing has, as an option shows it; text is what a query is
  // matched against.
  interface Pod {
    name: string;
    title: string;
    href: string;
    labels: string[];
    summary: string;
    updated: string;
    text: string;
  }

  // The seen route's pages, of which the finder reads each one's seenAt.
  type Seen = Record<string, { seenAt: string | null }>;

  interface Group {
    heading: string | null;
    pods: Pod[];
  }

  interface Shown {
    pod: Pod;
    node: HTMLDivElement;
  }

  type Read = "seen" | "index";

  const main = document.querySelector("main.index");
  const bar = document.querySelector(".pod-tabs-bar");
  if (!main || !bar) return;

  const SEEN = "/api/seen";
  const MAC = /^Mac/.test(navigator.platform);
  const RESULTS = "pod-finder-results";

  // The modifier that sends a pod to a browser tab.
  const modified = (event: KeyboardEvent | MouseEvent) => (MAC ? event.metaKey : event.ctrlKey);

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string | null, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Each pod a document's listing has, in its order: what an option shows,
  // and the text a query is matched against.
  const listing = (doc: Document) => {
    const found: Pod[] = [];
    for (const row of doc.querySelectorAll<HTMLTableRowElement>(".index-table tbody tr[data-page]")) {
      const link = row.cells[0] ? row.cells[0].querySelector("a[href]") : null;
      if (!link) continue;
      const title = link.textContent.trim();
      const labels = (row.dataset.labels || "").split(",").filter(Boolean);
      const summaryCell = row.querySelector("td.episode-summary");
      const summary = summaryCell ? summaryCell.textContent.trim() : "";
      const time = row.cells[1] ? row.cells[1].querySelector("time[datetime]") : null;
      found.push({
        name: row.dataset.page!,
        title,
        href: link.getAttribute("href")!,
        labels,
        summary,
        updated: time ? time.getAttribute("datetime")! : "",
        text: [title, labels.join(" "), summary].join(" ").toLowerCase(),
      });
    }
    return found;
  };

  // The pods listed: this page's at load, then the served index's as last
  // read when the finder opened.
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
  for (const [keys, words] of [["↑ ↓", "move"], ["Enter", "open in a tab"],
    [`${key}Enter`, "open in a browser tab"], ["Esc", "close"]]) {
    const part = element("span", "pod-finder-hint-part");
    part.append(element("kbd", null, keys), ` ${words}`);
    hint.append(part);
  }
  dialog.append(input, list, empty, hint);
  backdrop.append(dialog);
  document.body.append(backdrop);

  // The seen route's pages as last answered 200, else null, and whether it
  // has answered since the finder opened.
  let seen: Seen | null = null;
  let answered = false;
  // The reads this opening still waits on.
  const pending = new Set<Read>();
  // The options shown, each {pod, node}, and the selected one's place.
  let shown: Shown[] = [];
  let selected = -1;
  // Where focus was when the finder opened: the element, and within a
  // framed pod's page, its own.
  let back: { at: HTMLElement | null; inner: HTMLElement | null } | null = null;

  const seenAt = (pod: Pod) => {
    const entry = seen && Object.prototype.hasOwnProperty.call(seen, pod.name) ? seen[pod.name] : null;
    return entry && typeof entry.seenAt === "string" ? entry.seenAt : null;
  };

  // The pods seen, newest first: only pods seen are sorted, so each has its
  // seenAt.
  const newest = (a: Pod, b: Pod) => {
    const left = seenAt(a)!;
    const right = seenAt(b)!;
    return left < right ? 1 : left > right ? -1 : 0;
  };

  // The pods matching the query, as groups {heading, pods}: while the seen
  // route has answered 200, Recent then Other pods, a heading only over a
  // group with a pod in it; else the listing's order under no heading.
  const groups = (): Group[] => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = pods.filter((pod) => words.every((word) => pod.text.includes(word)));
    if (seen === null) return [{ heading: null, pods: matching }];
    const recent = matching.filter(seenAt).sort(newest);
    const other = matching.filter((pod) => !seenAt(pod));
    return [{ heading: "Recent", pods: recent }, { heading: "Other pods", pods: other }]
      .filter((group) => group.pods.length);
  };

  // The pods open in a tab, by name, from the strip.
  const inTabs = () => new Set(Array.from(bar.querySelectorAll<HTMLElement>(".pod-tab[data-page]"),
    (tab) => tab.dataset.page));

  const option = (pod: Pod, at: number, open: boolean) => {
    const node = element("div", "pod-finder-option");
    node.id = `pod-finder-option-${at}`;
    node.setAttribute("role", "option");
    node.setAttribute("aria-selected", "false");
    node.dataset.page = pod.name;
    const line = element("span", "pod-finder-line");
    line.append(element("span", "pod-finder-title", pod.title));
    if (open) line.append(element("span", "pod-finder-open", "in a tab"));
    if (pod.updated) {
      const updated = element("span", "pod-finder-updated", "updated ");
      const time = element("time", null, pod.updated.slice(0, 10));
      time.dateTime = pod.updated;
      updated.append(time);
      line.append(updated);
    }
    node.append(line);
    if (pod.summary) node.append(element("span", "pod-finder-summary", pod.summary));
    if (pod.labels.length) {
      const tags = element("span", "index-tags pod-finder-tags");
      for (const label of pod.labels) tags.append(element("span", "index-tag", label));
      node.append(tags);
    }
    node.addEventListener("pointermove", () => select(at));
    node.addEventListener("click", (event) => choose(at, modified(event)));
    return node;
  };

  const select = (at: number) => {
    if (at === selected || !shown[at]) return;
    if (shown[selected]) shown[selected].node.setAttribute("aria-selected", "false");
    selected = at;
    const { node } = shown[at];
    node.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", node.id);
    node.scrollIntoView({ block: "nearest" });
  };

  // Draw the options again; the pod selected stays so when keep is set and
  // it is still listed, else the first is once the seen route has answered.
  const render = (keep: boolean) => {
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

  const settled = (read: Read) => {
    pending.delete(read);
    if (!pending.size) list.removeAttribute("aria-busy");
  };

  // Answers are drawn in the order they were asked: a later read wins.
  let asked = 0;
  const askSeen = async () => {
    const ask = ++asked;
    let pages: Seen | null = null;
    try {
      const response = await fetch(SEEN, { cache: "no-store" });
      if (response.status === 200) {
        const payload: { pages?: Seen } | null = await response.json();
        if (payload && typeof payload.pages === "object" && payload.pages) pages = payload.pages;
      }
    } catch (ignored) {
      // Ordered as if the route had not answered.
    }
    if (ask !== asked) return;
    seen = pages;
    answered = true;
    settled("seen");
    if (!backdrop.hidden) render(true);
  };

  // Any answer but 200, or one with no listing, keeps the pods there are.
  let read = 0;
  const askIndex = async () => {
    const ask = ++read;
    let fresh: Pod[] | null = null;
    try {
      const response = await fetch(location.pathname, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 200) {
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        if (doc.querySelector(".index-table")) fresh = listing(doc);
      }
    } catch (ignored) {
      // Listed as before.
    }
    if (ask !== read) return;
    settled("index");
    if (fresh === null) return;
    pods = fresh;
    if (!backdrop.hidden) render(true);
  };

  const show = () => {
    const at = document.activeElement as HTMLElement | null;
    let inner: HTMLElement | null = null;
    if (at && at.tagName === "IFRAME") {
      const frame = at as HTMLIFrameElement;
      try {
        inner = frame.contentDocument ? frame.contentDocument.activeElement as HTMLElement | null : null;
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

  // Close the finder, focus back where it was unless restore is false.
  const hide = (restore: boolean) => {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    list.replaceChildren();
    shown = [];
    selected = -1;
    input.removeAttribute("aria-activedescendant");
    const was = back;
    back = null;
    if (!restore || !was) return;
    if (was.at && was.at !== document.body && was.at.isConnected) was.at.focus({ preventScroll: true });
    else input.blur();
    if (was.inner && was.inner.isConnected) was.inner.focus({ preventScroll: true });
  };

  // Open the pod at the place given: in a tab, else in a browser tab.
  const choose = (at: number, browser: boolean) => {
    const choice = shown[at];
    if (!choice) return;
    if (browser) {
      window.open(new URL(choice.pod.href, location.href).href, "_blank", "noopener");
      hide(true);
      return;
    }
    hide(false);
    document.dispatchEvent(new CustomEvent<PodOpenDetail>("lotuspod:open", { detail: {
      name: choice.pod.name, title: choice.pod.title, href: choice.pod.href,
    } }));
  };

  input.addEventListener("input", () => {
    render(false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = selected >= 0 ? selected : step > 0 ? -1 : 0;
      select((from + step + shown.length) % shown.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) choose(selected, modified(event));
    } else if (event.key === "Tab") {
      event.preventDefault();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide(true);
    }
  });
  // A press in the dialog leaves focus in the input.
  dialog.addEventListener("mousedown", (event) => {
    if (event.target !== input) event.preventDefault();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) hide(true);
  });
  document.addEventListener("lotuspod:find", (event) => {
    if (backdrop.hidden) show();
    else if (event.detail && event.detail.toggle) hide(true);
  });
  askSeen();
})();
