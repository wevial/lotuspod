import { render } from "preact";
import { closed, fragment, matches, type Table } from "./shortcodes";

// The emoji table, theme/lotuspod-emoji.json at the page's theme address,
// fetched once for every composer on the page, on the first colon typed in
// any of them. A failed fetch leaves the composers as they were; the next
// colon tries again.
const TABLE = "lotuspod-emoji.json";
let table: Table | null = null;
let loading: Promise<Table | null> | null = null;

function address(): string {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="?v="]');
  const theme = /[?&]v=([^&#]*)/.exec(link?.getAttribute("href") ?? "")?.[1] ?? "";
  return new URL(TABLE + "?v=" + theme, link?.href ?? location.href).href;
}

function load(): Promise<Table | null> {
  loading ??= fetch(address())
    .then(response => response.ok ? response.json() as Promise<Table> : Promise.reject(new Error(String(response.status))))
    .then(fetched => (table = fetched))
    .catch(() => { loading = null; return null; });
  return loading;
}

// Each list's id stays unique among the page's composers.
let made = 0;

// A composer's field turns a typed `:shortcode:` into its emoji, and lists
// the emoji whose shortcodes match a fragment of two or more characters,
// under the field's box (or above it without room below). Arrow keys move the
// active option, Enter or Tab or a click inserts it, Escape closes the list
// alone.
export function shortcodeList(form: HTMLFormElement, field: HTMLTextAreaElement): void {
  const id = "artifact-shortcodes-" + (made += 1);
  let list: HTMLUListElement | null = null;
  // The open list: its fragment's opening colon and name, its shortcodes
  // and the active one's index.
  let shown: { start: number; query: string; names: string[]; active: number } | null = null;
  // The carets after the colons typed since the first, before the table
  // arrived.
  let pending: number[] = [];

  function optionId(index: number) {
    return id + "-" + index;
  }
  // Under the composer's box, which holds the field with its images, + and
  // send, so the list hides none of them.
  function place() {
    if (!list) return;
    const box = (field.closest(".artifact-composer-box") ?? field).getBoundingClientRect(), gap = 4;
    const below = innerHeight - box.bottom - gap * 2, above = box.top - gap * 2;
    list.style.left = box.left + "px";
    list.style.width = box.width + "px";
    list.style.maxHeight = "";
    const height = list.offsetHeight;
    const under = height <= below || below >= above;
    if (height > Math.max(below, above)) list.style.maxHeight = Math.max(below, above) + "px";
    list.style.top = (under ? box.bottom + gap : box.top - gap - list.offsetHeight) + "px";
  }
  // A scroll anywhere but in the list moves the field under it.
  function scrolled(event: Event) {
    if (event.target !== list) place();
  }
  function draw() {
    if (!shown) return;
    if (!list) {
      list = document.createElement("ul");
      list.className = "artifact-shortcodes";
      list.id = id;
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Emoji");
      form.append(list);
    }
    const { names, active } = shown;
    render(<>{names.map((name, index) => <li id={optionId(index)} role="option" class="artifact-shortcode"
      aria-selected={index === active ? "true" : "false"}
      onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
      <span class="artifact-shortcode-emoji">{table![name]}</span>{" "}:{name}:</li>)}</>, list);
    list.hidden = false;
    field.setAttribute("aria-controls", id);
    field.setAttribute("aria-autocomplete", "list");
    field.setAttribute("aria-activedescendant", optionId(active));
    place();
    const option = list.children[active] as HTMLElement;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }
  function close() {
    if (!shown) return;
    shown = null;
    list!.hidden = true;
    render(null, list!);
    field.removeAttribute("aria-controls");
    field.removeAttribute("aria-autocomplete");
    field.removeAttribute("aria-activedescendant");
    removeEventListener("scroll", scrolled, true);
    removeEventListener("resize", place);
  }
  // Open, move or close the list for the fragment before the caret.
  function refresh() {
    const caret = field.selectionStart;
    const open = table && document.activeElement === field && caret === field.selectionEnd
      ? fragment(field.value, caret) : null;
    const names = open && open.query.length >= 2 ? matches(table!, open.query) : [];
    if (!open || !names.length) { close(); return; }
    const same = shown && shown.start === open.start && shown.query === open.query;
    if (!shown) {
      addEventListener("scroll", scrolled, true);
      addEventListener("resize", place);
    }
    shown = { ...open, names, active: same ? shown!.active : 0 };
    draw();
  }
  function put(text: string, caret: number) {
    field.value = text;
    field.setSelectionRange(caret, caret);
  }
  function choose(index: number) {
    if (!shown) return;
    const { start, query, names } = shown;
    const end = start + 1 + query.length, emoji = table![names[index]!]!;
    put(field.value.slice(0, start) + emoji + field.value.slice(end), start + emoji.length);
    close();
    field.focus();
  }
  // The shortcode a typed colon closes becomes its emoji.
  function convert() {
    const caret = field.selectionStart;
    const done = table && caret === field.selectionEnd ? closed(field.value, caret, table) : null;
    if (done) put(done.text, done.caret);
  }
  // The table arrived: the shortcodes the colons typed meanwhile close
  // become their emoji, the last first so the earlier carets still hold.
  function arrived() {
    const carets = pending.sort((a, b) => b - a);
    pending = [];
    let text = field.value, start = field.selectionStart, end = field.selectionEnd;
    for (const at of table ? carets : []) {
      const done = closed(text, at, table!);
      if (!done) continue;
      const shift = done.caret - at;
      text = done.text;
      if (start >= at) start += shift;
      if (end >= at) end += shift;
    }
    if (text !== field.value) {
      field.value = text;
      field.setSelectionRange(start, end);
    }
    refresh();
  }

  field.addEventListener("input", event => {
    const typed = event instanceof InputEvent && event.inputType === "insertText" ? event.data ?? "" : null;
    const caret = field.selectionStart;
    // Only text typed after them leaves the waiting colons where they were.
    if (typed === null || caret - typed.length < Math.max(0, ...pending)) pending = [];
    if (typed?.includes(":")) {
      if (table) convert();
      else {
        pending.push(caret);
        void load().then(arrived);
      }
    }
    refresh();
  });
  field.addEventListener("keydown", event => {
    if (!shown || event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const count = shown.names.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      shown.active = (shown.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
      draw();
    } else if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
      choose(shown.active);
    } else if (event.key === "Escape") {
      close();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  for (const type of ["click", "keyup"]) field.addEventListener(type, () => { if (shown) refresh(); });
  field.addEventListener("blur", close);
  form.addEventListener("submit", close);
}
