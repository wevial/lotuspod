
  // Archiving a page from its top bar (lotuspod.archive): the page asks the
  // archive route once. When it answers 200 and the reader may archive (one
  // of the [access] owners), the top bar gains a button at its right end,
  // before the review sheet's bar when it has one (js/review-sheet.js),
  // "Archive", or "Unarchive" on an archived page. The top bar is fixed and
  // takes no room in flow, so nothing on the page moves when it arrives.
  // Pressed, it posts the other state and reloads the page on 200, which
  // serve then answers with its banner or without; any other answer leaves
  // the page as it is, a line beside the button saying why. Signed out, as a
  // reader who is not an owner, on a page with no top bar, or on any other
  // answer, there is no button.
  function archiveButton() {
    var ARCHIVE = "/api/archive";
    var top = document.querySelector(".artifact-topbar");
    if (!top) {
      return;
    }
    var page = pageName();

    function draw(archived) {
      var button = element("button", "artifact-archive", archived ? "Unarchive" : "Archive");
      button.type = "button";
      var status = element("span", "artifact-archive-status");
      status.setAttribute("role", "status");
      var bar = element("span", "artifact-archive-bar");
      bar.appendChild(button);
      bar.appendChild(status);
      top.insertBefore(bar, top.querySelector(":scope > .artifact-review-bar"));

      function say(text) {
        status.textContent = text;
        status.title = text;
      }

      button.addEventListener("click", async function () {
        button.disabled = true;
        say(archived ? "Unarchiving..." : "Archiving...");
        try {
          var response = await fetch(ARCHIVE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ page: page, archived: !archived }),
          });
          if (response.status === 200) {
            location.reload();
            return;
          }
          var payload = await json(response);
          var error = payload && payload.error ? String(payload.error) : "status " + response.status;
          say(response.status === 401 ? SIGNED_OUT : "The page was not " +
            (archived ? "unarchived" : "archived") + " (" + error + "). Try again.");
        } catch (ignored) {
          say("Not saved: the site did not answer. Try again.");
        }
        button.disabled = false;
      });
    }

    fetch(ARCHIVE + "?page=" + encodeURIComponent(page)).then(async function (response) {
      var payload = response.status === 200 ? await json(response) : null;
      if (payload && payload.mayArchive === true) {
        draw(Boolean(payload.archived));
      }
    }).catch(function () {
      // No answer: no button.
    });
  }

  archiveButton();
