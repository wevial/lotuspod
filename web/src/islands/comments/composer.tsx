import { render } from "preact";
import { createPortal } from "preact/compat";
import type { CommentPayload, CommentRow, ComposerBridge, Page, Thread } from "../bridge";
import type { ComposerHandles } from "./parts";

type Quote = NonNullable<CommentRow["quote"]>;
interface Body { page: string; text: string; parent?: number; section?: string; revision?: string; quote?: Quote; images?: string[] }

export function composers(page: Page, bridge: ComposerBridge) {
  const replies = new WeakMap<Thread, ComposerHandles & { toggle: HTMLButtonElement }>();
  function failure(response: Response, payload: CommentPayload | null, stale = page.stalePage): string {
    if (response.status === 401) return page.signedOut;
    if (response.status === 409 && payload?.error === "stale_page") return stale;
    const error = payload?.error ? String(payload.error) : "status " + response.status;
    return "Not saved (" + error + "). Try again.";
  }
  async function post(form: HTMLFormElement, body: Body): Promise<CommentRow | null> {
    const status = form.querySelector<HTMLElement>(".artifact-comment-status")!;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const images = bridge.attached.get(form);
    if (images?.busy()) { status.textContent = "Wait until the images have uploaded."; return null; }
    const names = images?.sending() || [];
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
        status.textContent = failure(response, payload, body.quote ? page.stalePage : page.staleSection);
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
    field.addEventListener("keydown", event => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
      event.preventDefault();
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (button && !button.disabled) form.requestSubmit(button);
    });
    return { form, field, images, unfold(open) { form.hidden = !open; } };
  }
  function controls(send: string, label?: string) {
    return <><textarea name="text" rows={2} maxLength={4000} required aria-label={label} />
      <div class="artifact-comment-actions"><button type="submit">{send}</button>
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
  function wire(box: HTMLElement) {
    const form = bridge.forms.get(box)!;
    const handles = wireField(form);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      let mine = bridge.boxWith(form);
      if (!mine) return;
      const saving = post(form, fields(mine, handles.field));
      bridge.sending.set(form, saving);
      const row = await saving;
      bridge.sending.delete(form);
      mine = bridge.boxWith(form);
      if (row) {
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
  return { reply, wire, passage, label, failure, sending: bridge.sending };
}
