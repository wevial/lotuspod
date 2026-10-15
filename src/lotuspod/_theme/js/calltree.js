// Built from web/src/calltree.ts by web/build.ts. Edit that file, not this one.
(() => {
  for (const tree of document.querySelectorAll("div.calltree")) {
    const rows = Array.from(tree.querySelectorAll("div.calltree-row"));
    const depths = rows.map((row) => Number(row.dataset.depth) || 0);
    const carets = new Map;
    const folded = new Map;
    const end = (index) => {
      let next = index + 1;
      while (next < rows.length && depths[next] > depths[index])
        next++;
      return next;
    };
    const name = (index) => rows[index].querySelector(".calltree-name")?.textContent ?? "";
    const setOpen = (index, open) => {
      const caret = carets.get(index);
      caret.setAttribute("aria-expanded", String(open));
      caret.setAttribute("aria-label", `${open ? "Fold" : "Open"} ${name(index)}`);
      folded.get(index).hidden = open;
      for (let next = index + 1, last = end(index);next < last; next++) {
        rows[next].hidden = !open;
        if (open && carets.get(next)?.getAttribute("aria-expanded") === "false")
          next = end(next) - 1;
      }
    };
    rows.forEach((row, index) => {
      const cell = row.querySelector(".calltree-tree");
      const mark = cell?.querySelector(".calltree-mark");
      if (!cell || !mark)
        return;
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
      for (let next = index + 1, last = end(index);next < last; next++) {
        const kind = rows[next].dataset.kind;
        if (kind === "text")
          continue;
        inside++;
        if (kind === "changed")
          changed++;
        if (kind === "new")
          added++;
      }
      const count = document.createElement("span");
      count.className = "calltree-folded";
      count.hidden = true;
      count.append(`${inside} inside`);
      for (const [n, kind] of [[changed, "changed"], [added, "new"]]) {
        if (!n)
          continue;
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
    const inner = Array.from(carets.keys()).filter((index) => depths[index] > 0);
    const head = tree.querySelector("div.calltree-head");
    if (!inner.length || !head)
      continue;
    const all = document.createElement("button");
    all.type = "button";
    all.className = "calltree-fold-all";
    all.textContent = "Fold all";
    head.append(all);
    all.addEventListener("click", () => {
      const fold = all.textContent === "Fold all";
      if (fold) {
        for (const index of inner.slice().reverse())
          setOpen(index, false);
        for (const index of carets.keys())
          if (depths[index] === 0)
            setOpen(index, true);
      } else {
        for (const index of carets.keys())
          setOpen(index, true);
      }
      all.textContent = fold ? "Open all" : "Fold all";
    });
  }
})();
