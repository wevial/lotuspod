// Lotuspod page script: calltree folding. Each parent row of a calltree block
// (a row followed by a deeper one) gets a caret before its marker, and every
// other row an empty spacer of the same width, so names stay in line.
// Pressing a caret folds the row: its descendants (the following rows deeper
// than it, up to the next at its depth or shallower) are hidden, and after
// its name it shows what they hold, "N inside · C changed · M new", text rows
// not counted. Pressing it again opens the row, its descendants showing again
// but for those under one that is still folded. A parent is folded when its
// caret is aria-expanded="false": the DOM holds the state.
//
// When a tree has a parent below its roots, its head gets "Fold all", which
// folds every such parent and leaves the roots open, then reads "Open all",
// which opens every parent. Without scripts the tree shows in full.
(() => {
  for (const tree of document.querySelectorAll<HTMLElement>("div.calltree")) {
    const rows = Array.from(tree.querySelectorAll<HTMLElement>("div.calltree-row"));
    const depths = rows.map(row => Number(row.dataset.depth) || 0);
    const carets = new Map<number, HTMLButtonElement>();
    const folded = new Map<number, HTMLElement>();

    // The index after the last descendant of the row at index.
    const end = (index: number): number => {
      let next = index + 1;
      while (next < rows.length && depths[next] > depths[index]) next++;
      return next;
    };

    const name = (index: number): string =>
      rows[index].querySelector(".calltree-name")?.textContent ?? "";

    const setOpen = (index: number, open: boolean): void => {
      const caret = carets.get(index)!;
      caret.setAttribute("aria-expanded", String(open));
      caret.setAttribute("aria-label", `${open ? "Fold" : "Open"} ${name(index)}`);
      folded.get(index)!.hidden = open;
      const last = end(index);
      for (let next = index + 1; next < last; next++) {
        rows[next].hidden = !open;
        // An open row's descendants show but for those under one still
        // folded, which its folding already hid.
        if (open && carets.get(next)?.getAttribute("aria-expanded") === "false") next = end(next) - 1;
      }
    };

    rows.forEach((row, index) => {
      const cell = row.querySelector<HTMLElement>(".calltree-tree");
      const mark = cell?.querySelector(".calltree-mark");
      if (!cell || !mark) return;
      if (end(index) === index + 1) {
        const leaf = document.createElement("span");
        leaf.className = "calltree-leaf";
        cell.insertBefore(leaf, mark);
        return;
      }
      const caret = document.createElement("button");
      caret.type = "button";
      caret.className = "calltree-caret";
      caret.setAttribute("aria-expanded", "true");
      caret.setAttribute("aria-label", `Fold ${name(index)}`);
      cell.insertBefore(caret, mark);

      let inside = 0, changed = 0, added = 0;
      for (let next = index + 1, last = end(index); next < last; next++) {
        const kind = rows[next].dataset.kind;
        if (kind === "text") continue;
        inside++;
        if (kind === "changed") changed++;
        if (kind === "new") added++;
      }
      const count = document.createElement("span");
      count.className = "calltree-folded";
      count.hidden = true;
      count.append(`${inside} inside`);
      for (const [n, kind] of [[changed, "changed"], [added, "new"]] as const) {
        if (!n) continue;
        const part = document.createElement("span");
        part.className = `calltree-folded-${kind}`;
        part.textContent = `${n} ${kind}`;
        count.append(" · ", part);
      }
      cell.append(count);
      carets.set(index, caret);
      folded.set(index, count);
      caret.addEventListener("click", () => {
        setOpen(index, caret.getAttribute("aria-expanded") === "false");
      });
    });

    const inner = Array.from(carets.keys()).filter(index => depths[index] > 0);
    const head = tree.querySelector("div.calltree-head");
    if (!inner.length || !head) continue;
    const all = document.createElement("button");
    all.type = "button";
    all.className = "calltree-fold-all";
    all.textContent = "Fold all";
    head.append(all);
    all.addEventListener("click", () => {
      const fold = all.textContent === "Fold all";
      if (fold) {
        // Deepest first, so each fold hides rows already folded under it.
        for (const index of inner.slice().reverse()) setOpen(index, false);
        for (const index of carets.keys()) if (depths[index] === 0) setOpen(index, true);
      } else {
        for (const index of carets.keys()) setOpen(index, true);
      }
      all.textContent = fold ? "Open all" : "Fold all";
    });
  }
})();
