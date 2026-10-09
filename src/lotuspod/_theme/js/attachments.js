
  // Images on a comment (lotuspod.api's /api/media). A composer is one box:
  // the images attached above its field, then a row with its + ("Add image").
  // It takes up to MAX_IMAGES, pasted into its field, dropped on it or picked
  // with its +.
  // A file that is not a PNG, JPEG, WebP or GIF, or is over the cap the
  // comments route reports, is refused in the composer's status line and
  // never sent; any other is uploaded at once and shown as a thumbnail with
  // an X that removes it, a link that opens it in the image viewer once it
  // is uploaded. A comment's images are drawn under its text, each a
  // link to the full size that opens in the image viewer
  // (js/image-viewer.js), or with a modifier in a new tab, its box reserved
  // from the stored width and height. A thumbnail only ever shows the uploaded
  // /media/ URL, never a blob: one, so the page policy's img-src stays
  // 'self' data:.
  var MEDIA = "/api/media";
  var MAX_IMAGES = 4;
  var NO_CAP = "The site's size limit could not be checked. Attach the image again.";
  var IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var STORED_IMAGE = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;
  // The longest side a thumbnail is drawn at, in CSS pixels: under a
  // comment, and in a composer (where the stylesheet crops it square).
  var THUMB = 112;
  var THUMB_ATTACHED = 120;
  // The largest upload the site takes, as the comments route last reported
  // it; null until it has. A file attached before then waits for it.
  var imageCap = null;
  // Each composer waiting for the cap: called with it once a read reports
  // it, or with null and why when a read could not.
  var capWaiters = [];

  // What the comments route's read said of the cap: bytes, or null with why
  // no cap was read.
  function settleImageCap(bytes, why) {
    if (bytes !== null) {
      imageCap = bytes;
    }
    var waiting = capWaiters;
    capWaiters = [];
    waiting.forEach(function (waiter) { waiter(bytes, why); });
  }

  function imageUrl(image) {
    return "/media/" + image.name;
  }

  // An image as the comments route gives it, with a stored name and a size.
  function storedImage(image) {
    return Boolean(image) && typeof image.name === "string" && STORED_IMAGE.test(image.name) &&
      image.width >= 1 && image.height >= 1;
  }

  // An image's thumbnail, sized from its stored width and height so its box
  // is drawn before its bytes arrive.
  function thumbnail(image, alt, longest) {
    var scale = Math.min(1, longest / image.width, longest / image.height);
    var img = element("img", "artifact-attach-thumb");
    img.width = Math.max(1, Math.round(image.width * scale));
    img.height = Math.max(1, Math.round(image.height * scale));
    img.alt = alt;
    img.src = imageUrl(image);
    return img;
  }

  // "1 image" or "N images": what a comment of images alone says in a list.
  function imageWords(row) {
    var count = (Array.isArray(row.images) ? row.images : []).filter(storedImage).length;
    if (!count) {
      return "";
    }
    return count === 1 ? "1 image" : count + " images";
  }

  // A comment's images as a row of thumbnails; null when it has none.
  function commentImages(row) {
    var images = (Array.isArray(row.images) ? row.images : []).filter(storedImage);
    if (!images.length) {
      return null;
    }
    var list = element("ul", "artifact-comment-images");
    images.forEach(function (image, index) {
      var item = element("li");
      var link = element("a", "artifact-comment-image");
      link.href = imageUrl(image);
      link.target = "_blank";
      link.rel = "noopener";
      var img = thumbnail(image, "Image " + (index + 1) + " of " + images.length +
        ", opens full size", THUMB);
      // Fetched once its thread is shown, never while it waits out of sight.
      img.loading = "lazy";
      link.appendChild(img);
      item.appendChild(link);
      list.appendChild(item);
    });
    return list;
  }

  // A control's drawn sign, its name given by its aria-label.
  function glyph(sign) {
    var mark = element("span", "artifact-attach-glyph", sign);
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }

  function byteSize(bytes) {
    if (bytes >= 1024 * 1024) {
      return Math.round(bytes / (1024 * 1024) * 10) / 10 + " MB";
    }
    if (bytes >= 1024) {
      return Math.round(bytes / 1024 * 10) / 10 + " KB";
    }
    return bytes + " bytes";
  }

  function fileName(file) {
    return file.name ? String(file.name) : "The image";
  }

  // Why the site refused to take file, in words.
  function uploadFailure(file, response, payload) {
    var error = payload && payload.error ? String(payload.error) : "";
    if (response.status === 401) {
      return SIGNED_OUT;
    }
    if (error === "too_many_uploads") {
      return "Too many images for now. Try again in a few minutes.";
    }
    if (error === "body_too_large") {
      return fileName(file) + " is over the size limit.";
    }
    if (error === "invalid_image" || error === "unsupported_media_type") {
      return fileName(file) + " is not a whole PNG, JPEG, WebP or GIF image.";
    }
    return fileName(file) + " was not attached (" + (error || "status " + response.status) +
      "). Try again.";
  }

  // The attachments of a composer: form, whose text field is field. The
  // field goes into the composer's box, its images above it and its + below;
  // the send button and the status line stay after the box. kept() are those
  // uploaded with their sizes, in order (to keep over a reload), busy()
  // whether any is still uploading, held() whether any is attached or on
  // its way, and restore() attaches images kept before a reload again.
  // sending() gives the stored names of those uploaded and holds the
  // composer while the comment naming them saves: nothing is attached or
  // removed until sent() takes them off once it is saved, or gives them
  // back when it is not.
  function attachments(form, field) {
    var status = form.querySelector(".artifact-comment-status");
    var box = element("div", "artifact-composer-box");
    var tray = element("ul", "artifact-attach-tray");
    var bar = element("div", "artifact-attach");
    var add = element("button", "artifact-attach-add");
    add.type = "button";
    add.setAttribute("aria-label", "Add image");
    add.appendChild(glyph("+"));
    var picker = element("input");
    picker.type = "file";
    picker.accept = IMAGE_TYPES.join(",");
    picker.multiple = true;
    picker.hidden = true;
    picker.tabIndex = -1;
    bar.append(add, picker);
    form.insertBefore(box, field);
    box.append(tray, field, bar);
    var items = [];
    // Files attached before the cap was known, in order.
    var queued = [];
    // The images a comment saving names; null while none is saving.
    var saving = null;

    function update() {
      tray.hidden = !items.length;
      add.disabled = saving !== null || items.length >= MAX_IMAGES;
      // A comment of images alone may say nothing more.
      field.required = !items.length;
      items.forEach(function (item, index) {
        var place = (index + 1) + " of " + items.length;
        item.remove.setAttribute("aria-label", "Remove image " + place);
        item.remove.disabled = saving !== null;
        if (item.thumb) {
          item.thumb.alt = "Attached image " + place;
        }
      });
    }

    function drop(item) {
      var at = items.indexOf(item);
      if (at >= 0) {
        items.splice(at, 1);
      }
      item.node.remove();
      update();
    }

    // Why file is not sent; "" when it is.
    function refusal(file) {
      if (IMAGE_TYPES.indexOf(file.type) < 0) {
        return fileName(file) + " is not a PNG, JPEG, WebP or GIF image.";
      }
      if (imageCap !== null && file.size > imageCap) {
        return fileName(file) + " is over the " + byteSize(imageCap) + " limit.";
      }
      return "";
    }

    // A place in the tray, uploading until shown() is given its image.
    function slot() {
      var node = element("li", "artifact-attach-item artifact-attach-item--loading");
      var holder = element("span", "artifact-attach-holder", "Uploading");
      var remove = element("button", "artifact-attach-remove");
      remove.type = "button";
      remove.appendChild(glyph("\u00d7"));
      node.append(holder, remove);
      var item = {
        node: node, holder: holder, remove: remove, thumb: null, name: null, image: null, gone: false,
      };
      remove.addEventListener("click", function () {
        if (saving !== null) {
          return;
        }
        item.gone = true;
        drop(item);
        field.focus({ preventScroll: true });
      });
      items.push(item);
      tray.appendChild(node);
      update();
      return item;
    }

    function shown(item, image) {
      item.name = image.name;
      item.image = { name: image.name, width: image.width, height: image.height };
      // A link to the uploaded /media/ URL, which the image viewer opens.
      var link = element("a", "artifact-attach-link");
      link.href = imageUrl(image);
      link.target = "_blank";
      link.rel = "noopener";
      item.thumb = thumbnail(image, "Attached image", THUMB_ATTACHED);
      link.appendChild(item.thumb);
      item.holder.replaceWith(link);
      item.node.classList.remove("artifact-attach-item--loading");
      update();
    }

    async function upload(file) {
      var item = slot();
      var why;
      try {
        var response = await fetch(MEDIA, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        var payload = await json(response);
        if (response.status === 201 && payload && storedImage(payload)) {
          if (items.some(function (other) { return other.name === payload.name; })) {
            if (!item.gone) {
              drop(item);
              status.textContent = fileName(file) + " is attached already.";
            }
            return;
          }
          shown(item, payload);
          return;
        }
        why = uploadFailure(file, response, payload);
      } catch (ignored) {
        why = fileName(file) + " was not attached: the site did not answer. Try again.";
      }
      if (!item.gone) {
        drop(item);
        status.textContent = why;
      }
    }

    // Files waiting for the cap are checked against it once it is read;
    // without it they are dropped, the status line saying why.
    function settled(bytes, why) {
      var files = queued;
      queued = [];
      if (bytes === null) {
        status.textContent = why;
        return;
      }
      take(files);
    }

    function take(files) {
      if (saving !== null) {
        status.textContent = "Saving... Attach more images once the comment is saved.";
        return;
      }
      var refused = [];
      files.forEach(function (file) {
        var why = items.length + queued.length >= MAX_IMAGES
          ? "A comment takes up to " + MAX_IMAGES + " images."
          : refusal(file);
        if (why) {
          if (refused.indexOf(why) < 0) {
            refused.push(why);
          }
          return;
        }
        if (imageCap === null) {
          if (!queued.length) {
            capWaiters.push(settled);
          }
          queued.push(file);
          return;
        }
        upload(file);
      });
      if (queued.length) {
        refused.push("Checking the size limit...");
      }
      status.textContent = refused.join(" ");
    }

    field.addEventListener("paste", function (event) {
      var files = event.clipboardData ? Array.prototype.slice.call(event.clipboardData.files) : [];
      if (files.length) {
        event.preventDefault();
        take(files);
      }
    });
    // A drag that carries files is the composer's: the browser does not
    // open them. One of text alone is left to the browser.
    function carriesFiles(event) {
      return Boolean(event.dataTransfer) && Array.prototype.indexOf.call(event.dataTransfer.types, "Files") >= 0;
    }
    form.addEventListener("dragover", function (event) {
      if (carriesFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    });
    form.addEventListener("drop", function (event) {
      if (!carriesFiles(event)) {
        return;
      }
      event.preventDefault();
      take(Array.prototype.slice.call(event.dataTransfer.files || []));
    });
    add.addEventListener("click", function () {
      picker.click();
    });
    picker.addEventListener("change", function () {
      var files = Array.prototype.slice.call(picker.files || []);
      picker.value = "";
      take(files);
    });
    update();

    return {
      kept: function () {
        return items.filter(function (item) { return item.image; }).map(function (item) { return item.image; });
      },
      busy: function () {
        return queued.length > 0 || items.some(function (item) { return !item.name; });
      },
      held: function () {
        return queued.length > 0 || items.length > 0;
      },
      // Attach again the stored images kept, after any attached already and
      // never twice; why those past MAX_IMAGES were not, else "".
      restore: function (images) {
        var over = false;
        (Array.isArray(images) ? images : []).filter(storedImage).forEach(function (image) {
          if (items.some(function (item) { return item.name === image.name; })) {
            return;
          }
          if (items.length >= MAX_IMAGES) {
            over = true;
            return;
          }
          shown(slot(), image);
        });
        return over ? "A comment takes up to " + MAX_IMAGES + " images: the others were not kept." : "";
      },
      // The stored names of the images uploaded, held until sent() says
      // whether the comment naming them was saved.
      sending: function () {
        saving = items.filter(function (item) { return item.name; });
        update();
        return saving.map(function (item) { return item.name; });
      },
      sent: function (saved) {
        var held = saving || [];
        saving = null;
        if (saved) {
          held.forEach(drop);
        }
        update();
      },
    };
  }
