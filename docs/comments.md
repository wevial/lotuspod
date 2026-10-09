# Reading and answering pages

For people reading pages and answering on them: the routes that keep a
reader's answers and comments, the comment boxes, the comments panel, the
popover and bottom sheet, comments on passages, and how a comment is routed
to an agent. Decision tables are written as in
[Publishing pages](publishing.md#decisions-for-the-maintainer); the agents'
side of a comment is in [Agents](agents.md). Back to the
[README](../README.md).

## Answers and comments

serve keeps the reader's answers and comments in one SQLite file,
`lotuspod.sqlite3` beside the artifacts directory (`artifacts/../`), or the
file `serve --db PATH` names. It is made on first write, its schema versioned
with `PRAGMA user_version`, and it runs in WAL mode, so SQLite keeps
`lotuspod.sqlite3-wal` and `-shm` files beside it; `.gitignore` covers all
three. A `--db` inside the artifacts directory is refused at start (exit 1):
the artifacts repository commits everything there. serve never answers the
file either way.

Seven routes sit behind the Access check of [Who is reading: Cloudflare
Access](operating.md#who-is-reading-cloudflare-access) (with `POST /api/media`, under
[Serve](operating.md#serve)); each row records the verified
reader as `actor`, the page's `lotuspod:revision` when it was written as
`revision`, and `createdAt` (UTC, ISO 8601). Ids are integers never given out
twice.

- `POST /api/answers` with `{page, question, version, choice, note}` stores an
  answer and answers 201 with it, its `supersedes` the id of the answer to the
  same page and question it replaces, or null. A checklist (see [Checklist for
  the maintainer](publishing.md#checklist-for-the-maintainer)) takes
  `{page, question, version, checked, note}`, `checked` the item ids the
  reader checked, in any order; its answer carries `checked`, those ids in the
  page's order, and `choice` "". Only a checklist's answer has `checked`.
- `GET /api/answers?page=NAME` answers `{page, questions}`: each answered
  question as `{current, earlier}`, the newest answer and the older ones newest
  first. Each answer here also carries `asked`, `{text, label}`: the question's
  text and the chosen option's label as the page asked them when the answer
  was given, both null in an answer stored before they were kept. A
  checklist's `label` is the items changed from their defaults, "On: LABEL,
  LABEL · Off: LABEL" or "No change from the defaults".
- `POST /api/comments` with `{page, section, text}` (and optionally a `quote`,
  `{exact, prefix, suffix}`, and the `revision` the reader's page was rendered
  at) opens a thread on a section; with
  `{page, parent, text}` it replies; with `{page, thread, resolved}` it
  resolves or reopens a thread (below). A new thread or reply answers 201 with the row: `section`,
  `sectionTitle` (the text of the page's h2 with that id, or empty), `parent`,
  `quote`, and its routing state (`state` and `owner`, below). A reply takes its thread's section, and a
  reply to a reply joins the same thread: `parent` is always the thread's first
  comment.
- `POST /api/comments` with `{page, question, text}` (and optionally the
  `revision` the reader's page was rendered at, and `images`) opens a thread
  on one of the page's decisions (see [Decisions for the
  maintainer](publishing.md#decisions-for-the-maintainer)) rather than on a
  section: a reader's question about the decision, which agents answer as
  they answer any thread. It is stored in the section whose comment box
  follows the decision's form, so its `section` and `sectionTitle` are that
  section's, and it is routed, claimed, replied to and resolved as any thread
  is. Every comment in it, replies included, carries `question`, the
  decision's id; no other comment has the key at all. It takes no `quote`,
  and it records no answer: the decision stays unanswered until the reader
  saves one.
- A new thread or reply may name up to 4 uploaded images as `images`, a list
  of their stored names in the order they are shown; a comment with images may
  have empty `text`. Every comment row carries `images`, each `{name, url,
  width, height}`, and `[]` when it has none.
- `GET /api/comments?page=NAME` answers `{page, revision, threads,
  maxImageBytes}`: the page's current revision, each thread as `{root,
  replies, resolution}`, threads and replies oldest first, and the largest
  image `POST /api/media` takes.
- `GET /api/revision?page=NAME` answers `{revision}`, the page's current
  revision alone; it is only read (any other method is 405).
- `POST /api/seen` with `{page, revision}` records that the reader opened
  `page` at `revision`, the revision it was rendered at, and answers 200
  `{page, revision, previous}`: `previous` is the revision recorded for this
  reader before, or null the first time. One row is kept per reader and page,
  keyed by the address Access verified (never the shown name), so it holds on
  every device the reader uses.
- `GET /api/seen`, with no query, answers `{pages: {NAME: {revision,
  seen}}}`: one entry for each page this reader has a row for that serve
  still answers, `revision` the page's current one and `seen` the one last
  recorded. A page since hidden or removed drops out. It never names a reader.

An open page notices when it is published again: every published page
carries a revision, so it loads the page script, `lotuspod-page.js`, even
with no comments, decisions or sections. It compares the
`lotuspod:revision` it was rendered at with the revision each read of its
threads carries, and asks `/api/revision` every 60 seconds and at once when
its tab is seen again. Once they differ, a banner fixed over the top of the
window, which moves no text and is announced politely, reads "A newer version
of this page is available" with a Reload button. Reload brings the new
revision back at the same scroll position, with the comments thread that was
open open again and any comment or reply not yet sent back in its composer,
its text and its uploaded images (kept per page in sessionStorage; where the
browser keeps nothing, the page still reloads, at its top). A comment
written where the new revision has no place for it, on a section renamed or
removed or on words that changed, opens in a form for a new thread on its
section, else on the section in the same place, else on the first, saying
why. A page that notices while its tab is hidden, with no unsent text or
image in a composer, reloads itself the same way, so it is current when the
reader comes back; with one, or an image still uploading, it waits, the
banner showing.

Once per load, an open page with a `lotuspod:revision` posts it to
`/api/seen`; a signed-out reader's 401, or any failure, shows nothing. The
index reads `/api/seen` to mark the pages republished since the reader last
opened them (see [Index](publishing.md#index)). Agents are not readers: the
agents' socket records nothing here, and an agent's or the responder's
republish is an update like any other.

A thread is resolved or open, and every change is kept: who made it and
when. A thread's `resolution` is `{resolved, actor, at}` as its newest
change left it, or `{resolved: false, actor: null, at: null}` when nothing
has changed it. `POST /api/comments` with `{page, thread, resolved}`, where
`thread` is the id of a thread's first comment on that page (else 404
`unknown_thread`) and `resolved` a boolean, resolves the thread, or reopens
it, as the reader, and answers 200 `{thread, resolution}`; a change is stored
only when it changes the resolution, so resolving a resolved thread stores
nothing. A reader's reply to a resolved thread reopens it, as that reader.
Agents resolve and reopen threads too (`lotuspod comments resolve` and
`reopen`; see [Agents: the pull loop](agents.md#agents-the-pull-loop)). A resolution never changes a comment's routing: a pending
comment in a resolved thread is still routed and pulled.

Every answer is JSON with `Cache-Control: no-store`, and a refused request
stores nothing. A POST sent from a page of another origin (its `Origin`, or
`Sec-Fetch-Site: cross-site`) is 403 `cross_origin`: the request's own origin
is its `Host` over the scheme `X-Forwarded-Proto` names (the tunnel ends the
TLS), else `http`; one that is not
`application/json` 415; one with no length 411; a body over 16 KiB 413. A
missing, extra or mistyped field is 400 `invalid_body`, as are `question`,
`version` or `choice` outside 1 to 100 characters, a `resolved` that is not a boolean, an empty `section` (any
heading id's length is taken, since it must name one of the page's boxes),
`text` outside 1 to 4000, `note` over 4000, a quote whose `exact` is outside 1 to 500 or
whose `prefix` or `suffix` is over 32 (code points, as Python counts them), a new
thread's `revision` that is not a string of at most 100 characters, a seen
`revision` that is not a string of 1 to 100, and any
`revision` on a reply, and `images` that is not a list of 1 to 4 distinct
stored names (an empty list, five, or a path among them). A name not in the
media store is 400 `unknown_image`. A page serve would not answer (hidden,
missing, not a page) is 404 `unknown_page`, and a reply to no comment on its
page 404 `unknown_parent`. A read without exactly one `page` is 400
`invalid_query`, as is a read of `/api/seen` with any query. An answer is checked against the page's own decision forms
(see [Decisions for the maintainer](publishing.md#decisions-for-the-maintainer)): a question the page does not ask is 400 `unknown_question`, a
`version` other than the form's 409 `stale`, and a `choice` the form does not
offer 400 `invalid_choice`. A `checked` that is not a list of distinct
strings, a `checked` sent for a decision and a `choice` sent for a checklist
are 400 `invalid_body`, and an item the checklist does not offer 400
`invalid_choice`. A new thread is checked against the page's comment
boxes (below): a `section` the page has no box for is 400 `unknown_section`,
and a `revision` other than the page's current one is 409 `stale_page`, so a
quote is never stored against a revision its words were not taken from.
Without a `revision` (a page rendered with none), a new thread is taken as is.
A thread on a decision is checked in this order: 404 `unknown_page`, 400
`unknown_question` for a `question` the page does not ask, 400
`unknown_section` when the page has no comment box after the decision's form
(a page rendered without comments), and 409 `stale_page` for a `revision`
other than the page's. Its body with a `section` or a `quote` beside
`question` is 400 `invalid_body`.

## Comments

A remark about one part of a page belongs next to it. `publish` ends every h2
section of a page with a comment box, and `render --comments` does the same
(off by default for `render`; `publish --no-comments` turns it off). A section
runs from its heading to the next h2 or the end of the body; a body with fewer
than two h2 sections gets one box, for the whole page, at its end. The pass
runs on the body's HTML after the outline pass, so markdown and HTML pages
alike get it, and each box names its heading's id: `--comments` with
`--no-outline` is refused (exit 1, nothing written). A heading inside a
diagram or a form starts no section, so a box never lands inside either.

Each box is a `details.artifact-comment` with `data-page` and `data-section`
(the heading's id, or `page`), holding the section's threads and a form to
start a new one. The page script, `lotuspod-page.js`, reads the page's threads
and draws each in its section's box as a chat. A comment is a row: an avatar,
a name line (address or handle, then time) and a bubble holding only its
text. A comment whose actor's `kind` is `human` is the reader's: on the right,
behind a round avatar with the address's first two letters. A comment whose
actor's `kind` is `agent` is an agent's: on the left, behind a square lavender
avatar, its handle in the mono voice and an `AGENT` tag, then, when the reply
names the model that wrote it, the model as a quiet label (muted, smaller, in
the mono voice, drawn as written); a reply that names none shows no label.
Whether a comment is
an agent's is read from the verified actor's kind, never from an address; any
other kind is drawn as a reader's row with no tag. Each thread ends in a
rounded composer with a round send button for a reply, folded behind a
control until clicked: "Add to your comment", in the quiet voice, while no
agent has answered in the thread, and "Reply" once one has. The box ends in a
composer for a new thread. Posting adds the comment without a reload (and
folds a thread's composer again). With the page script a box never opens in
the text: its summary is a chip (below) that opens its threads in the
comments panel, a popover or a bottom sheet, as the window allows; a page
read without the script keeps the plain box. A thread whose section the page
no longer has is listed at the end of the body under "Comments on sections
that have changed" (in the panel, where there is one). Every author and text
is set as text, never as markup.

A bubble draws its text as a small markdown subset, a reader's comment and an
agent's reply alike (the page script's `js/comment-markdown.js`, which builds
every node itself and sets every text as text, so raw HTML and entities show
as typed):

- A blank line separates paragraphs; a single newline inside one stays a line
  break.
- `**bold**` is bold and `*italic*` is italic. `_` is always literal, so
  `snake_case` names survive, and a `*` with a space after it opens nothing.
- `` `code` `` is inline code, its contents literal, markdown included. A line
  of three backticks opens a code block and the next such line closes it; an
  unclosed block runs to the end.
- Lines starting `- ` or `* ` make a bullet list, and lines starting `1. ` a
  numbered one. Lists are one level deep: an indented item is an item.
- `[TEXT](TARGET)` is a link that opens in a new tab, its text plain, only
  when TARGET is `http:` or `https:` (any case), a `#anchor`, or a relative
  path (no `//` start, no `:` before its first `/`, `?` or `#`), as for a
  page's own links. Any other target (`javascript:`, `data:`, `mailto:`,
  `//host/`) leaves the whole link as typed.
- Anything else (headings, quotes, tables, images, HTML) is literal text.

A passage's opening words in a list stay plain text.

With the page script every composer is one rounded box: the images
attached sit above the field as square thumbnails, and under the field a +
(named "Add image") opens the file picker; the round send button sits in the
box's bottom-right corner and the status line below it. Each thumbnail has an
X in its corner (named "Remove image N of M") that removes it and gives the
focus back to the field, and, once uploaded, is a link to its `/media/` URL
that opens it in the image viewer, with Previous and Next between the
composer's images; Escape closes only the viewer, leaving the composer as it
was. A composer takes up to 4 images, pasted into its field, dropped on it
(a drag of text alone is left to the browser) or picked with its +, which is
disabled once 4 are attached. The page refuses a file that is not a PNG,
JPEG, WebP or GIF, or is over the `maxImageBytes` the threads route reports,
in the composer's status line, and never sends it (a file attached before
the page's first read of the threads waits for it); any other is uploaded to
`POST /api/media` at once and shown as a thumbnail, and sending the comment
names the uploaded images. While it saves, the composer takes no other image,
its + and each X are disabled and its images cannot be removed. An image
attached twice is attached once. A thumbnail shows the uploaded `/media/`
URL, never a `blob:` one, so the page policy's `img-src 'self' data:` holds. A comment's images are drawn under its text as
thumbnails, each a link that opens the full-size image in a new tab; each
box is sized from the stored width and height, so nothing moves when the bytes
arrive. A comment of images alone draws no empty bubble.

A comment's `state` is never drawn inside a bubble or a name line. HANDLE is
the handle it is routed to (its `owner`, else the page's):

| `state` | shown |
| --- | --- |
| `pending` | the thread, when this is its newest reader comment, ends in a typing bubble on the left behind a dashed avatar: "Checking for a reply from HANDLE" ("Waiting for HANDLE" once a check finds the reader signed out) |
| `claimed` | the thread, when this is its newest reader comment, ends in a typing bubble behind the agent's avatar, under "HANDLE AGENT is writing" |
| `unavailable` | a centred system line after the comment: "HANDLE is offline", "Your comment goes to HANDLE when it checks in again." |
| `paused` | a centred system line after the comment: "The responder is paused", "Your comment waits until it is resumed." |
| `failed` | a centred system line after the comment: "HANDLE couldn't answer", its `reason` (else "No reason given"), "To send it again, write a new comment." |
| `answered` | nothing: the reply says it |

While any thread on the page waits (a reader comment in it is `pending` or
`claimed`), or the reader has a thread in view (in the panel, a popover or
the sheet), and the tab is visible, the page reads `GET /api/comments` again
3 seconds after its last read, each gap half again as long as the one before,
up to 30 seconds; any change in the threads, or a comment the reader posts,
sets the gap back to 3 seconds. A thread in view is read so that an agent's
follow-up to a thread it answered arrives while the reader looks at it. It
stops when no thread waits and none is in view (a comment the reader posts,
or opening a thread, starts it again) and while the tab is hidden (shown
again, it reads at once). A read that fails keeps the schedule; one answered 401 stops
it and says the reader is signed out. Only `pending` and `claimed` wait:
`unavailable` and `paused` wait on an agent's next pull, and show on the next
visit. Each read draws what is new in place: a new comment or thread once, a
changed state's mark, nothing removed or moved, and an open composer keeps its
text and focus. Each thread's list of comments is a polite live region, so a
new reply is read out; typing bubbles and the offline and paused lines only
restate a state and are hidden from it.

### The comments panel

Wherever the window leaves at least 21rem between the reading column's right
edge and its own (checked on load and on resize), a page's threads live in a
side panel instead of its boxes, so opening a thread or a reply arriving never
moves the text. Narrower windows open a thread over the text instead, in a
popover or a bottom sheet (below); no width opens a box inline. The
panel is an `aside` named "Comments", fixed to the window's right edge under
the title bar. It starts folded to a 2.75rem rail: a "Comments" button, a
badge counting the open (unresolved) threads, and one dot per open thread in
page order, filled mint once its newest reader comment is `answered`, pulsing
lavender while it is `claimed`, and a hollow amber ring while it is `pending`,
`unavailable`, `paused` or `failed`. Opened, it is 20rem wide, headed
"Comments" and "N open · M resolved" with a "Fold comments" control, and lists
every thread under the text of its section's heading, in page order, with
threads on sections the page no longer has last under "Sections that have
changed". A section thread's entry is marked "§" and shows its first
comment's opening words, its status ("✓ Answered", "HANDLE is writing",
"Waiting for HANDLE", "HANDLE couldn't answer") and its reply count. One entry
is open at a time and holds the whole thread as a box would, with a "Resolve"
control; opening one scrolls the page to its section's chip, opening the
section first if it is folded. Each group ends in "Comment on this section",
which unfolds the box's own form in the panel. The page remembers whether the
reader left the panel open or folded in `localStorage` (a page whose storage
throws starts folded), and Escape folds it.

The open panel is resized from a handle on its left edge, a separator named
"Resize comments": dragged, its edge follows the pointer, and focused, Left
Arrow widens it and Right Arrow narrows it by 1rem. Its width stays between
16rem and 40rem, at most a third of the window (30rem at 1440 pixels), and
never so wide that the reading column keeps less than 32rem: as the panel
grows into the column's space, the column and its tables narrow to stay left
of it, and the passage at the top of the window stays where it was. The
width is kept in `localStorage` for every page on the site, and a window too
narrow for it shows the panel at its widest without forgetting it.
Double-clicking the handle goes back to 20rem and forgets the stored width. A
page whose storage throws opens it at 20rem and still resizes.

At any width, each box never opens: its summary is a one-line chip reading
where its section's open threads stand. With none, "No comments ·
Comment"; when the newest reader comment among them is `claimed`, "HANDLE is
writing…"; `pending`, `unavailable` or `paused`, "N comments · waiting",
counting every message in them; `failed`, "HANDLE couldn't answer"; otherwise
"N replies · ✓ HANDLE answered", naming the newest agent reply's handle.
Clicking it, or Enter or Space on it, opens the panel at that thread, or at
the section's form when it has none; without the panel, it opens them in a
popover or the bottom sheet.

A thread on a decision, which a card's "Ask" starts (see [Decisions for the
maintainer](publishing.md#decisions-for-the-maintainer)), is an ordinary
thread in its section's group, listed after the section's passages and
before its § threads. Its entry is marked "?" and headed "Decision N ·
QUESTION" (or "Decision · QUESTION" for a question with no number), from the
card's number and question; a popover or the bottom sheet names it "Decision
N: QUESTION", and the sheet counts it with its section's own threads. A thread
on a decision the page no longer asks is listed as one of its section's §
threads. The section's chip counts it among its section's open threads, and
the decision has a chip of its own, a button right after its card, which
reads the same way over the decision's open threads only, or "N resolved"
once all of them are. Clicking it, or Enter or Space on it, opens the panel
at the decision's newest open thread, or with its resolved threads shown at
the newest one; without the panel, it opens that thread in a popover under
the chip or in the bottom sheet.

"Resolve" resolves a thread as the reader (`{page, thread, resolved: true}`,
above): its entry folds to a dashed line, its opening words and "✓ resolved ·
Reopen", and its dot leaves the rail. "Reopen" reopens it and shows its
messages again. Under `prefers-reduced-motion: reduce` the pulsing dot keeps
still and the panel opens without sliding.

### Without room for the panel: a popover, or a bottom sheet

A window without room for the panel but at least 700 pixels wide opens a
thread in a popover (`div.artifact-comments-popover`), and a narrower one, a
phone, in a bottom sheet (`div.artifact-comments-bottom-sheet`); the mode is checked
on load and on resize, and what is open moves to the new place, a field's
typed text with it. Either holds the thread as the panel's open entry does,
the same nodes moved in from the panel and back, never drawn twice, so a
reply arriving is drawn in it in place. Both are their own theme sources,
`js/narrow.js` and `css/narrow.css`.

The popover is a non-modal dialog named by what it holds: "Section HEADING",
a passage's number and opening words, or "Decision N: QUESTION". It opens under the chip or the
highlight that opened it, inside the window and over the text, which never
moves, and scrolls on its own. One is open at a time. A chip's popover holds
its section's own threads (and those on passages not found, and resolved
ones), each with its status and "Resolve", and "Comment on this section"; a
chip reading "No comments · Comment" opens it at the section's form, its
field focused. A highlight's popover holds its thread. Escape, its "Close"
button or a click outside closes it and gives the focus back to the chip or
highlight that opened it.

The bottom sheet is a dialog fixed to the bottom of the window, at most 60%
of its height, that slides up (at once under `prefers-reduced-motion:
reduce`) when a highlight or a chip is tapped. Its header holds "‹", "N of
M" and "›" ("Previous thread" and "Next thread"), the thread's status and
"Close". M counts every open thread on the page: those on passages by their
numbers, then each section's own, labelled "Section HEADING", then those on
sections the page no longer has. A chip opens it
at its section's newest open thread, or at its form when it has none. The
sheet scrolls on its own, rises above an on-screen keyboard, and opening it
scrolls the page, never its layout, so the highlight or chip sits above it.
Escape or "Close" closes it and gives the focus back to what opened it.

### Comments on passages

A comment can be on words of a section rather than the whole of it, as in a
shared document. Selecting words in a page's body, once the selection keeps
still, shows a "Comment" pill just above the end of the selection, inside the
reading column (just below it where the primary pointer is coarse, a touch
screen, whose own menu takes the room above); it never takes focus, and Control+Alt+M (named in its
`aria-keyshortcuts`) does what pressing it does, so a selection made from the
keyboard works too. It shows only for 1 to 500 characters of the page's text
that lie wholly in it and within one section. The page's text, from which a
passage is quoted and found again, is the body's text in document order
without the comment boxes and chips, the panel, any composer, decision forms,
diagrams and the list of changed sections; the start of each block counts as
one space, every run of whitespace is one space, and lengths count code
points. Code in a `pre` block may be commented on; a decision form, a diagram
or words in two sections may not.

The pill opens a composer quoting the words, which wait under a dashed
highlight: in the panel, opened if folded, under their section's heading, or,
in a window without room for the panel, in a popover under the words or in
the bottom sheet. Escape or
"Cancel" takes it away and posts nothing. "Comment" posts the thread with its
quote (`{page, section, text, quote: {exact, prefix, suffix}, revision}`):
the selected words without whitespace at their edges, the 32 code points
either side of them (fewer at the text's edges) and the page's
`lotuspod:revision`. Answered `409 stale_page`, the composer keeps its text
and says "This page has changed since it loaded. Reload it to comment on this
passage."

Each unresolved thread whose first comment quotes a passage is found in the
page's text whenever it is read, on any revision: among the occurrences of
its words, the one between its prefix and suffix when exactly one is, else
the only occurrence, if there is one. It is never guessed between two. Its
words then wear a rose tint over a rose underline (the theme's `highlight`
and `highlight-line`), one `mark.artifact-passage` around each run of text,
each naming the thread's first comment in `aria-describedby`, and a small
number after them, hidden from assistive technology. The words light up while
the pointer is on them or on their entry, and while their thread is open;
overlapping passages stack their tints. Passages found are numbered 1, 2, 3
in page order, and the panel lists each under its section, by number, before
the section's § threads, showing its quote and status. Clicking the words or
the number opens the panel at the thread, and clicking the entry scrolls the
page to the words; without the panel, clicking the words opens the thread in
a popover under them, or in the bottom sheet.

A thread whose words are not found draws nothing on the page and keeps a
numbered entry after its section's passages found (or under "Sections that
have changed"), headed by its old quote struck through and "this passage
changed in revision R", R being the page's revision now. Its conversation and
its composer go on as before. A resolved passage thread draws neither
highlight nor number; reopening it draws them again.

An agent's reply that carries a `revision` is followed by the centred line
"HANDLE revised the page → revision R", linking to the page. Routing (below)
sets `pending` and `unavailable`, and `paused` for a comment routed to
`responder` while the default responder is paused (see [The default
responder](agents.md#the-default-responder)); an agent's
claim, reply, release and failure (see [the pull loop](agents.md#agents-the-pull-loop)) set `claimed`,
`answered` and `failed`, with the handle that took it up as its `owner`; only
a failed comment carries a `reason`. A comment grants no authority: an agent
answers it and may revise its page, nothing else.

Every reader's comment no agent has taken up is routed to exactly one handle,
by one rule that the threads routes and the agents' pull share:

- A comment whose text starts with `@HANDLE` (`@`, a handle in any case, then
  whitespace, punctuation or the end) is routed to HANDLE and only ever to
  HANDLE: `@Claude-3f9a2c, see` and `@claude-3f9a2c: see` go to
  `claude-3f9a2c`, while `email@claude-3f9a2c` names nobody. `@responder`
  names the default responder. To re-route, write a new comment naming
  someone else.
- A comment with no mention, on a page whose owner was listening when it
  arrived, is routed to the owner until the owner window has passed since it
  arrived. After that, or when the owner was not listening, or when the page
  has no owner, it is routed to `responder`.
- A handle is listening when its last pull (see [the pull
  loop](agents.md#agents-the-pull-loop)) is within the owner
  window: 300 seconds, or what `serve --owner-window SECONDS` or the config's
  `[comments] owner_window_sec` sets.

A routed comment is `pending` while its handle is listening and `unavailable`
while it is not; its `owner` is that handle (null on an agent's reply). A
claim lasts 900 seconds, or what the config's `[comments] claim_sec` sets;
a claim that expires lapses, and the comment is routed again by the same rule.

```ini
[comments]
owner_window_sec = 300
claim_sec = 900
```

A page's owner is the handle of the agent or seat that published it: 1 to 63
lower-case letters, digits and hyphens, starting with a letter or digit (a
seat such as `operator`, `hermes` or `example-seat`, or a session's handle
such as `claude-3f9a2c`). `--owner HANDLE` on `publish` or `render` needs
`--credential FILE` (or `$LOTUSPOD_CREDENTIAL`) for a credential that holds
both `publish` and HANDLE, checked in serve's database (`--db`, with serve's
default); otherwise the command exits 1 naming the problem and writes nothing.
The page carries the handle in a `lotuspod:owner` meta tag and shows
"Published by HANDLE" in its header.

```sh
lotuspod publish pond-plan.md --owner hermes --credential ~/.config/lotuspod/hermes.token
```

As with every credential, this keeps well-behaved agents honest: a process
running as the same user can still edit the files (see [Agent
credentials](agents.md#agent-credentials)).
