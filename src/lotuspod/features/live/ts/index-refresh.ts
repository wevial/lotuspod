// Lotuspod index script: the listing kept fresh. While the listing is shown
// (no tab active) and the window is seen, the index reads its own page again
// every 60 seconds, at once when the window is seen again, and each time the
// listing shows again over the tabs ("lotuspod:listing"). While a tab is
// active it reads nothing. Reads never overlap: one asked while another is
// under way follows it, so a later answer always wins. Any answer but 200, or
// one that is not an index, leaves the listing as it is, and so does one that
// answers once a tab is active.
//
// The rows are compared by what render wrote and no script touches, as a map
// by page name, since a reader's sort reorders the live rows: each row's
// data-page, data-labels and data-archived, the datetime of its two dates,
// its title link's text and href, and its summary. When they differ, the live
// table's rows give way to the answer's and the "updated" date with them, and
// the index's own script and the tabs are told ("lotuspod:rows"), to read the
// rows again; the search, the labels checked, the toggles, the sort, the view
// and the tabs stay as the reader left them. Focus on a row's title link
// moves to the new row's link for the same page. An index going from no table
// to a table, or back, loads again, since its controls are built for one or
// the other.
//
// This compares rows in a shape of its own rather than the finder's pods
// (features/index/ts/pod-finder.ts), which leave out what a row is archived at,
// when it was created and its labels as written.
(() => {
  const main = document.querySelector<HTMLElement>("main.index");
  if (!main) return;

  const EVERY = 60_000;
  const ROWS = ".index-table tbody tr[data-page]";

  const linkOf = (row: HTMLTableRowElement) =>
    row.cells[0] ? row.cells[0].querySelector<HTMLAnchorElement>("a[href]") : null;

  // What render wrote of each row, by its page's name.
  const written = (doc: Document) => {
    const found = new Map<string, string>();
    for (const row of doc.querySelectorAll<HTMLTableRowElement>(ROWS)) {
      const link = linkOf(row);
      const summary = row.querySelector("td.episode-summary");
      found.set(row.dataset.page!, JSON.stringify([
        row.getAttribute("data-labels"),
        row.getAttribute("data-archived"),
        Array.from(row.querySelectorAll("time"), (time) => time.getAttribute("datetime")),
        link ? link.textContent.trim() : null,
        link ? link.getAttribute("href") : null,
        summary ? summary.textContent.trim() : null,
      ]));
    }
    return found;
  };

  const same = (left: Map<string, string>, right: Map<string, string>) =>
    left.size === right.size && Array.from(left).every(([name, row]) => right.get(name) === row);

  // The answer's rows in place of the live ones, when they differ.
  const swap = (fresh: Document) => {
    const table = document.querySelector<HTMLTableElement>(".index-table");
    const answer = fresh.querySelector<HTMLTableElement>(".index-table");
    if (!table !== !answer) {
      location.reload();
      return;
    }
    if (!table || !answer || !table.tBodies[0] || !answer.tBodies[0]) return;
    if (same(written(document), written(fresh))) return;
    const at = document.activeElement;
    const row = at && at.tagName === "A" ? at.closest<HTMLTableRowElement>(ROWS) : null;
    const focused = row && linkOf(row) === at ? row.dataset.page! : null;
    table.tBodies[0].replaceChildren(...Array.from(answer.tBodies[0].rows,
      (each) => document.importNode(each, true)));
    const date = document.querySelector(".index-updated time");
    const dated = fresh.querySelector(".index-updated time");
    if (date && dated) {
      date.setAttribute("datetime", dated.getAttribute("datetime") || "");
      date.textContent = dated.textContent;
    }
    document.dispatchEvent(new CustomEvent("lotuspod:rows"));
    if (focused === null) return;
    for (const each of table.tBodies[0].rows) {
      if (each.dataset.page !== focused) continue;
      const link = linkOf(each);
      if (link) link.focus({ preventScroll: true });
      break;
    }
  };

  let reading = false;
  let again = false;
  const read = async () => {
    if (main.hidden || document.visibilityState !== "visible") return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    let fresh: Document | null = null;
    try {
      const response = await fetch(location.pathname, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 200) {
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        if (doc.querySelector("main.index")) fresh = doc;
      }
    } catch (ignored) {
      // Listed as before.
    }
    reading = false;
    // A tab made active meanwhile keeps the answer from being drawn, or from
    // loading the index again under the reader's unsent text; showing the
    // listing again reads anew.
    if (fresh && !main.hidden) swap(fresh);
    if (again) {
      again = false;
      read();
    }
  };

  setInterval(read, EVERY);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") read();
  });
  document.addEventListener("lotuspod:listing", read);
})();
