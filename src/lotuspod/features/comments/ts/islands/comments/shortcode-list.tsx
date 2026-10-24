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

// The keys that move the caret without typing.
const MOVES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

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
  // The shortcodes closed before the table arrived, each from its opening
  // colon to after its closing one, and the field's text they are in.
  let pending: { start: number; end: number }[] = [];
  let last = field.value;
  // A send held until the table arrives, sent once.
  let holding = false;

  function optionId(index: number) {
    return id + "-" + index;
  }
  // Under the composer's box, which holds the field with its images, + and
  // send, so the list hides none of them; the room is the visible part of
  // the window, above a phone's on-screen keyboard.
  function place() {
    if (!list) return;
    const box = (field.closest(".artifact-composer-box") ?? field).getBoundingClientRect(), gap = 4;
    const seen = visualViewport, top = seen ? seen.offsetTop : 0, bottom = seen ? top + seen.height : innerHeight;
    const below = bottom - box.bottom - gap * 2, above = box.top - top - gap * 2;
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
    visualViewport?.removeEventListener("resize", place);
    visualViewport?.removeEventListener("scroll", place);
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
      visualViewport?.addEventListener("resize", place);
      visualViewport?.addEventListener("scroll", place);
    }
    shown = { ...open, names, active: same ? shown!.active : 0 };
    draw();
  }
  // The text from start to end made emoji, the caret after it, as an edit
  // the reader can undo where the field has the focus; false, and the text
  // left alone, when it would pass the field's maxlength.
  function replace(start: number, end: number, emoji: string): boolean {
    const before = field.value;
    if (field.maxLength >= 0 && before.length - (end - start) + emoji.length > field.maxLength) return false;
    field.setSelectionRange(start, end);
    if (document.activeElement !== field || !document.execCommand("insertText", false, emoji) ||
        field.value === before) {
      field.value = before.slice(0, start) + emoji + before.slice(end);
    }
    field.setSelectionRange(start + emoji.length, start + emoji.length);
    last = field.value;
    return true;
  }
  function choose(index: number) {
    if (!shown) return;
    const { start, query, names } = shown;
    if (!replace(start, start + 1 + query.length, table![names[index]!]!)) return;
    close();
    field.focus();
  }
  // The shortcode the colon before at closes becomes its emoji; the
  // emoji's length less the shortcode's, 0 for none.
  function convert(at: number): number {
    const done = table && closed(field.value, at, table);
    if (!done) return 0;
    const start = fragment(field.value, at - 1)!.start, emoji = done.text.slice(start, done.caret);
    return replace(start, at, emoji) ? emoji.length - (at - start) : 0;
  }
  // The table arrived: the shortcodes the colons typed meanwhile close
  // become their emoji, the last first so the earlier carets still hold,
  // and the reader's selection stays on the text it was on.
  function arrived() {
    const carets = pending.map(each => each.end).sort((a, b) => b - a);
    pending = [];
    let start = field.selectionStart, end = field.selectionEnd;
    for (const at of table ? carets : []) {
      const shift = convert(at);
      if (start >= at) start += shift;
      if (end >= at) end += shift;
    }
    field.setSelectionRange(start, end);
    refresh();
  }

  // The field's text was edited from last: the waiting shortcodes before
  // the edit stay, those after it move with it, and those it touched go.
  function edited() {
    const before = last, now = field.value;
    last = now;
    if (!pending.length) return;
    let head = 0, tail = 0;
    while (head < before.length && head < now.length && before[head] === now[head]) head += 1;
    while (tail < before.length - head && tail < now.length - head &&
           before[before.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
    const end = before.length - tail, shift = now.length - before.length;
    pending = pending.flatMap(each => each.end <= head ? [each]
      : each.start >= end ? [{ start: each.start + shift, end: each.end + shift }] : []);
  }

  field.addEventListener("input", event => {
    const typed = event instanceof InputEvent && event.inputType === "insertText" ? event.data ?? "" : null;
    const caret = field.selectionStart;
    edited();
    if (typed?.includes(":") && caret === field.selectionEnd) {
      if (table) convert(caret);
      else {
        const open = field.value[caret - 1] === ":" ? fragment(field.value, caret - 1) : null;
        if (open) pending.push({ start: open.start, end: caret });
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
  // A caret moved onto a fragment opens the list, and off it closes it.
  field.addEventListener("click", refresh);
  field.addEventListener("keyup", event => { if (shown || MOVES.has(event.key)) refresh(); });
  field.addEventListener("blur", close);
  // A comment sent before the table arrived waits for it, once however
  // often it is sent meanwhile, so the shortcodes typed meanwhile are sent
  // as their emoji.
  form.addEventListener("submit", event => {
    close();
    if (!pending.length && !holding) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (holding) return;
    holding = true;
    const submitter = event.submitter;
    void load().then(() => {
      arrived();
      holding = false;
      form.requestSubmit(submitter);
    });
  });
}
