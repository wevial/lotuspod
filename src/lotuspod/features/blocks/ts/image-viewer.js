
  // The image viewer: a plain click on a page figure's image
  // (.artifact-figure a), on a comment's thumbnail (a.artifact-comment-image)
  // or on one attached in a composer (a.artifact-attach-link) opens the image
  // over the page, in a modal dialog, instead of leaving it.
  // The image is drawn at its natural size, scaled down to fit the window,
  // captioned with its alt text; a comment's images, and a composer's, have
  // Previous and Next between them. The dialog's own Escape, its Close button
  // or a click beside the image closes it, and the focus goes back to the
  // link that opened it.
  // A click with a modifier, or the dialog's "Open original" link, opens the
  // image's /media/ URL itself in a new page. The viewer only ever shows a URL
  // the page links to already, so the page policy's img-src stays as it is.
  // The comments island opens a page figure's image here in mark mode
  // (MARK_VIEW) where comments use the bottom sheet: its bar sits over the
  // image, presses on the image draw, Escape goes to it until it leaves mark
  // mode, and a click beside the image closes nothing meanwhile.
  function imageViewer() {
    var OPENERS = ".artifact-body .artifact-figure a[href], a.artifact-comment-image[href], " +
      "ul.artifact-attach-tray a.artifact-attach-link[href]";
    var dialog = null;
    var parts = null;
    // What the viewer shows: the links it steps between, the one shown, and
    // the link that opened it.
    var group = [];
    var at = 0;
    var opener = null;
    // MARK_VIEW's detail while the viewer is in mark mode, else null; and
    // the figure mark mode opened it from, whose Comment takes the focus back.
    var marking = null;
    var origin = null;

    function make() {
      dialog = element("dialog", "artifact-image-viewer");
      var figure = element("figure", "artifact-image-viewer-figure");
      // The frame holds the image alone, so mark mode's overlay covers it.
      var frame = element("div", "artifact-image-viewer-frame");
      var image = element("img", "artifact-image-viewer-image");
      var caption = element("figcaption", "artifact-image-viewer-caption");
      caption.id = "artifact-image-viewer-caption";
      frame.appendChild(image);
      figure.append(frame, caption);
      var bar = element("div", "artifact-image-viewer-bar");
      var back = element("button", "artifact-image-viewer-step", "Previous");
      var forth = element("button", "artifact-image-viewer-step", "Next");
      var original = element("a", "artifact-image-viewer-original", "Open original");
      original.target = "_blank";
      original.rel = "noopener";
      var close = element("button", "artifact-image-viewer-close", "Close");
      [back, forth, close].forEach(function (button) { button.type = "button"; });
      close.autofocus = true;
      bar.append(back, forth, original, close);
      dialog.append(figure, bar);
      document.body.appendChild(dialog);
      parts = { figure: figure, frame: frame, image: image, caption: caption, back: back, forth: forth, original: original,
        close: close };

      back.addEventListener("click", function () { show(at - 1); });
      forth.addEventListener("click", function () { show(at + 1); });
      close.addEventListener("click", function () { dialog.close(); });
      // A click beside the image and its controls lands on the dialog
      // itself, which fills the window over its backdrop.
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog && !marking) {
          dialog.close();
        }
      });
      // The dialog closes on Escape itself; what is open under it (a
      // thread's popover or sheet) stays open.
      dialog.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (marking) {
            event.preventDefault();
            marking.escape();
          }
        } else if (event.key === "Tab") {
          keepFocus(event);
        }
      });
      dialog.addEventListener("close", function () {
        var marked = marking;
        var from = origin;
        marking = null;
        origin = null;
        parts.image.removeAttribute("src");
        if (opener && opener.isConnected) {
          opener.focus({ preventScroll: true });
        }
        opener = null;
        if (marked) {
          marked.closed();
        }
        // Not when what closed it has put the focus elsewhere: the bottom
        // sheet, once a comment marked in it is posted.
        var comment = from && from.querySelector(".artifact-spot-comment");
        if (comment && (document.activeElement === document.body || dialog.contains(document.activeElement))) {
          comment.focus({ preventScroll: true });
        }
      });
    }

    // Tab and Shift+Tab go round the dialog's controls, never out of it.
    function keepFocus(event) {
      var stops = all("button, a[href], textarea, [tabindex='0']", dialog).filter(function (node) {
        return !node.hidden && !node.disabled;
      });
      if (!stops.length) {
        return;
      }
      var first = stops[0];
      var last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function show(index) {
      at = (index + group.length) % group.length;
      var link = group[at];
      var url = link.getAttribute("href");
      var shown = link.querySelector("img");
      var words = (shown && shown.alt) || "";
      parts.image.src = url;
      parts.image.alt = words;
      parts.caption.textContent = words;
      parts.caption.hidden = !words;
      if (words) {
        dialog.setAttribute("aria-labelledby", parts.caption.id);
        dialog.removeAttribute("aria-label");
      } else {
        dialog.removeAttribute("aria-labelledby");
        dialog.setAttribute("aria-label", "Image");
      }
      parts.original.href = url;
      parts.back.hidden = parts.forth.hidden = group.length < 2;
    }

    document.addEventListener("click", function (event) {
      var link = event.target.closest && event.target.closest(OPENERS);
      if (!link || event.defaultPrevented || event.button !== 0 ||
          event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      // In mark mode the viewer keeps the image being marked: a composer's
      // attached image opens nothing over it.
      if (marking) {
        return;
      }
      if (!dialog) {
        make();
      }
      var list = link.closest("ul.artifact-comment-images, ul.artifact-attach-tray");
      group = list ? all("a.artifact-comment-image[href], a.artifact-attach-link[href]", list) : [link];
      opener = link;
      show(group.indexOf(link));
      if (!dialog.open) {
        dialog.showModal();
      }
    });

    // The comments island's mark mode, on a page figure's image while the
    // viewer is closed.
    document.addEventListener(MARK_VIEW, function (event) {
      var figure = event.target;
      var link = figure.matches(".artifact-body .artifact-figure") && figure.querySelector("a[href]");
      if (!link || (dialog && dialog.open)) {
        return;
      }
      if (!dialog) {
        make();
      }
      group = [link];
      opener = null;
      origin = figure;
      show(0);
      dialog.showModal();
      var detail = event.detail;
      marking = detail;
      detail.surface = parts.frame;
      detail.image = parts.image;
      detail.room = dialog;
      detail.dock = function (bar) { dialog.insertBefore(bar, parts.figure); };
      detail.done = function () {
        if (marking === detail) {
          marking = null;
          parts.close.focus({ preventScroll: true });
        }
      };
      detail.close = function () { dialog.close(); };
      event.preventDefault();
    });
  }

  imageViewer();
