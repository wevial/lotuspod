// Built from web/src/index-refresh.ts by web/build.ts. Edit that file, not this one.
(() => {
  const main = document.querySelector("main.index");
  if (!main)
    return;
  const EVERY = 60000;
  const ROWS = ".index-table tbody tr[data-page]";
  const linkOf = (row) => row.cells[0] ? row.cells[0].querySelector("a[href]") : null;
  const written = (doc) => {
    const found = new Map;
    for (const row of doc.querySelectorAll(ROWS)) {
      const link = linkOf(row);
      const summary = row.querySelector("td.episode-summary");
      found.set(row.dataset.page, JSON.stringify([
        row.getAttribute("data-labels"),
        row.getAttribute("data-archived"),
        Array.from(row.querySelectorAll("time"), (time) => time.getAttribute("datetime")),
        link ? link.textContent.trim() : null,
        link ? link.getAttribute("href") : null,
        summary ? summary.textContent.trim() : null
      ]));
    }
    return found;
  };
  const same = (left, right) => left.size === right.size && Array.from(left).every(([name, row]) => right.get(name) === row);
  const shown = () => !main.hidden && document.visibilityState === "visible";
  const swap = (fresh) => {
    const table = document.querySelector(".index-table");
    const answer = fresh.querySelector(".index-table");
    if (!table !== !answer) {
      location.reload();
      return;
    }
    if (!table || !answer || !table.tBodies[0] || !answer.tBodies[0])
      return;
    if (same(written(document), written(fresh)))
      return;
    const at = document.activeElement;
    const row = at && at.tagName === "A" ? at.closest(ROWS) : null;
    const focused = row && linkOf(row) === at ? row.dataset.page : null;
    table.tBodies[0].replaceChildren(...Array.from(answer.tBodies[0].rows, (each) => document.importNode(each, true)));
    const date = document.querySelector(".index-updated time");
    const dated = fresh.querySelector(".index-updated time");
    if (date && dated) {
      date.setAttribute("datetime", dated.getAttribute("datetime") || "");
      date.textContent = dated.textContent;
    }
    document.dispatchEvent(new CustomEvent("lotuspod:rows"));
    if (focused === null)
      return;
    for (const each of table.tBodies[0].rows) {
      if (each.dataset.page !== focused)
        continue;
      const link = linkOf(each);
      if (link)
        link.focus({ preventScroll: true });
      break;
    }
  };
  let reading = false;
  let again = false;
  const read = async () => {
    if (!shown())
      return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    let fresh = null;
    try {
      const response = await fetch(location.pathname, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 200) {
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        if (doc.querySelector("main.index"))
          fresh = doc;
      }
    } catch (ignored) {}
    reading = false;
    if (fresh && !main.hidden)
      swap(fresh);
    if (again) {
      again = false;
      read();
    }
  };
  setInterval(read, EVERY);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible")
      read();
  });
  document.addEventListener("lotuspod:listing", read);
})();
