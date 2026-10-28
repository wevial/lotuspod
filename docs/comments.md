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

Eight routes sit behind the Access check of [Who is reading: Cloudflare
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
- An answer an agent recorded from elsewhere (`lotuspod comments
  record-answer`, see [Agents](agents.md)) is stored beside the reader's,
  and counts as theirs do. It carries `source`, where it was given, and its
  `actor` is the agent's, `{kind: "agent", handle, credential}`; only such
  an answer has `source`. `lotuspod answers PAGE` prints it "recorded by
  HANDLE at TIME, answered elsewhere: SOURCE" in place of "by EMAIL at
  TIME". A reader's answer replaces it as it replaces any.
- A reader in the `[access] owners` list (see [Who is reading: Cloudflare
  Access](operating.md#who-is-reading-cloudflare-access)) may dismiss a
  decision that no longer matters: `POST /api/answers` with `{page, question,
  version, dismissed: true, reason}`, `reason` 0 to 200 characters, stores a
  dismissal and answers 201 with it. A dismissal is an answer of its own,
  superseding the question's newest one: it carries `dismissed: true`, its
  `choice` is "", its kept label "Dismissed" and its `note` the reason; no
  other answer has `dismissed`. It counts as answered wherever answers do,
  and opens no thread. `{page, question, dismissed: false}` undoes the
  dismissal that is the question's current answer and answers 200 `{page,
  question, current, earlier}`, the question's entry as the GET below gives
  it, `current` null when no other answer is left. An undone dismissal keeps
  `undoneAt`, the time it was undone, and is listed among `earlier`, never
  current; a question whose only answers are undone dismissals is not
  answered. Each is refused with nothing stored, in this order: 403
  `not_owner` for a reader not in `owners`, 400 `invalid_body` for any other
  key set or length, 404 `unknown_page`, 409 `archived`, 400
  `unknown_question`, 409 `stale` for a dismissal's version other than the
  page's, 409 `already_dismissed` when the question's current answer is a
  dismissal at that version, and 409 `not_dismissed` for an undo when it is
  not a dismissal. `lotuspod answers PAGE` prints a dismissal "Dismissed
  (answer N ...)", its reason as "reason: TEXT", and ", undone at TIME" once
  it is undone.
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
- An answer saved with a note, on a page with a comment box after the
  decision's form, also stores the note as the reader's comment in a thread on
  that decision, so the page's owner can reply to it there. The comment's
  `text` is the note as written, its `question` the decision's id, and it
  carries `answer`, `{id, choice, label}` of the answer it came with; no other
  comment has the key. `POST /api/answers` then answers 201 with the comment as
  `comment` beside the answer, shaped as `POST /api/comments` answers a new
  thread. A later note to the same question is a reply in the newest thread a
  note opened, and reopens it if resolved; a thread opened with Ask never takes
  one. A note that is empty once trimmed, or is the note of the answer it
  replaces, opens nothing, and nor does a page with no such comment box or an
  answer an agent recorded.
- A new thread or reply may name up to 4 uploaded images as `images`, a list
  of their stored names in the order they are shown; a comment with images may
  have empty `text`. Every comment row carries `images`, each `{name, url,
  width, height}`, and `[]` when it has none.
- A new thread on a section, or on the whole page, may carry `spot` in place
  of `quote` or `widget`: a mark on one of the page's Mermaid diagrams or
  `/media/` images, `{id, hash, shape, nodes}`. Render gives each diagram and
  each image an id and a hash (`data-spot` and `data-spot-hash`): a diagram's
  id is the one its `mermaid id=NAME` fence names (see
  [Publishing](publishing.md)), else `SECTION-diagram-N`, N counted from 1 in
  its section (`diagram-N` before the first heading); an image's is the slug of
  its alt text, else `SECTION-figure-N`; an id another target already has takes
  `-2`, `-3` in page order. A diagram's hash is the first 12 hex digits of the
  SHA-256 of its source, an image's the first 12 of its stored name. `shape` is
  `{kind: "box", x, y, w, h}` or `{kind: "stroke", points: [[x, y], ...]}` (2 to
  256 points), and `nodes` up to 12 `{id, label}`, the flowchart boxes the mark
  covers. Coordinates are fractions of the box the covered nodes span when
  `nodes` is not empty, fractions of the whole diagram when a diagram's mark
  covers none, and an image's natural pixels; a mark on nodes is checked only
  for finite numbers, as the server cannot lay out Mermaid. After the checks
  above, a spot is refused, with nothing stored, in this order: 400
  `invalid_body` for any other key, a `hash` not 12 lowercase hex digits, a
  shape of another kind or keys, a coordinate that is not a finite number (a
  boolean is not one), a box whose `w` or `h` is not above 0, a stroke of fewer
  than 2 or more than 256 points, a mark on no nodes outside its drawing (beyond
  0 to 1, or 0 to the image's width and height), more than 12 nodes, a node id
  that is not letters, digits, `-` and `_`, or one listed twice, a label over
  100 characters or holding a control character, nodes on an image, and a spot
  beside a `quote` or a `widget`, on a reply or on a thread on a decision; 400
  `unknown_spot` for an id no target has, or a target in another section than
  the thread's; and 409 `stale_spot` for a hash the target has had in none of
  the page's visible publishes (kept beside the page in `NAME.targets.json`,
  which serve never answers) nor its versions in the site's git history. A hash
  it had earlier is stored as sent. The spot is stored with `title` added:
  the target's title as the page had it when the thread was posted (an
  image's alt text, a diagram's section heading, `""` before the first
  heading), so the thread can name its target once it is gone; a `title` in
  the body is refused 400 `invalid_body` like any other key. Every comment row
  carries `spot`: the anchor as stored on a thread's first comment (no `title`
  on one stored before titles were kept), `null` on every other.
- `GET /api/comments?page=NAME` answers `{page, revision, threads, unread,
  maxImageBytes}`: the page's current revision, each thread as `{root,
  replies, resolution}`, threads and replies oldest first, the ids of this
  reader's unread replies among them, oldest first (see [Replies to
  you](#replies-to-you)), and the largest image `POST /api/media` takes.
- `GET /api/events` opens an Access-verified server-sent-events stream, with
  `Content-Type: text/event-stream` and `Cache-Control: no-store`. It opens with
  `retry: 3000`; each `event: change` carries JSON data `{what, page}`. `what`
  is `comment` for stored threads, replies, claims, releases, failures,
  resolutions, reopens and follow-ups; `answer` for answers, dismissals and
  their undo; `publish` for a visible page's revision or archive change; or
  `index` for a rebuilt listing, with `page: null`. Other ticks name the page.
  An idle stream sends `: keepalive` every 30 seconds. At most 32 streams are
  open: another gets 503 `{"error": "too_many_streams"}` and `Retry-After: 60`.
  Each stream ends after 10 minutes so reconnecting verifies Access again;
  a stream 100 ticks behind is ended too. Only GET is allowed (405 with
  `Allow: GET` otherwise). Seen writes do not send ticks.
- `GET /api/revision?page=NAME` answers `{revision}`, the page's current
  revision alone; it is only read (any other method is 405).
- `POST /api/seen` with `{page, revision}` records that the reader opened
  `page` at `revision`, the revision it was rendered at, and answers 200
  `{page, revision, previous}`. A page with no revision (rendered, never
  published), whose `revision` in the GET below is `""`, is opened at `""`, as
  the index's tabs record it; any other page refuses `""`. `previous` is the
  revision recorded for this reader before, or null the first time. One row
  is kept per reader and page,
  keyed by the address Access verified (never the shown name), so it holds on
  every device the reader uses.
- `POST /api/seen` with `{page, thread, comment}` records that the reader has
  seen the thread whose first comment is `thread` up to the comment id
  `comment`, and answers 200 `{thread, comment}` with the mark as stored: one
  row per reader and thread, whose mark never goes down, so a lower `comment`
  leaves it as it was, and never passes the thread's newest comment, so a
  higher one is stored as that. A `thread` that is not the id of a thread's first
  comment on `page` is 404 `unknown_thread`.
- `GET /api/seen`, with no query, answers `{pages: {NAME: {revision, seen,
  seenAt, replies, unread}}}`: one entry for each page this reader has a row
  for, or has unread replies on, that serve still answers, `revision` the
  page's current one, `seen` the one last recorded and `seenAt` the time it
  was (both null for a page never opened), `replies` the count of the page's
  comments stored after `seenAt` whose author is not this reader, an agent's
  reply included (0 for a page never opened), and `unread` the count of
  their unread replies on it. A page since hidden or removed drops out. It
  never names a reader.
- `GET /api/versions?page=NAME` answers `{page, versions}`: each commit of
  the artifacts repository that changed the page while it was visible (a
  merge by what it changed), as
  `{commit, date, revision, current, summary}`, newest first and at most
  200, `date` its committer time in UTC, `current` true on the newest only
  and `summary` what it changed from the page before it in one line (as
  `/api/activity` words it, below), shown as the entry's note in the
  versions view (see [Versions](publishing.md#versions)). It is empty when
  the output directory is not the top of its own repository, and only read
  (any other method is 405).
- `GET /api/changes?page=NAME&since=REV` compares the newest listed version
  of the page whose revision is REV with the current one, and answers
  `{page, since: {commit, date, revision}, behind, changed, sections}`:
  `behind` is how many listed versions are newer, and `changed` is false,
  with nothing else compared, when REV is the current revision. `sections`
  is `{changed: [{id, title}], added: [{id, title}], removed: [{title}]}`,
  the first two in the current page's order. When both versions kept
  `NAME.md` it also answers `lines`, a unified diff of the two sources with
  three lines of context, each `{op, text}` with `op` one of `+`, `-`, a
  space or `@` (a hunk's header), at most 400, and `truncated`, true when
  the diff was cut (see [Versions](publishing.md#versions)). It is 404
  `unknown_revision` when no listed version carries REV, which includes
  every page outside a repository, 400 `invalid_query` without exactly one
  `page` and one `since` of 1 to 100 characters, and only read (any other
  method is 405).
- `GET /api/activity` answers the reader's recent activity on every page
  serve answers: the 7 days up to `before`, an optional ISO 8601 UTC time
  (`2026-10-07T12:00:00Z`), else now. It answers `{from, to, older,
  truncated, pages}`: `from` and `to` the window's bounds, UTC to the
  millisecond; `pages` one `{page, title, latest, events}` for each page
  with an event after `from` and up to `to`, ordered by `latest`, its newest
  event's time, newest first, and its `events` newest first. At most 500
  events are kept, the newest, and `truncated` is true when any were left
  out, or when the repository lacks the version before one, as a shallow
  clone does (that version then has `first: false` and `summary` "");
  `older` is true when anything the reader may see happened up to `from`, so asking again with `before` set to `from` reads the 7 days
  before. A hidden or removed page never appears. Each event is one of:
  - `{kind: "version", at, commit, revision, current, actor, first, summary}`, a
    commit of the artifacts repository that changed the page while it was
    visible, read from git in at most two processes, the served pages'
    whole history up to `to` read so the version before each is known:
    `current` true when its revision is the revision of the page as serve
    answers it now, else false, `actor` the handle the
    version's `lotuspod:owner` names, or null, and `first` true when the page
    had no visible version before it. `summary` compares its sections with
    the visible version before it, as `/api/changes` does: "Alpha and Beta changed;
    Delta added; Gamma removed", each part naming at most three sections and
    then "and N more", a part left out when empty, "new version" when no
    section changed, and "" on a first version. A commit whose
    `lotuspod:revision` is that of the visible version before it, as a page
    hidden and shown again unchanged, is not an event; a merge is one when
    it changed the page; outside a repository there are none;
  - `{kind: "comment", at, id, thread, section, sectionTitle, question?,
    actor, mine}`, a thread's first comment, with `question` on a thread on
    a decision;
  - `{kind: "reply", at, id, thread, sectionTitle, actor, mine, yours,
    unread}`, `yours` true when the thread is the reader's and `unread` as
    [Replies to you](#replies-to-you) counts it;
  - `{kind: "answer", at, question, questionText, label, actor, mine}`, with
    the question's text and the choice's label as the page asked them.

  `mine` is true on what the reader wrote, and every actor is shown as on
  the other routes, never with an address. A `before` that is not such a
  time, or any other query key, is 400 `invalid_query`; it is only read
  (any other method is 405). An archived page (see [Archive a
  page](publishing.md#archive-a-page)) has no event here, its versions
  included.
- `GET /api/archive?page=NAME` answers `{page, archived, supersededBy,
  mayArchive}`: `archived` the time the page was archived or null,
  `supersededBy` the page that replaces it or null, and `mayArchive` whether
  the reader is one of the `owners` of the `[access]` section (see [Who is
  reading](operating.md#who-is-reading-cloudflare-access)). `POST
  /api/archive` with `{page, archived: true|false[, supersededBy]}` archives
  or unarchives the page as `lotuspod archive` does, record, manifest, index
  and commit included, and answers 200 in the same shape. Beside every POST's
  refusals, it is 403 `not_owner` for a reader who is not an owner, 400
  `invalid_body` for a body not of that shape (a `supersededBy` with
  `archived` false included), 404 `unknown_page`, and 400
  `unknown_successor` for a `supersededBy` serve does not answer, or the
  page itself; none writes anything. When the push fails, the commit is
  still made and the route still answers 200; the next publish pushes it.

An open page notices when it is published again: every published page
carries a revision, so it loads the page script, `lotuspod-page.js`, even
with no comments, decisions or sections. It compares the
`lotuspod:revision` it was rendered at with the revision each read of its
threads carries, and asks `/api/revision` at once when serve's stream
(`/api/events`) says the page was published again, at once when its tab is
seen again, and every 60 seconds as the fallback for a stream refused,
dropped or blocked. Each browser tab holds one stream: a page opened on its
own, or the index for every pod open in its tabs. A tick that the page's
comments or answers changed reads its threads at once too (once the tab is
seen again, when it is hidden), and one that a page was published or
commented on, or the listing rebuilt, has the index read its marks and its
tabs' dots again. A dropped stream is opened again, after 2 seconds doubling
up to a minute when serve refused it, and once open again the page runs both
checks, since it may have missed a tick. Once a revision it learns is not
its own, the page first fetches it and swaps in only the parts whose digests (see
[Publishing](publishing.md)) changed: the header's text, the outline's links,
the intro, and each changed, added or removed section. Everything else stays
as it was, the scroll position and the folded sections with it; a swapped
section stays folded if the one it replaces was, and an added one starts open
unless the reader folded it before. The page then shows the new revision
without a reload, and a later publish is noticed the same way. A line in the
banner's place, which moves no text and is announced politely, says "Page
updated · 2 sections changed" (the intro counting as a section; just "Page
updated" when only the header or outline changed) and goes after 6 seconds;
each changed or added section is tinted for 2 seconds (without the fade when
the reader asks for reduced motion), and a folded one says "changed" on its
heading until it is opened. The first section heading below the title bar
stays where it was in the window. A changed or removed section, or the intro,
holding the focus is held back: it keeps its old text under a bar reading
"This section changed" (or "This section was removed") with an Update button,
which swaps it in and moves the focus to its heading, while the rest of the
page swaps; it stays held until then, and a later publish that brings back
its text takes the bar away. A page with comments updates in place too: a
swapped section's comment box keeps its threads, its chip and its group in
the comments panel, a thread open in the panel, a popover or the bottom sheet
stays open, and a comment or reply not yet sent stays in its composer, text
and images. A section's form opened from a live block's Comment stays on the
block while the block is still in that section: when the new revision changed
the block's widget file, the form keeps its text, images and "On" line, stays
on the version of the block the reader saw and says "This block was updated
since you started. Your comment stays on the version you saw." The route takes
a thread on a hash the block had in an earlier version of the page (kept at
each visible publish in `NAME.blocks.json` beside the page, so a site without
git history takes it too), and the
thread says "Widget changed since this comment" as one written before the
change does; a block the new revision took away or moved to another
section leaves the form a comment on its section. Threads on a section the new revision removed or renamed are
listed under "Sections that have changed", as a fresh load lists them, and
an added section gets its own group. Decision forms update in place too: a
swapped section's forms are drawn from the stored answers as a reload draws
them, folded to a saved answer or open with "Answered to an earlier wording"
for a reworded question, each with its Ask (and Dismiss, for an owner) and its
decision chip, and the Answered table is drawn again after the last section.
A section holding a form whose answer was changed and not saved, or is still
being saved, is held back under "This section changed" with Update, so the
answer is never lost. The passage threads of a swapped part are found again
in its new text from their quotes, highlighted and numbered in page order as
on a fresh load; one whose words are gone keeps its entry, its quote struck
through, the note's title naming the revision it changed in. A changed or
removed part holding the words an open passage comment is on, and a removed
section whose form for a new thread holds text or images not sent, is held
back with the bar too. Its Update opens the passage comment again on its
words, text and images, where the new text still has them; else what was
written goes to a form for a new thread, saying why, as after a reload
(below), with any image still uploading, which joins it once uploaded; a
form sending a comment takes it once that comment is saved. It does not swap, and shows the banner as below, when the theme or
the page's policy changed, when a changed part, as it was or as it is now,
holds a diagram, a reference card or a table, or when it holds a decision
form while the page shows the review sheet (a page that loaded with decision
forms) or the page loaded with neither a decision form nor a comment box; nor
when the outline or the sections came or went, the sections both copies have
moved, or the references changed. A swap that fails partway reloads the
page. Otherwise a
banner fixed over the top of the
window, which moves no text and is announced politely, reads "A newer version
of this page is available" with a Reload button. Reload brings the new
revision back at the same place in its text, with the comments thread that was
open open again and any comment or reply not yet sent back in its composer,
its text and its uploaded images (kept per page in sessionStorage; where the
browser keeps nothing, the page still reloads, at its top). Reload waits for
an image still uploading in a composer, its button greyed out, and keeps it
with its text once uploaded (one the site refuses is not kept, as without a
reload). A draft from a section held back as removed goes where Update would
put it: to the section in the place the removed one had when the swap took
it away. A reload of the
page by the browser in the same tab (its reload button, or a mobile browser
reloading a tab it put away) brings them back the same way: the page keeps
them as it is left, and while its tab is hidden, and lets them go once the
tab is shown again. A comment begun from a live block's Comment opens again
on that block, under its "On" line, in the form of the section the block is
in now, still on the version of the block the reader saw (saying so, as
after a swap, should the block have changed); where the page no longer has
the block, it goes to its section's form, saying "The block you were
commenting on was removed. Your comment is kept here, on the section."
Comments a republish puts in one section's form, from two blocks or from a
block and the section itself, are kept there on no block, saying where the
reader was writing has changed. A
comment
written where the new revision has no place for it, on a section renamed or
removed or on words that changed, opens in a form for a new thread on its
section, else on the section in the same place, else on the first, saying
why. A page that notices while its tab is hidden, with no unsent text or
image in a composer, reloads itself the same way, so it is current when the
reader comes back; with one, or an image still uploading, it waits, the
banner showing.

Once per load, an open page with a `lotuspod:revision` posts it to
`/api/seen`, and posts each revision a swap brings in the same way, unless it
is framed in an index tab not shown: that tab keeps its "new version" dot
until the reader opens it. A signed-out reader's 401, or any failure, shows
nothing. The
index reads `/api/seen` to mark the pages republished since the reader last
opened them, and its tabs to mark the open pods republished or commented on
since (see [Index](publishing.md#index)). Agents are not readers: the
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
`version` or `choice` outside 1 to 100 characters, a `resolved` that is not a boolean, a `section` that is not a string (any
heading id's length is taken, since it must name one of the page's boxes;
`""` is the whole page), a `quote` on a thread on the whole page,
`text` outside 1 to 4000, `note` over 4000, a quote whose `exact` is outside 1 to 500 or
whose `prefix` or `suffix` is over 32 (code points, as Python counts them), a new
thread's `revision` that is not a string of at most 100 characters, a seen
`revision` that is not a string of 1 to 100 (or `""` on a page with no
revision), a seen `thread` or `comment`
that is not a positive integer, and any
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
as is a thread on the whole page (`section` `""`) on a page with no comment
boxes or whose only box is `page`, and a `revision` other than the page's current one is 409 `stale_page`, so a
quote is never stored against a revision its words were not taken from.
Without a `revision` (a page rendered with none), a new thread is taken as is.
A thread on a decision is checked in this order: 404 `unknown_page`, 400
`unknown_question` for a `question` the page does not ask, 400
`unknown_section` when the page has no comment box after the decision's form
(a page rendered without comments), and 409 `stale_page` for a `revision`
other than the page's. Its body with a `section` or a `quote` beside
`question` is 400 `invalid_body`.
A page that is archived (see [Archive a page](publishing.md#archive-a-page))
takes no new thread, reply, thread on a decision or answer: once the page is
found, each is 409 `archived`, and nothing is stored. Resolving and reopening
its threads, seen marks and every read answer as on any page.

### Replies to you

A thread is the reader's when they wrote its first comment or any reply in
it, as the reader Access verified. In such a thread, a comment is unread for
them when someone else wrote it, an agent or another reader, and its id is
greater than both their own newest comment in the thread and their seen
mark for it: their own reply reads everything before it, and a resolved
thread still counts. Each reader has their own marks, kept by address, so
they hold on every device. Unread new threads the reader is not part of, and
unread answers, are not counted. Agents have no marks; the agents' socket,
its pulls and its threads are unchanged. When the schema step that keeps the
marks runs, every thread is marked seen up to its newest comment for each
reader in it, so no reply stored before it counts.

On the page, each unread reply is marked: a "New" tag before its byline, a
lavender edge on its bubble, and the line "New since you last looked" above
the first in its thread. A section's chip, and a decision's, ends in how many
of its threads' replies are unread ("1 new"); the header's date line ends in
a badge, "N new replies to you" ("1 new reply to you"); and the tab's title
reads "(N) TITLE · Lotuspod". When a thread opens, in the side panel, a
popover or the bottom sheet, the page posts the thread's newest comment id
to `/api/seen`: any replies unread as it opened stay marked while it stays
open and are no longer marked the next time it opens. The counts are drawn
again after each read of the threads and each post. On the index,
each page with unread replies gets a count beside its title ("2 new
replies"), the index's tab title reads "(T) Lotuspod" for their total T, and
an "Unread · N" toggle, after the Updated one (see
[Index](publishing.md#index)), keeps only those pages, with the token
"unread ✕" on the "Showing" line; the Labels menu, Updated and the search
still apply on top. When the routes answer no `unread`, or
`/api/seen` anything but 200 (signed out, or the demo site, whose stand-in
keeps every reader's data in one browser), nothing is marked or counted and
there is no Unread toggle.

## Comments

A remark about one part of a page belongs next to it. `publish` ends every h2
section of a page with a comment box, and `render --comments` does the same
(off by default for `render`; `publish --no-comments` turns it off). A section
runs from its heading to the next h2 or the end of the body; a body with fewer
than two h2 sections gets one box, for the whole page, at its end. A page
with section boxes takes threads on the whole page too: the page is served
with a box for it after its date line (below). The pass
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
read without the script keeps the plain box.

A page with section boxes is also served with a box for the whole page in
the page's header, right after its date line: a box with `data-section=""`,
its field named "Comment on this page", and
first among the page's boxes. Its chip reads "No comments · Comment on this
page" while it has no thread. Its threads are stored with `section` `""`
(`lotuspod.features.comments.comments.WHOLE_PAGE`), which no heading's id can
be, and `sectionTitle` `""`, and carry text and images only: never a quote or a
decision. They are routed, pulled, claimed, answered, resolved and counted
unread as any thread, and an agent reads them as "the whole page". A page
whose only box is `page` has no other: its box already covers the whole page.
A thread on that one `page` box shows in the whole page's box once the page
has sections, and a `""` thread shows in the `page` box once it has one
section; either is still stored on the section it was written on.
To start one, `POST /api/comments` with `{page, section: "", text}`. A thread whose section the page
no longer has is listed at the end of the body under "Comments on sections
that have changed" (in the panel, where there is one). Every author and text
is set as text, never as markup.

A bubble draws its text as a small markdown subset, a reader's comment and an
agent's reply alike (the page script's
`features/comments/ts/comment-markdown.js`, which builds every node itself and
sets every text as text, so raw HTML and entities show as typed):

- A blank line separates paragraphs; a single newline inside one stays a line
  break.
- `**bold**` is bold and `*italic*` is italic. `_` is always literal, so
  `snake_case` names survive, and a `*` with a space after it opens nothing.
- `` `code` `` is inline code, its contents literal, markdown included. A line
  of three backticks opens a code block and the next such line closes it; an
  unclosed block runs to the end.
- Lines starting `- ` or `* ` make a bullet list, and lines starting `1. ` a
  numbered one. Lists are one level deep: an indented item is an item.
- `[TEXT](TARGET)` is a link, its text plain, only when TARGET is `http:` or
  `https:` (any case), a `#anchor`, or a relative path (no `//` start, no
  `:` before its first `/`, `?` or `#`), as for a page's own links. Any other
  target (`javascript:`, `data:`, `mailto:`, `//host/`) leaves the whole link
  as typed.
- A bare `http://` or `https://` URL is a link to itself, by the same rules
  as a page's bare URLs (see "From markdown" in
  [publishing.md](publishing.md#from-markdown)): trailing punctuation and an
  unpaired closing bracket stay text after it. One in a code span, a code
  block, an image or a link, refused or not, is not linked again.
- A link to the page's own site (a relative path, an `#anchor` or an
  absolute URL on the same origin) opens in the same tab; any other opens in
  a new tab with `rel="noopener noreferrer"`.
- A run of lines starting `|` whose second line is a separator row (each
  cell dashes, with an optional `:` at either end, ignored) is a table, as on
  a page: the first row is its header, every other separator row is skipped,
  and each cell is drawn as inline markup. A row short of the header's cells
  gets empty ones; extra cells are dropped. A wide table scrolls inside its
  bubble. Without the separator row the whole run of `|` lines is paragraph
  text.
- Anything else (headings, quotes, images, HTML) is literal text.

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
every thread under the text of its section's heading, in page order (threads
on the whole page first, under "This page"), with
threads on sections the page no longer has last under "Sections that have
changed". A section thread's entry is marked "§" and shows its first
comment's opening words, its status ("✓ Answered", "HANDLE is writing",
"Waiting for HANDLE", "HANDLE couldn't answer") and its reply count. One entry
is open at a time and holds the whole thread as a box would, with a "Resolve"
control; opening one scrolls the page to its section's chip, opening the
section first if it is folded. A group draws no control of its own for a
new thread: the panel starts one from above its groups. "Comment on this
page", on a page with a box for the whole page, unfolds that box's own form
in the "This page" group; "Comment on a section" lists "This page" first on
such a page, then each section in page order, and unfolds the chosen box's
form in its group. On an archived page both are disabled. An open form has a
"Cancel", and Escape in it does the same: the form folds, keeping what was
typed and attached, the group is unlisted if it holds no threads, and the
focus goes back to the button that started it; nothing is posted. In any
comment composer (a box's form, a reply, a passage's), Cmd+Enter (Ctrl+Enter
off macOS) sends as its button does, and does nothing while it saves; Enter
alone adds a line. A composer also takes emoji shortcodes as GitHub writes
them (`comments/shortcodes.ts` and `comments/shortcode-list.tsx`
under the islands): a typed (never pasted) `:tada:` becomes 🎉 in the field,
so the stored text holds the emoji, and an unknown name such as `:nope:`
stays as typed. A shortcode starts at the start of the field or after
whitespace, `(`, `[`, `{`, `"` or `'`, so `10:30:45` and `http://x` are left
alone. Two or more characters after its colon open a listbox under the field
(above it without room below) of at most 8 matches, those starting with what
was typed first, each as `🎉 :tada:`, the first active; Arrow Down and Arrow
Up move the active one, Enter, Tab or a click inserts its emoji, and Escape
closes the list alone, keeping the composer open. The field names the list
(`aria-controls`, `aria-autocomplete`, `aria-activedescendant`) while it is
open. The table of shortcodes is the served theme file `lotuspod-emoji.json`,
fetched at the theme address once per page on the first colon typed in any
composer. The page remembers whether the
reader left the panel open or folded in `localStorage` (a page whose storage
throws starts folded), and Escape elsewhere in it folds it.

On a page that asks questions (one with decision or checklist forms that is
not archived, and whose answers could be read), the panel's head is two tabs
in place of its "Comments" heading: "Decisions", with the number of questions to answer (an orchid
badge, a mint "✓" once there are none), and "Comments", with the number of
open threads the rail's badge counts. The tab shown is underlined in
lavender; Left and Right Arrow move between them. The Comments tab holds
"N open · M resolved", the ways to start a thread and the groups, as above.
The Decisions tab lists every question with no saved answer (see [The review
sheet](publishing.md#the-review-sheet)), in page order, under one heading per
section as the Comments tab heads its groups (a question about a live block
under the block's title, right after its section's). Each is answered in
place: its number and question, which scroll its card just under the title
bar and focus its first option as Next open does; its card's context lines;
its options as radios with the card's labels and "· default" mark (a
checklist's items as checkboxes); "Add a note"; Save; "not saved" while the
card's pick or note differs from its saved answer; and "Show on page", which
does as the question does. The entry and its card are one state: a pick or a
note in either shows in both, and typing a note in the panel opens the
card's. Save posts the card's answer with its note, as "Save answer" does,
in the card's turn; saved, the card folds, the entry reads "✓ Saved · LABEL"
for a moment and then moves to the Answered list, and a section's heading
goes with its last question. A refused save keeps the entry and its "not
saved", and the card's status says why. With none left the tab reads
"Nothing left to answer". Each entry's foot also holds "Ask", which opens a
field of its own under it, named "Ask about decision N" (N the question's
number, else its text), with "Ask" and "Cancel": Ask posts the field's text
as a question thread on the decision, as the card's Ask posts the note (see
[Decisions for the
maintainer](publishing.md#decisions-for-the-maintainer)), and the panel
stays on Decisions. Sent, the field empties and closes, and the note, in the
panel and on the card, is left as it was; an empty field reads "Write your
question first." and posts nothing, a refused post keeps the text and says
why, and text changed while the question was sending stays, unsent. The
entry's "Ask" folds the field and keeps its text, and Cancel empties it. A
question saved while its field holds an unsent question still moves to the
Answered list. An Answered row has no Ask: opened, it shows that question,
read only, as "Your question, not sent:", with how a send still pending went,
and the collapsed row holds only its title, answer and "change". The field
and its text are kept by question, so a section a new revision swaps in keeps
them. An entry whose question has open threads ends in "?", "1 thread"
(or "N threads") and where the newest stands as its chip reads it
("answered", "writing", "waiting" or "failed"); pressing it opens the
Comments tab at that thread, as the decision's chip does.

After the questions to answer, a folded "Answered · N" list holds every
question with a saved answer that is not a dismissal (a dismissed question
is in neither list: its card and the Answered table show it), under the same
section headings in page order. It stays folded or open as the reader left
it. Each row reads the question's number and text, its answer's label, who
saved it and when as its card says, and "change". Its text or "change" opens
it in place: the card's context lines, its options with the card's pick, its
note under "Edit note", Save, Cancel (held back while Save is under way),
"not saved" while the card differs from its answer, and "Show on
page". A pick or a note there opens the card on the page as its "change"
does, showing "Not saved". Save posts the answer as the entry's Save does
and collapses the row to the new answer; Cancel puts the saved pick and note
back, folds the card to its answer again and collapses the row.
Folded, such a page's rail holds an orchid button above the thread dots, the
count over "to answer" set sideways (a mint "✓" over "answered" at none),
named "N to answer: open the questions"; it opens the panel on Decisions.
The title bar's "N to answer" (see [The review
sheet](publishing.md#the-review-sheet)) opens the panel on Decisions too,
unfolding it, with the focus on the first question to answer (on the tab
when none is left), and names the tab's panel in its `aria-controls`.
The rail's "Comments" button, a chip, a highlighted passage, a block's pin
and every other way to a thread open it on Comments; the panel opens on
Decisions when nothing chose a tab. Only the Comments tab shows the threads,
so a thread counts as seen only while it does.

A page with decision or checklist forms and no comment boxes (published
without comments) still gets the panel, for its questions: its head is the
Decisions tab alone, with no Comments tab, no way to start a thread, and a
rail with only the orchid "N to answer". It shows once the page's answers
are read; an archived page, or one whose answers could not be read, gets
none, and nor does a page with neither forms nor comment boxes.

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
Comment" ("No comments · Comment on this page" on the whole page's); when the newest reader comment among them is `claimed`, "HANDLE is
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
`features/comments/ts/narrow.js` and `features/comments/theme/narrow.css`.

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

On a page that asks questions the sheet's header is two tabs, "Decisions"
and "Comments", each with its count as the panel's tabs show them, and
"Close"; the arrows and the thread's status sit in a row under them, on the
Comments tab. The title bar's "N to answer" opens the sheet on Decisions,
at any width without room for the panel, with the focus on the first
question to answer, and a chip, a highlight or a pin on a phone opens it on
Comments (from 700 pixels they open popovers, as above). The Decisions tab
holds the panel's Decisions tab, its nodes moved into the sheet and back as
a thread's are, so a pick, a note, Save, Ask and the Answered list work
there as in the panel; a question's text and its "Show on page" close the
sheet before they scroll to the card. Pressing "Comments" goes back to the
thread the sheet held before, else to the first open thread, else to the
first section's form; pressing "Decisions" keeps a passage's composer for
it. On a page that takes no comments the sheet has the Decisions tab alone.
The tabs are drawn by `features/comments/ts/narrow.js`, styled by
`features/comments/theme/sheet-tabs.css`.

### Comments on a spot

A comment can be on one spot of a Mermaid diagram or of a figure's image: a
box round a few flowchart boxes, or a stroke under something. On a page that
takes new comments in the diagram's or figure's section (not an archived
page, nor an old version, which runs no page script), each diagram Mermaid has
drawn has a "Comment" button beside its Expand, in a band above the drawing
(and the diagram is kept short of the comments panel, as a table is), and each
figure one at its top right corner. A page published with `--no-comments` has
none. "Comment" opens mark mode: "Box" (pressed first), "Stroke" and
"Cancel" take its place, and the drawing shows a crosshair. A drag draws a
box, or with "Stroke" a line through the points dragged over (thinned evenly
to at most 256); a press that moves under 6 px on a flowchart box marks that
box with a box 8 px larger on each side, and opens no node card. Tab goes
through the diagram's boxes and Enter marks the one focused. The mark is
drawn dashed, and the composer opens under it: "Comment", or Cmd+Enter
(Ctrl+Enter elsewhere), posts; its "Cancel", or Escape, takes the draft away
and stays in mark mode; Escape with no draft, or the bar's "Cancel", leaves
mark mode with the focus back on "Comment". In mark mode the crosshair holds over the whole drawing, posted marks
too. Outside mark mode a drag on a
drawing draws nothing.

The post is a new thread on the target's section with `spot` (see the
comments route above): the target's `data-spot` and `data-spot-hash`; on a
diagram, the boxes the mark covers (a box is covered when at least half the
smaller area, its own or the mark's bounding box, overlaps), at most the 12 it
covers most, each with its id and its label as drawn, and the shape in
fractions of the rectangle those boxes span, or of the diagram's own viewBox
when it covers none; on an image, the shape in the image's natural pixels and
no boxes. An image's composer attaches a PNG crop of the spot at natural
size, uploaded as any attached image is, and posts it as its first image.
Each send reads the composer's images as they then are: with the crop not
among them, known by the name the site stores it under, the SHA-256 of its
bytes (its upload refused or failed, or the reader took it out; another PNG
of the same size does not stand for it), the crop is made and attached again,
and should that fail too,
nothing is posted, the text stays and the composer says "The crop of the
marked spot was not attached. Press Comment to try again." Refused with 409
`stale_spot` or 400 `unknown_spot`, the composer keeps its text and says "This
diagram has changed since the page loaded. Reload the page to comment on its
new version." ("This image has changed ..." on an image). While a draft is
open, a swap holds back the part it is in. Its Update keeps the composer and
its text: the draft is drawn again where its boxes now are on the diagram
swapped in, and posts on it; with one of its boxes gone, no draft is drawn and
the composer stays on the version it was drawn on, as an image draft does
when the swap brings in other pixels, its crop being of the old ones. A send
cancelled while it waits for the crop posts nothing. A draft with text or
images holds back a hidden page's reload, as a section's form does, and a
reload takes its text, and the images the reader attached, to its section's
form, saying why. A box is posted with its
edges rounded, so one reaching the image's edge stays within it.

Each unresolved spot thread is placed again each time the page draws its
target: on load, when a swap brings it in and when Mermaid draws it again in
the other theme. On the target as it was (the same hash), its mark is drawn
solid rose; on a changed target whose covered boxes are all drawn (or a mark
on none), dashed where those boxes now put it, its first comment followed by
"Diagram changed since this comment" ("Image changed since this comment").
When the target or one of its boxes is gone, nothing is drawn, nothing is
guessed, and the thread is listed under "Sections that have changed", headed
"On" and its boxes' labels joined by ", " as they were stored with the
comment, so a reload names them too (else the target's title as the page
shows it, else the title stored with the spot when the thread was posted,
so every browser names a removed or renamed image by its alt text, else
the title as the page last showed it, which the browser keeps per page in
localStorage, else the title of the section the thread was posted in). Marks are
drawn in the drawing's own coordinates, each with its number at its first
corner: spot threads are numbered with the passages, in page order, and those
drawn nowhere after them. Pointing at a mark lights it and its entry in the
panel, and pointing at the entry lights the mark; clicking a mark opens its
thread. A resolved spot thread draws no mark.

Where comments use the bottom sheet (a phone), "Comment" opens the diagram
view or the image viewer with mark mode on and "Box" pressed, its bar in a
band under the view's bar or above the image, instead of marking on the page,
where a finger would hold the page still and the drawing is small to aim at.
In the diagram view the diagram's own svg, marks included, is what the view
moves and zooms; in the image viewer the marks are drawn in an svg over its
image in natural pixels. One finger draws (or a tap marks a box), two fingers
pan and pinch the diagram view as at any time and draw nothing, and the
composer opens in the view under the mark, following it as the view moves.
Posting closes the view and opens the new thread in the bottom sheet. Escape
in the view, the composer's "Cancel" or the bar's "Cancel" leaves mark mode,
a draft with it, with the view open, and Escape again closes it, as at any
time, the focus back on the diagram's Expand or the figure's "Comment". While
the view is in mark mode a swap holds back the part the target is in, a
diagram drawn again in the other theme keeps its draft, and the image viewer
opens no attached image over the one being marked. Outside mark mode a swipe over a diagram or a
figure on the page scrolls the page: only a target in mark mode takes the
touch to itself.

The keyboard marks an image too. In mark mode Tab reaches the image's mark
surface after the bar; there Enter drops a box a quarter of the image's width
and height at its centre, drawn dashed, the arrow keys move it by a twentieth
of the image's width or height, and Shift with an arrow grows or shrinks its
width or height by as much (never past the image, nor under a twentieth).
Enter then opens the composer under it, and Cmd+Enter (Ctrl+Enter elsewhere)
posts, as for a node. Escape takes the box away and stays in mark mode.

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

A composer refused for a change to the page says so in words and keeps its
text and images: 409 `stale_page` and 400 `unknown_section` say "This page has
changed since it loaded. Reload it to comment." on a section's form (the
passage line above on a passage composer); 409 `stale_widget` and 400
`unknown_widget`, on a form on a live block (a hash the block never had, or a
block the page no longer has there), say "This block has changed
since the page loaded. Reload the page to comment on its new version.", the
form staying on the block; and 409 `archived` says "Comments are closed: this
page is archived." Any other refusal says "Not saved (CODE). Try again."

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
- A reply (any comment after a thread's first) with no mention is routed to
  the handle of the latest agent reply before it in its thread, while that
  handle is listening; when it is not listening, or no agent has replied
  before it, the reply is routed to `responder` as below. Listening is read
  when the reply is routed, so one whose agent stops listening before
  claiming it goes to `responder` again. A thread's first comment never
  routes this way.
- Any other comment with no mention is routed to `responder`, on a page with an
  owner too, whether or not the owner is listening. The responder answers
  what the page and its thread can answer, and puts what asks the owner to
  act in the owner's inbox (see [The owner
  inbox](agents.md#the-owner-inbox)), replying "I've queued this for
  OWNER: …".
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
