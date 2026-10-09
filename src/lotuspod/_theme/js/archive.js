
  // Archiving a page from its header (lotuspod.archive): the page asks the
  // archive route once. When it answers 200 and the reader may archive (one
  // of the [access] owners), the header gains a button after its date line,
  // "Archive", or "Unarchive" on an archived page. Pressed, it posts the
  // other state and reloads the page on 200, which serve then answers with
  // its banner or without; any other answer leaves the page as it is, a line
  // beside the button saying why. Signed out, as a reader who is not an
  // owner, or on any other answer, there is no button.
  function archiveButton() {
    var ARCHIVE = "/api/archive";
    var line = document.querySelector("header.artifact-header p.artifact-meta");
    if (!line) {
      return;
    }
    var named = document.querySelector("[data-page]");
    var page = named ? named.dataset.page :
      decodeURIComponent(location.pathname.split("/").pop()).replace(/\.html$/, "");

    function refused(response, payload, archived) {
      if (response.status === 401) {
        return SIGNED_OUT;
      }
      var error = payload && payload.error ? String(payload.error) : "status " + response.status;
      return "The page was not " + (archived ? "archived" : "unarchived") + " (" + error +
        "). Try again.";
    }

    function draw(archived) {
      var button = element("button", "artifact-archive", archived ? "Unarchive" : "Archive");
      button.type = "button";
      var status = element("span", "artifact-archive-status");
      status.setAttribute("role", "status");
      line.parentNode.insertBefore(button, line.nextSibling);
      button.parentNode.insertBefore(status, button.nextSibling);
      button.addEventListener("click", async function () {
        button.disabled = true;
        status.textContent = archived ? "Unarchiving..." : "Archiving...";
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
          status.textContent = refused(response, await json(response), !archived);
        } catch (ignored) {
          status.textContent = "Not saved: the site did not answer. Try again.";
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
