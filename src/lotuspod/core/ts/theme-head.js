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
  });
})();
