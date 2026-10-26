(function () {
  "use strict";
  // The reader's theme: Night, Dawn, or Auto, which follows the system's
  // prefers-color-scheme. The choice is kept in this browser under KEY
  // ("night" or "dawn"; no key is Auto), and the theme it resolves to is set
  // as data-theme on the root while the head parses, so the first paint is
  // already in it. Storage that refuses or throws reads as Auto.
  var KEY = "lotuspod:theme";
  var root = document.documentElement;
  var light = window.matchMedia("(prefers-color-scheme: light)");
  var choice = "auto";
  try {
    var kept = window.localStorage.getItem(KEY);
    if (kept === "night" || kept === "dawn") choice = kept;
  } catch (error) {
    choice = "auto";
  }
  var buttons = [];

  function resolved() {
    if (choice !== "auto") return choice;
    return light.matches ? "dawn" : "night";
  }

  // Set the resolved theme and press the chosen button; tell the page's
  // scripts (live blocks, diagrams) when the theme itself changed.
  function apply() {
    var theme = resolved();
    var changed = root.getAttribute("data-theme") !== theme;
    root.setAttribute("data-theme", theme);
    buttons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-choice") === choice));
    });
    if (changed) document.dispatchEvent(new CustomEvent("lotuspod:theme", {detail: {theme: theme}}));
  }

  root.setAttribute("data-theme", resolved());
  light.addEventListener("change", function () {
    if (choice === "auto") apply();
  });
  // A choice made in another document of this site (another tab, or a pod
  // framed in the index) reaches this one as a storage event; a null key is
  // storage cleared, which is Auto. sessionStorage's events are not the choice.
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY && event.key !== null) return;
    try {
      if (event.storageArea !== window.localStorage) return;
    } catch (error) {
      return;
    }
    var kept = event.newValue;
    choice = kept === "night" || kept === "dawn" ? kept : "auto";
    apply();
  });

  document.addEventListener("DOMContentLoaded", function () {
    var group = document.querySelector(".artifact-theme-switch");
    if (!group) return;
    buttons = Array.prototype.slice.call(group.querySelectorAll("button[data-theme-choice]"));
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        choice = button.getAttribute("data-theme-choice");
        try {
          if (choice === "auto") window.localStorage.removeItem(KEY);
          else window.localStorage.setItem(KEY, choice);
        } catch (error) {
          // Not kept: the choice holds on this page only.
        }
        apply();
      });
    });
    apply();
    group.hidden = false;
    wireCopyLink();
  });

  // The title bar's Copy link: the page's own address, or the version's on
  // an earlier version, with no other query and no fragment. Where the
  // clipboard refuses, a read-only field under the button holds the address,
  // selected, to copy by hand.
  function wireCopyLink() {
    var button = document.querySelector(".artifact-topbar > button.artifact-copy-link");
    if (!button) return;
    var bar = button.parentNode;
    var status = bar.querySelector(".artifact-copy-link-status");
    var field = null;
    var timer = null;
    // Each press, and each close of an open field, starts a new attempt; a
    // clipboard write that settles after a later one acts on nothing.
    var attempt = 0;

    function address() {
      var version = new URLSearchParams(location.search).get("version");
      // Origin and path, so no user name or password in the address goes
      // with it; a page opened from disk has the origin "null", so its file
      // URL instead.
      var base = location.origin !== "null" ? location.origin + location.pathname
        : location.href.split(/[?#]/)[0];
      return version ? base + "?version=" + encodeURIComponent(version) : base;
    }

    function copied() {
      clearTimeout(timer);
      button.setAttribute("data-copied", "");
      status.textContent = "Link copied";
      timer = setTimeout(function () {
        button.removeAttribute("data-copied");
        status.textContent = "";
      }, 1500);
    }

    function close() {
      if (!field || field.hidden) return;
      attempt++;
      field.hidden = true;
      button.focus();
    }

    // Under the button, its right edge on the button's, and inside the bar's
    // gutters, at whatever width the window has now.
    function place() {
      if (!field || field.hidden) return;
      var gutter = parseFloat(getComputedStyle(bar).paddingLeft);
      var right = bar.getBoundingClientRect().right - button.getBoundingClientRect().right;
      field.style.right = Math.max(0, Math.min(right, bar.clientWidth - gutter - field.offsetWidth)) + "px";
    }

    function open(text) {
      if (!field) {
        field = document.createElement("input");
        field.readOnly = true;
        field.className = "artifact-copy-link-field";
        field.setAttribute("aria-label", "Page link");
        bar.appendChild(field);
      }
      field.value = text;
      field.hidden = false;
      place();
      field.focus();
      field.select();
    }

    button.addEventListener("click", function () {
      if (field && !field.hidden) {
        close();
        return;
      }
      var text = address();
      var mine = ++attempt;
      var writing;
      try {
        // No clipboard (an insecure context) throws here too.
        writing = navigator.clipboard.writeText(text);
      } catch (error) {
        open(text);
        return;
      }
      Promise.resolve(writing).then(function () {
        if (mine === attempt) copied();
      }, function () {
        if (mine === attempt) open(text);
      });
    });
    window.addEventListener("resize", place);
    document.addEventListener("click", function (event) {
      if (event.target !== field && !button.contains(event.target)) close();
    });
    // Escape closes the field wherever focus has moved since it opened.
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !field || field.hidden) return;
      event.preventDefault();
      close();
    });
    button.hidden = false;
  }
})();
