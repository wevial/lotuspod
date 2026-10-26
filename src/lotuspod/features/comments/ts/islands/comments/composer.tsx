import { render } from "preact";
import { createPortal } from "preact/compat";
import type { CommentPayload, CommentRow, ComposerBridge, Page, Spot, Thread, Widget } from "../bridge";
import type { ComposerHandles } from "./parts";
import { blockStanding, frameOf, hashOf } from "./anchor";
import { shortcodeList } from "./shortcode-list";

type Quote = NonNullable<CommentRow["quote"]>;
interface Body { page: string; text: string; parent?: number; section?: string; revision?: string; quote?: Quote; widget?: Widget; spot?: Spot; images?: string[] }

export function composers(page: Page, bridge: ComposerBridge) {
  const replies = new WeakMap<Thread, ComposerHandles & { toggle: HTMLButtonElement }>();
  // The live block a section's form for a new thread is on, with the line
  // above its field that says so, while a block's Comment holds it open.
  // seen: the hash of the block's file the page last showed beside the form.
  const blocks = new Map<HTMLFormElement, { widget: Widget; line: HTMLParagraphElement; seen: string }>();
  // stale: what a refusal for a changed page says; spot: what one for a
  // changed diagram or image says.
  function failure(response: Response, payload: CommentPayload | null, stale = page.stalePage, spot = page.staleDiagram): string {
    if (response.status === 401) return page.signedOut;
    const code = payload?.error;
    if ((response.status === 409 && code === "stale_page") || (response.status === 400 && code === "unknown_section")) return stale;
    if ((response.status === 409 && code === "stale_widget") || (response.status === 400 && code === "unknown_widget")) {
      return page.staleBlock;
    }
    if ((response.status === 409 && code === "stale_spot") || (response.status === 400 && code === "unknown_spot")) return spot;
    if (response.status === 409 && code === "archived") return page.closed;
    const error = code ? String(code) : "status " + response.status;
    return "Not saved (" + error + "). Try again.";
  }
  // first: the stored name of an image the comment must carry as its first,
  // else "": sent first when attached, and with it not attached nothing is sent.
  async function post(form: HTMLFormElement, body: Body, spotStale?: string, first = "", missing = ""): Promise<CommentRow | null> {
    const status = form.querySelector<HTMLElement>(".artifact-comment-status")!;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const images = bridge.attached.get(form);
    if (images?.busy()) { status.textContent = "Wait until the images have uploaded."; return null; }
    if (first && !images?.kept().some(image => image.name === first)) { status.textContent = missing; return null; }
    const names = images?.sending() || [];
    if (first) names.sort((a, b) => Number(b === first) - Number(a === first));
    if (names.length) body.images = names;
    let saved = false;
    button.disabled = true;
    status.textContent = "Saving...";
    try {
      const response = await fetch(page.commentsURL, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload: (CommentRow & CommentPayload) | null = await page.json(response);
      if (response.status !== 201 || !payload) {
        status.textContent = failure(response, payload, body.quote ? page.stalePage : page.staleSection, spotStale);
        return null;
      }
      status.textContent = "";
      fieldOf(form).value = "";
      saved = true;
      return payload;
    } catch {
      status.textContent = "Not saved: the site did not answer. Try again.";
      return null;
    } finally {
      images?.sent(saved);
      button.disabled = false;
    }
  }
  function fieldOf(form: HTMLFormElement): HTMLTextAreaElement {
    return form.elements.namedItem("text") as HTMLTextAreaElement;
  }
  function wireField(form: HTMLFormElement): ComposerHandles {
    const field = fieldOf(form), images = page.attachments(form, field);
    bridge.attached.set(form, images);
    shortcodeList(form, field);
    field.addEventListener("keydown", event => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button && !button.disabled) form.requestSubmit(button);
    });
    return { form, field, images, unfold(open) { form.hidden = !open; } };
  }
  // A spot's composer has its Cancel beside its send button.
  function controls(send: string, label?: string, cancel?: () => void) {
    return <><textarea name="text" rows={2} maxLength={4000} required aria-label={label} />
      <div class="artifact-comment-actions">
        {cancel && <button type="button" class="artifact-spot-cancel" onClick={cancel}>Cancel</button>}
        <button type="submit">{send}</button>
        <p class="artifact-comment-status" role="status" /></div></>;
  }
  function label(thread: Thread, entry: CommentRow) {
    const handles = replies.get(thread)!;
    const answered = bridge.rows(thread).some(each => bridge.agent(each) !== "");
    const name = answered ? "Reply" : "Add to your comment";
    const hint = answered ? "" : "Add detail. " + bridge.routed(entry) + " reads it with your comment.";
    if (handles.toggle.textContent !== name) {
      handles.toggle.textContent = name;
      handles.toggle.classList.toggle("artifact-comment-toggle--quiet", !answered);
      handles.field.setAttribute("aria-label", name);
    }
    if (handles.field.placeholder !== hint) handles.field.placeholder = hint;
  }
  function reply(thread: Thread, node: HTMLElement) {
    // The portal owns only these siblings, after the independently rendered list.
    const root = document.createElement("div");
    const id = "artifact-comment-reply-" + thread.root.id;
    render(createPortal(<><button class="artifact-comment-toggle" type="button" aria-controls={id} disabled={page.archived} />
      <form class="artifact-comment-reply" id={id}>{controls("Send")}</form></>, node), root);
    const toggle = node.querySelector<HTMLButtonElement>(".artifact-comment-toggle")!;
    const form = node.querySelector<HTMLFormElement>(".artifact-comment-reply")!;
    const handles = { ...wireField(form), toggle, unfold(open: boolean) {
      form.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    } };
    replies.set(thread, handles);
    handles.unfold(false);
    toggle.addEventListener("click", () => { handles.unfold(form.hidden === true); if (!form.hidden) handles.field.focus(); });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const row = await post(form, { page: bridge.page, parent: thread.root.id, text: handles.field.value });
      if (!row) return;
      const focused = form.contains(document.activeElement) || document.activeElement === document.body;
      handles.unfold(false);
      if (focused) toggle.focus();
      bridge.readTo(thread, row.id);
      bridge.merge(thread, [row]);
      bridge.posted();
    });
    return handles;
  }
  function fields(box: HTMLElement, field: HTMLTextAreaElement): Body {
    const body: Body = { page: bridge.page, section: box.dataset.section, text: field.value };
    const revision = bridge.revision();
    if (revision !== null) body.revision = revision;
    return body;
  }
  function stored(row: CommentRow) {
    bridge.add({ root: row, replies: [] });
    bridge.posted();
    return bridge.shown.get(row.id);
  }
  // A section's form for a new thread is on the live block widget, titled
  // title, at the state it had then, until it folds or posts.
  function block(form: HTMLFormElement, widget: Widget, title: string) {
    unblock(form);
    const line = document.createElement("p");
    line.className = "artifact-comment-on";
    render(<>{"On "}<span class="artifact-comment-on-block">{title}</span>{widget.state ? " · " + widget.state : ""}</>, line);
    form.before(line);
    blocks.set(form, { widget: { id: widget.id, hash: widget.hash, state: widget.state }, line, seen: widget.hash });
  }
  // A line about the block a form was on goes with it.
  function unblock(form: HTMLFormElement | undefined) {
    const held = form && blocks.get(form);
    if (!held) return;
    render(null, held.line);
    held.line.remove();
    blocks.delete(form!);
    const status = form!.querySelector<HTMLElement>(".artifact-comment-status")!;
    if (status.textContent === page.blockChanged || status.textContent === page.staleBlock) status.textContent = "";
  }
  // The live block a section's form is on, as it was when the form was
  // held on it; undefined for none.
  function on(form: HTMLFormElement): Widget | undefined {
    return blocks.get(form)?.widget;
  }
  // A swap took away the block a form is on, or moved it to another
  // section (boxOf: the box of a frame's section): the form is no longer on
  // it. A form on a block the swap changed stays on the version the reader
  // saw, which the route takes as an earlier version of the block, and says so
  // until the form is no longer on it; a swap that leaves the block's file as
  // it was leaves the form's status as it was.
  function swapped(boxOf: (frame: HTMLIFrameElement) => HTMLElement | null) {
    blocks.forEach((held, form) => {
      const frame = frameOf(held.widget.id);
      if (!frame || boxOf(frame) !== bridge.boxWith(form)) {
        unblock(form);
        return;
      }
      const now = hashOf(frame);
      if (now === held.seen) return;
      held.seen = now;
      const status = form.querySelector<HTMLElement>(".artifact-comment-status")!;
      if (blockStanding(held.widget) === "changed") status.textContent = page.blockChanged;
      else if (status.textContent === page.blockChanged) status.textContent = "";
    });
  }
  function wire(box: HTMLElement) {
    const form = bridge.forms.get(box)!;
    const handles = wireField(form);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      let mine = bridge.boxWith(form);
      if (!mine) return;
      const body = fields(mine, handles.field);
      const on = blocks.get(form);
      if (on) body.widget = { ...on.widget };
      const saving = post(form, body);
      bridge.sending.set(form, saving);
      const row = await saving;
      bridge.sending.delete(form);
      mine = bridge.boxWith(form);
      if (row) {
        if (on && blocks.get(form) === on) unblock(form);
        const thread = stored(row);
        if (mine) bridge.placement().posted(mine, thread);
      }
    });
    return handles;
  }
  function passage(box: HTMLElement, quote: Quote, cancel: () => void, saved: (row: CommentRow) => void) {
    // Placement can move this root without moving any Preact-owned child.
    const holder = document.createElement("div");
    holder.className = "artifact-passage-composer";
    render(<><p class="artifact-passage-quote">{quote.exact}</p>
      <form class="artifact-comment-form artifact-passage-form">{controls("Comment", "Comment on the selected words")}</form>
      <button type="button" class="artifact-passage-cancel" onClick={cancel}>Cancel</button></>, holder);
    const handles = { ...wireField(holder.querySelector("form")!), holder, saving: null as Promise<CommentRow | null> | null };
    holder.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    });
    handles.form.addEventListener("submit", async event => {
      event.preventDefault();
      handles.saving = post(handles.form, { ...fields(box, handles.field), quote });
      const row = await handles.saving;
      handles.saving = null;
      if (!row) return;
      const focused = holder.contains(document.activeElement) || document.activeElement === document.body;
      saved(row);
      bridge.placement().started(stored(row), focused);
    });
    return handles;
  }
  // The composer under a mark on a diagram or an image, in box's section:
  // spot() gives the spot as its target now stands, and what a refusal for
  // a changed target says. Cancel and Escape call cancel; a thread posted
  // calls saved first. A send waits for ready, which says why it may not go
  // ("" when it may): an image spot is never posted without its crop. While
  // it waits, Comment is disabled and a second send does nothing.
  // first: the stored name of the image it must post first, as found by
  // ready, else ""; missing: what it says when that image is not attached.
  function spot(box: HTMLElement, made: () => { spot: Spot; stale: string; first: string }, cancel: () => void,
    saved: (row: CommentRow) => void, ready: () => Promise<string>, missing = "") {
    const holder = document.createElement("div");
    holder.className = "artifact-spot-composer";
    render(<form class="artifact-comment-form artifact-spot-form">{controls("Comment", "Comment on the marked spot", cancel)}</form>, holder);
    const handles = { ...wireField(holder.querySelector("form")!), holder, saving: null as Promise<CommentRow | null> | null };
    holder.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    });
    let waiting = false;
    handles.form.addEventListener("submit", async event => {
      event.preventDefault();
      if (waiting || handles.saving) return;
      const button = handles.form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const status = handles.form.querySelector<HTMLElement>(".artifact-comment-status")!;
      waiting = true;
      button.disabled = true;
      status.textContent = "Saving...";
      const why = await ready();
      waiting = false;
      button.disabled = false;
      status.textContent = why;
      if (why) return;
      const now = made();
      handles.saving = post(handles.form, { ...fields(box, handles.field), spot: now.spot }, now.stale, now.first, missing);
      const row = await handles.saving;
      handles.saving = null;
      if (!row) return;
      const focused = holder.contains(document.activeElement) || document.activeElement === document.body;
      saved(row);
      // The new thread opens in the panel, which may be folded: the composer
      // was over the page, not in it.
      const thread = stored(row);
      if (thread && focused && bridge.placement().wide) bridge.placement().open(thread);
      else bridge.placement().started(thread, focused);
    });
    return handles;
  }
  // A thread's reply composer.
  function handles(thread: Thread) {
    return replies.get(thread)!;
  }
  return { reply, wire, passage, spot, label, failure, block, unblock, on, swapped, fieldOf, handles, sending: bridge.sending };
}
