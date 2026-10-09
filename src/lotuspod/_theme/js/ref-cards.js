  // A ticket key or pull request the page names (button.artifact-ref, marked
  // at publish) shows its card (div.artifact-ref-card, written after the
  // body) under it while it is hovered or focused; leaving it hides the card
  // unless it is pinned. A click, Enter or Space pins the card, with a ✕ and
  // a note that Esc closes it; a second click unpins it. Esc, from anywhere
  // on the page, or the ✕ closes it and puts focus back on its reference, and
  // a click outside closes it. Only one card shows at a time. The card stays
  // where it was written and is set from the reference's rectangle: under it,
  // left-aligned to it, or right-aligned where that would pass the window's
  // right edge, always inside the window.
  function refCards(refs) {
    // The room kept between the card and its reference, and the window's
    // edge, in px.
    var GAP = 6;
    var EDGE = 8;
    // The reference whose card shows, and whether the reader pinned it.
    var shown = null;
    var pinned = false;
    // True while the script itself puts focus back on a reference.
    var returning = false;

    function cardOf(ref) {
      var card = document.getElementById(ref.getAttribute("aria-controls"));
      return card && card.classList.contains("artifact-ref-card") ? card : null;
    }

    all(".artifact-ref-card").forEach(function (card) {
      all("time[datetime]", card).forEach(function (time) {
        time.textContent = when(time.getAttribute("datetime"));
      });
      // The card's links are off the body, so js/link-tab.js left them.
      all("a[href]:not([target])", card).forEach(linkTab);
      var close = element("button", "artifact-ref-card-close", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Close");
      close.hidden = true;
      close.addEventListener("click", function () {
        hide(true);
      });
      card.insertBefore(close, card.firstChild);
      var note = element("span", "artifact-ref-card-pinned", " · pinned, Esc closes");
      note.hidden = true;
      var asOf = card.querySelector(".artifact-ref-card-asof");
      (asOf || card).appendChild(note);
    });

    function place() {
      var card = shown && cardOf(shown);
      if (!card || card.hidden) {
        return;
      }
      var rect = shown.getBoundingClientRect();
      var width = card.offsetWidth;
      var height = card.offsetHeight;
      var wide = document.documentElement.clientWidth;
      var tall = window.innerHeight;
      var clamp = function (value, low, high) { return Math.max(low, Math.min(value, high)); };
      var left = rect.left + width <= wide - EDGE ? rect.left : rect.right - width;
      var top = rect.bottom + GAP;
      if (top + height > tall - EDGE && rect.top - GAP - height >= EDGE) {
        top = rect.top - GAP - height;
      }
      card.style.left = Math.round(clamp(left, EDGE, wide - width - EDGE)) + "px";
      card.style.top = Math.round(clamp(top, EDGE, tall - height - EDGE)) + "px";
    }

    function mark(pin) {
      pinned = pin;
      var card = shown && cardOf(shown);
      if (!card) {
        return;
      }
      shown.setAttribute("aria-expanded", pin ? "true" : "false");
      card.classList.toggle("artifact-ref-card--pinned", pin);
      all(".artifact-ref-card-close, .artifact-ref-card-pinned", card).forEach(function (node) {
        node.hidden = !pin;
      });
    }

    function show(ref) {
      var card = cardOf(ref);
      if (!card) {
        return;
      }
      if (shown && shown !== ref) {
        hide(false);
      }
      shown = ref;
      card.hidden = false;
      place();
    }

    // Hide the card that shows; back, put focus on its reference again.
    function hide(back) {
      if (!shown) {
        return;
      }
      var ref = shown;
      mark(false);
      shown = null;
      var card = cardOf(ref);
      if (card) {
        card.hidden = true;
      }
      if (back) {
        returning = true;
        ref.focus({ preventScroll: true });
        returning = false;
      }
    }

    // A card pinned for another reference stays until it is closed.
    function others(ref) {
      return pinned && shown && shown !== ref;
    }

    refs.forEach(function (ref) {
      if (!cardOf(ref)) {
        return;
      }
      ref.classList.add("artifact-ref--live");
      ref.addEventListener("mouseenter", function () {
        if (!others(ref)) {
          show(ref);
        }
      });
      ref.addEventListener("mouseleave", function () {
        if (shown === ref && !pinned) {
          hide(false);
        }
      });
      ref.addEventListener("focus", function () {
        if (!returning && !others(ref)) {
          show(ref);
        }
      });
      ref.addEventListener("blur", function () {
        if (shown === ref && !pinned) {
          hide(false);
        }
      });
      // A button's own click: Enter and Space as well as the pointer.
      ref.addEventListener("click", function () {
        if (shown === ref && pinned) {
          mark(false);
          return;
        }
        show(ref);
        mark(true);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && shown) {
        event.preventDefault();
        hide(true);
      }
    });
    // A click outside the card and every reference closes it.
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!shown || !target || !target.closest) {
        return;
      }
      if (!target.closest(".artifact-ref-card") && !target.closest("button.artifact-ref")) {
        hide(false);
      }
    });
    window.addEventListener("resize", place);
    // The card is set in the window, so a scroll would leave it behind its
    // reference: it is set again.
    window.addEventListener("scroll", place, { passive: true });
  }


  var pageRefs = all(".artifact-body button.artifact-ref[aria-controls]");
  if (pageRefs.length) {
    refCards(pageRefs);
  }
