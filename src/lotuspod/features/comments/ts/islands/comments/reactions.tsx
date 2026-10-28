import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { CommentRow, Page, Reaction } from "../bridge";

// The quick set the Add reaction menu offers. Each must equal its value in
// the composers' emoji table (theme/lotuspod-emoji.json) exactly, as serve
// refuses any other string: ❤️ carries its variation selector.
const QUICK = ["👍", "❤️", "🎉", "😄", "👀", "✅"] as const;

interface ReactionsProps {
  row: CommentRow;
  page: Page;
  // The page's name as its comments are stored under.
  name: string;
  // Keep the reactions a post answered on the row, which draws it again.
  store(reactions: Reaction[]): void;
}

// A comment's reactions under its text: a chip per emoji, in the order
// served, that adds or removes the reader's own, and an Add reaction button
// that opens the quick set. A post's 200 answer replaces the row's
// reactions; any other answer leaves the row as it was. A control stays
// focusable while its post saves, so focus is not lost under the reader.
export function Reactions({ row, page, name, store }: ReactionsProps) {
  const reactions = Array.isArray(row.reactions) ? row.reactions : [];
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const add = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const archived = page.archived;

  function close() {
    setOpen(false);
    add.current?.focus();
  }

  useLayoutEffect(() => {
    if (open) menu.current?.querySelector("button")?.focus();
  }, [open]);

  // A click anywhere outside the menu and Add reaction closes the menu and
  // puts focus back on Add reaction, a chip's or a field's click as well.
  // Escape closes it wherever focus is, even tabbed out of the row, and
  // goes no further, so the panel or the sheet holding it stays open. Both
  // listen from the render that opens the menu, not a frame after it.
  useLayoutEffect(() => {
    if (!open) return;
    function outside(event: MouseEvent) {
      const target = event.target as Node;
      if (menu.current?.contains(target) || add.current?.contains(target)) return;
      close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    document.addEventListener("click", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("click", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  // A row's posts are sent one after another, so each answer is newer than
  // the one before it and an older answer never replaces a newer one.
  const queue = useRef<Promise<void>>(Promise.resolve());

  function post(key: string, emoji: string, reacted: boolean) {
    if (saving.has(key)) return;
    setSaving(held => new Set(held).add(key));
    queue.current = queue.current.then(() => send(key, emoji, reacted));
  }

  async function send(key: string, emoji: string, reacted: boolean) {
    try {
      const response = await fetch(page.commentsURL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: name, comment: row.id, emoji, reacted }),
      });
      const payload = await page.json<{ reactions?: unknown }>(response);
      if (response.status === 200 && payload && Array.isArray(payload.reactions)) store(payload.reactions as Reaction[]);
    } catch {
      // Not saved: the row stays as it was.
    } finally {
      setSaving(held => {
        const next = new Set(held);
        next.delete(key);
        return next;
      });
    }
  }

  function choose(emoji: string) {
    close();
    const held = reactions.find(each => each.emoji === emoji);
    post("add", emoji, !held?.mine);
  }

  return <div class={"artifact-reactions" + (open ? " artifact-reactions--open" : "")}>
    {reactions.map(each => {
      const names = (each.by || []).join(", ");
      const busy = saving.has(each.emoji);
      return <button key={each.emoji} type="button" class="artifact-reaction" aria-pressed={each.mine ? "true" : "false"}
        title={names} aria-label={each.emoji + " " + each.count + ": " + names} disabled={archived}
        aria-disabled={busy ? "true" : undefined}
        onClick={() => post(each.emoji, each.emoji, !each.mine)}>
        {each.emoji + " " + each.count}
      </button>;
    })}
    {!archived && <button key="add" ref={add} type="button" class="artifact-reaction-add" aria-label="Add reaction"
      aria-haspopup="true" aria-expanded={open ? "true" : "false"} aria-disabled={saving.has("add") ? "true" : undefined}
      onClick={() => { if (!saving.has("add")) setOpen(!open); }}>
      <span aria-hidden="true">☺+</span>
    </button>}
    {open && <div key="menu" ref={menu} class="artifact-reaction-menu" role="group" aria-label="Quick reactions">
      {QUICK.map(emoji => <button key={emoji} type="button" class="artifact-reaction-quick" aria-label={emoji}
        onClick={() => choose(emoji)}>{emoji}</button>)}
    </div>}
  </div>;
}
