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
  var CHOICES = ["night", "dawn", "auto"];
  var NAMES = {night: "Night", dawn: "Dawn", auto: "Auto"};
  var buttons = [];
  var cycle = null;

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
    if (cycle) {
      cycle.textContent = NAMES[choice].charAt(0);
      cycle.setAttribute("aria-label", "Theme: " + NAMES[choice]);
      cycle.title = "Theme: " + NAMES[choice];
    }
    if (changed) document.dispatchEvent(new CustomEvent("lotuspod:theme", {detail: {theme: theme}}));
  }

  root.setAttribute("data-theme", resolved());
  light.addEventListener("change", function () {
    if (choice === "auto") apply();
  });

  document.addEventListener("DOMContentLoaded", function () {
    var group = document.querySelector(".artifact-theme-switch");
    if (!group) return;
    function choose(value) {
      choice = value;
      try {
        if (choice === "auto") window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, choice);
      } catch (error) {
        // Not kept: the choice holds on this page only.
      }
      apply();
    }
    buttons = Array.prototype.slice.call(group.querySelectorAll("button[data-theme-choice]"));
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        choose(button.getAttribute("data-theme-choice"));
      });
    });
    // A narrow bar beside the review sheet's controls shows one button in
    // place of the three (theme-switch.css): it names the choice and steps
    // to the next, Night, Dawn, Auto.
    cycle = group.querySelector(".artifact-theme-cycle");
    if (cycle) {
      cycle.addEventListener("click", function () {
        choose(CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length]);
      });
    }
    apply();
    group.hidden = false;
  });
})();
