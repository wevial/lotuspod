// The demo site's stand-in for `lotuspod serve`'s /api routes. The demo build
// copies this file to lotuspod-demo.js and loads it in each page's head,
// before the page script, which never knows it is there; the package never
// ships or serves it.
//
// It replaces window.fetch. A same-origin request whose path starts with
// /api/ is answered here, from this browser's localStorage, in the shapes
// and status codes lotuspod.api answers; every other request goes to the
// browser's own fetch unchanged. Nothing written here leaves the browser.
//
// The visitor is the reader `you`. A comment they write waits for the agent
// `demo-agent`, and once it has waited REPLY_AFTER ms, the next read of the
// threads (the page script reads them again while a thread waits) adds
// demo-agent's scripted reply: the text REPLIES holds for the page and the
// section, else its "*" text. A saved decision answer adds a scripted line
// from demo-agent to the thread of its form's section. Image uploads are
// refused.
//
// Everything is kept under keys starting KEY, the page script's own
// "lotuspod:" keys left alone, and kept until the banner's "Reset demo"
// button removes every KEY key and reloads the page.
(function () {
  "use strict";

  var KEY = "lotuspod-demo:";
  var NEXT_ID = KEY + "next-id";
  var THREADS = KEY + "threads:";
  var ANSWERS = KEY + "answers:";
  var AGENT = "demo-agent";
  var MODEL = "scripted";
  var READER = { kind: "human", name: "you" };
  var AGENT_ACTOR = { kind: "agent", handle: AGENT, credential: AGENT };
  var REPLY_AFTER = 3000;
  var MAX_TEXT = 4000;
  // The largest image the comments route says it takes; none is ever taken.
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  var NO_UPLOADS = "image uploading is disabled for the demo";
  var UNRESOLVED = { resolved: false, actor: null, at: null };
  // demo/replies.json: page names to section ids to a reply, and "*".
  var REPLIES = {/* demo/replies.json, put here by the build */};

  var original = window.fetch;

  function Refusal(status, error) {
    this.status = status;
    this.error = error;
  }

  function invalid() {
    return new Refusal(400, "invalid_body");
  }

  function load(key, empty) {
    var text = window.localStorage.getItem(key);
    return text === null ? empty : JSON.parse(text);
  }

  function save(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  }

  function nextId() {
    var id = Number(load(NEXT_ID, 0)) + 1;
    save(NEXT_ID, id);
    return id;
  }

  function now() {
    return new Date().toISOString();
  }

  // The page's own revision (lotuspod:revision), which every answer names.
  function revision() {
    var stamp = document.querySelector('meta[name="lotuspod:revision"]');
    return stamp ? stamp.content.trim() : "";
  }

  // Whether the page has a comment box on section.
  function hasBox(section) {
    return Array.prototype.some.call(document.querySelectorAll("details.artifact-comment"),
      function (box) { return box.dataset.section === section; });
  }

  // A section's title: its heading's text.
  function sectionTitle(section) {
    var heading = document.getElementById(section);
    return heading ? heading.textContent.trim() : "";
  }

  function decisionForm(question) {
    return Array.prototype.filter.call(document.querySelectorAll("form.artifact-decision"),
      function (form) { return form.dataset.question === question; })[0] || null;
  }

  function text(value, low, high) {
    if (typeof value !== "string" || value.length < low || value.length > high) {
      throw invalid();
    }
    return value;
  }

  function id(value) {
    if (typeof value !== "number" || Math.floor(value) !== value || value < 1) {
      throw invalid();
    }
    return value;
  }

  function own(object, name) {
    return Object.prototype.hasOwnProperty.call(object, name);
  }

  // Each page's comments are {rows, resolutions}: rows oldest first, and
  // each thread's resolution by its first comment's id.
  function comments(page) {
    var stored = load(THREADS + page, null);
    return stored || { rows: [], resolutions: {} };
  }

  function row(page, fields) {
    var section = fields.section;
    var made = {
      id: nextId(),
      page: page,
      section: section,
      revision: fields.revision,
      parent: fields.parent,
      text: fields.text,
      quote: fields.quote || null,
      images: [],
      actor: fields.actor,
      createdAt: now(),
      state: fields.state,
    };
    if (fields.model) {
      made.model = fields.model;
    }
    return made;
  }

  // A reader's comment, waiting for demo-agent.
  function readerRow(page, fields) {
    fields.actor = READER;
    fields.revision = revision();
    fields.state = "pending";
    return row(page, fields);
  }

  // demo-agent's scripted comment. Like an agent's reply, it names no
  // revision of its own.
  function agentRow(page, section, parent, words) {
    return row(page, {
      section: section, parent: parent, text: words, actor: AGENT_ACTOR,
      revision: "", state: "answered", model: MODEL,
    });
  }

  // A row as a route shows it (lotuspod.routing.public): a reader's routed
  // to demo-agent, an agent's to no one.
  function shown(entry) {
    var copy = JSON.parse(JSON.stringify(entry));
    copy.owner = entry.actor.kind === "human" ? AGENT : null;
    return copy;
  }

  function resolution(stored, root) {
    return own(stored.resolutions, String(root)) ? stored.resolutions[String(root)] : UNRESOLVED;
  }

  function cannedReply(page, section) {
    var forPage = own(REPLIES, page) ? REPLIES[page] : null;
    if (forPage && typeof forPage === "object" && own(forPage, section)) {
      return String(forPage[section]);
    }
    return String(REPLIES["*"] || "This is a scripted demo reply.");
  }

  // The scripted responder: each thread whose newest waiting reader comment
  // has waited REPLY_AFTER ms gets one reply, answering every comment in it
  // that waited.
  function respond(page, stored) {
    var late = Date.now() - REPLY_AFTER;
    var changed = false;
    stored.rows.filter(function (entry) { return entry.parent === null; }).forEach(function (root) {
      var waiting = stored.rows.filter(function (entry) {
        return (entry.id === root.id || entry.parent === root.id) &&
          entry.actor.kind === "human" && entry.state === "pending";
      });
      if (!waiting.length || Date.parse(waiting[waiting.length - 1].createdAt) > late) {
        return;
      }
      waiting.forEach(function (entry) { entry.state = "answered"; });
      stored.rows.push(agentRow(page, root.section, root.id, cannedReply(page, root.section)));
      changed = true;
    });
    if (changed) {
      save(THREADS + page, stored);
    }
  }

  // The page's threads as lotuspod.routing.threads answers them.
  function threads(page, stored) {
    return stored.rows.filter(function (entry) { return entry.parent === null; }).map(function (root) {
      return {
        root: shown(root),
        replies: stored.rows.filter(function (entry) { return entry.parent === root.id; }).map(shown),
        resolution: resolution(stored, root.id),
      };
    });
  }

  function getComments(page) {
    var stored = comments(page);
    respond(page, stored);
    return [200, {
      page: page, revision: revision(), threads: threads(page, stored),
      maxImageBytes: MAX_IMAGE_BYTES,
    }];
  }

  function quote(value) {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "object" || Object.keys(value).sort().join() !== "exact,prefix,suffix") {
      throw invalid();
    }
    return {
      exact: text(value.exact, 1, 500),
      prefix: text(value.prefix, 0, 32),
      suffix: text(value.suffix, 0, 32),
    };
  }

  function postResolution(fields) {
    var page = text(fields.page, 1, 100);
    var root = id(fields.thread);
    if (typeof fields.resolved !== "boolean") {
      throw invalid();
    }
    var stored = comments(page);
    var found = stored.rows.filter(function (entry) { return entry.id === root; })[0];
    if (!found || found.parent !== null) {
      throw new Refusal(404, "unknown_thread");
    }
    if (resolution(stored, root).resolved !== fields.resolved) {
      stored.resolutions[String(root)] = { resolved: fields.resolved, actor: READER, at: now() };
      save(THREADS + page, stored);
    }
    return [200, { thread: root, resolution: resolution(stored, root) }];
  }

  function postComment(fields) {
    if (own(fields, "thread")) {
      return postResolution(fields);
    }
    if (own(fields, "images")) {
      throw new Refusal(400, "unknown_image");
    }
    var page = text(fields.page, 1, 100);
    var words = text(fields.text, 1, MAX_TEXT);
    var stored = comments(page);
    var made;
    if (own(fields, "parent")) {
      var parent = id(fields.parent);
      var found = stored.rows.filter(function (entry) { return entry.id === parent; })[0];
      if (!found) {
        throw new Refusal(404, "unknown_parent");
      }
      var root = found.parent === null ? found.id : found.parent;
      made = readerRow(page, { section: found.section, parent: root, text: words });
      // A reader's reply to a resolved thread reopens it.
      if (resolution(stored, root).resolved) {
        stored.resolutions[String(root)] = { resolved: false, actor: READER, at: now() };
      }
    } else {
      var section = text(fields.section, 1, 16384);
      var quoted = quote(fields.quote);
      if (!hasBox(section)) {
        throw new Refusal(400, "unknown_section");
      }
      if (own(fields, "revision") && fields.revision !== revision()) {
        throw new Refusal(409, "stale_page");
      }
      made = readerRow(page, { section: section, parent: null, text: words, quote: quoted });
    }
    stored.rows.push(made);
    save(THREADS + page, stored);
    return [201, shown(made)];
  }

  // The page's answered questions, each {current, earlier}: the newest
  // answer and the older ones, newest first.
  function answers(page) {
    return load(ANSWERS + page, {});
  }

  // The label a form shows for a choice.
  function choiceLabel(form, choice) {
    var radio = Array.prototype.filter.call(form.querySelectorAll('input[name="choice"]'),
      function (input) { return input.value === choice; })[0];
    var label = radio && radio.parentNode.querySelector(".artifact-decision-label");
    return label ? label.textContent.trim() : choice;
  }

  // demo-agent's scripted line on an answer, in its form's section: in the
  // thread demo-agent began there, or a new one.
  function acknowledge(page, form, answer) {
    var body = form.closest(".artifact-section-body");
    var section = body ? body.dataset.section : "";
    if (!section || !hasBox(section)) {
      return;
    }
    var asked = form.querySelector(".artifact-decision-text");
    var words = "This is a scripted demo reply: noted, you chose “" +
      choiceLabel(form, answer.choice) + "”" +
      (asked ? " for “" + asked.textContent.trim() + "”" : "") +
      ". On a real Lotuspod site, the agent that owns the page reads your answer and acts on it.";
    var stored = comments(page);
    var begun = stored.rows.filter(function (entry) {
      return entry.parent === null && entry.section === section && entry.actor.kind === "agent";
    })[0];
    stored.rows.push(agentRow(page, section, begun ? begun.id : null, words));
    save(THREADS + page, stored);
  }

  function postAnswer(fields) {
    var names = Object.keys(fields).sort().join();
    if (names !== "choice,note,page,question,version") {
      throw invalid();
    }
    var page = text(fields.page, 1, 100);
    var question = text(fields.question, 1, 100);
    var version = text(fields.version, 1, 100);
    var choice = text(fields.choice, 1, 100);
    var note = text(fields.note, 0, MAX_TEXT);
    var form = decisionForm(question);
    if (!form) {
      throw new Refusal(400, "unknown_question");
    }
    if (version !== form.dataset.version) {
      throw new Refusal(409, "stale");
    }
    var offered = Array.prototype.some.call(form.querySelectorAll('input[name="choice"]'),
      function (input) { return input.value === choice; });
    if (!offered) {
      throw new Refusal(400, "invalid_choice");
    }
    var stored = answers(page);
    var entry = own(stored, question) ? stored[question] : { current: null, earlier: [] };
    var answer = {
      id: nextId(), page: page, question: question, version: version, choice: choice,
      note: note, revision: revision(), actor: READER, createdAt: now(),
      supersedes: entry.current ? entry.current.id : null,
    };
    if (entry.current) {
      entry.earlier.unshift(entry.current);
    }
    entry.current = answer;
    stored[question] = entry;
    save(ANSWERS + page, stored);
    acknowledge(page, form, answer);
    return [201, answer];
  }

  // The page a read names: its query's one `page`.
  function queryPage(url) {
    var names = url.searchParams.getAll("page");
    var keys = [];
    url.searchParams.forEach(function (value, key) { keys.push(key); });
    if (names.length !== 1 || keys.length !== 1) {
      throw new Refusal(400, "invalid_query");
    }
    return names[0];
  }

  function body(fields) {
    try {
      var value = JSON.parse(fields);
    } catch (ignored) {
      throw invalid();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalid();
    }
    return value;
  }

  // (status, payload) for one /api request.
  function answer(method, url, sent) {
    var path = url.pathname;
    if (path === "/api/media") {
      return method === "POST" ? [403, { error: NO_UPLOADS }] : [405, { error: "method_not_allowed" }];
    }
    if (path === "/api/revision") {
      if (method !== "GET" && method !== "HEAD") {
        return [405, { error: "method_not_allowed" }];
      }
      queryPage(url);
      return [200, { revision: revision() }];
    }
    if (path !== "/api/comments" && path !== "/api/answers") {
      return [404, { error: "not_found" }];
    }
    if (method === "POST") {
      var fields = body(sent);
      return path === "/api/comments" ? postComment(fields) : postAnswer(fields);
    }
    if (method !== "GET" && method !== "HEAD") {
      return [405, { error: "method_not_allowed" }];
    }
    var page = queryPage(url);
    if (path === "/api/answers") {
      return [200, { page: page, questions: answers(page) }];
    }
    return getComments(page);
  }

  function respondWith(status, payload) {
    return new Response(JSON.stringify(payload), {
      status: status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function handle(method, url, sent) {
    var result;
    try {
      result = answer(method, url, sent);
    } catch (error) {
      if (error instanceof Refusal) {
        result = [error.status, { error: error.error }];
      } else {
        // localStorage refused, or holds what this cannot read.
        result = [503, { error: "storage_unavailable" }];
      }
    }
    return respondWith(result[0], result[1]);
  }

  window.fetch = function (input, init) {
    var request = input instanceof Request ? input : null;
    var url;
    try {
      url = new URL(request ? request.url : String(input), location.href);
    } catch (ignored) {
      return original.apply(this, arguments);
    }
    if (url.origin !== location.origin || url.pathname.indexOf("/api/") !== 0) {
      return original.apply(this, arguments);
    }
    var method = String((init && init.method) || (request && request.method) || "GET").toUpperCase();
    if (init && init.body !== undefined && init.body !== null) {
      var sent = init.body;
      return Promise.resolve(typeof sent === "string" ? sent : "").then(function (text) {
        return handle(method, url, text);
      });
    }
    if (request && method === "POST") {
      return request.clone().text().then(function (text) {
        return handle(method, url, text);
      });
    }
    return Promise.resolve(handle(method, url, ""));
  };

  // "Reset demo": every KEY key removed, then the page loaded again.
  function reset() {
    try {
      var keys = [];
      for (var index = 0; index < window.localStorage.length; index += 1) {
        var name = window.localStorage.key(index);
        if (name !== null && name.indexOf(KEY) === 0) {
          keys.push(name);
        }
      }
      keys.forEach(function (name) { window.localStorage.removeItem(name); });
    } catch (ignored) {
      // Nothing could be kept, so nothing is left to remove.
    }
    location.reload();
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll(".demo-banner-reset"), function (button) {
      button.addEventListener("click", reset);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
