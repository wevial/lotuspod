
  // A comment's text as a small markdown subset (commentMarkdown below):
  // paragraphs, **bold**, *italic*, `code`, fenced code blocks, links and
  // one level of bullet and numbered lists. Every node is made with
  // createElement and every text set with textContent, so raw HTML and
  // entities in a comment are text by construction. Anything outside the
  // subset (headings, quotes, tables, images, `_`) stays as typed.
  // A fence is a line of three backticks (a word after them is allowed);
  // a line of four or more is text.
  var MD_FENCE = /^\s*```[^`]*$/;
  var MD_FENCE_END = /^\s*```\s*$/;
  var MD_BULLET = /^\s*[-*] (.*)$/;
  var MD_NUMBER = /^\s*(\d+)\. (.*)$/;
  var MD_BLANK = /^\s*$/;
  // A link's target: no space, and any parentheses in pairs, so that
  // `javascript:alert(1)` is read whole and refused whole.
  var MD_TARGET = "([^\\s()]*(?:\\([^\\s()]*\\)[^\\s()]*)*)";
  // The earliest of a code span, an image (kept as typed), a link, bold or
  // italic. Italic opens on a `*` before a non-space and closes on one after
  // a non-space, so a lone `2 * 3` is text.
  var MD_INLINE = new RegExp([
    "`([^`\\n]+)`",
    "(!)\\[[^\\]\\n]*\\]\\(" + MD_TARGET + "\\)",
    "\\[([^\\]\\n]+)\\]\\(" + MD_TARGET + "\\)",
    "\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*",
    "\\*(?=[^\\s*])([\\s\\S]*?[^\\s*])\\*(?!\\*)",
  ].join("|"));
  // A link target drawn as a link, as lotuspod.markdown's _LINK_TARGET:
  // http(s), or a relative path or `#anchor` (no `//` start, no `:` before
  // its first `/`, `?` or `#`).
  var MD_LINK_TARGET = /^(?:https?:\/\/|(?!\/\/)[^:\/?#]*(?:[\/?#]|$))/i;

  // The inline markup of text, appended to parent.
  function markdownInline(parent, text) {
    var rest = text;
    while (rest) {
      var found = MD_INLINE.exec(rest);
      if (!found) {
        break;
      }
      var node = null;
      if (found[1] !== undefined) {
        node = element("code", "", found[1]);
      } else if (found[4] !== undefined && MD_LINK_TARGET.test(found[5])) {
        node = element("a", "", found[4]);
        node.setAttribute("href", found[5]);
        node.target = "_blank";
        node.rel = "noopener";
      } else if (found[6] !== undefined || found[7] !== undefined) {
        node = element(found[6] !== undefined ? "strong" : "em");
        markdownInline(node, found[6] !== undefined ? found[6] : found[7]);
      }
      // An image, and a link whose target is refused, stay as typed, whole.
      var end = found.index + found[0].length;
      parent.appendChild(document.createTextNode(rest.slice(0, node ? found.index : end)));
      if (node) {
        parent.appendChild(node);
      }
      rest = rest.slice(end);
    }
    if (rest) {
      parent.appendChild(document.createTextNode(rest));
    }
  }

  // text's blocks, appended to parent: a blank line ends a paragraph, and a
  // single newline in one stays a line break.
  function commentMarkdown(parent, text) {
    var lines = text.split(/\r\n|\r|\n/);
    var paragraph = [];
    var list = null;
    var item = null;

    function closeParagraph() {
      if (paragraph.length) {
        var node = element("p");
        markdownInline(node, paragraph.join("\n"));
        parent.appendChild(node);
        paragraph = [];
      }
    }

    function closeList() {
      list = null;
      item = null;
    }

    for (var at = 0; at < lines.length; at++) {
      var line = lines[at];
      if (MD_FENCE.test(line)) {
        closeParagraph();
        closeList();
        var code = [];
        // An unclosed fence runs to the end.
        for (at += 1; at < lines.length && !MD_FENCE_END.test(lines[at]); at++) {
          code.push(lines[at]);
        }
        var pre = element("pre");
        pre.appendChild(element("code", "", code.join("\n")));
        parent.appendChild(pre);
        continue;
      }
      if (MD_BLANK.test(line)) {
        closeParagraph();
        closeList();
        continue;
      }
      var bullet = MD_BULLET.exec(line);
      var number = bullet ? null : MD_NUMBER.exec(line);
      if (bullet || number) {
        closeParagraph();
        var tag = bullet ? "ul" : "ol";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = element(tag);
          if (number && number[1] !== "1") {
            list.start = Number(number[1]);
          }
          parent.appendChild(list);
        }
        item = element("li");
        markdownInline(item, bullet ? bullet[1] : number[2]);
        list.appendChild(item);
        continue;
      }
      if (item) {
        // A line under an item, before a blank line, carries on the item.
        item.appendChild(document.createTextNode("\n"));
        markdownInline(item, line);
        continue;
      }
      paragraph.push(line);
    }
    closeParagraph();
    return parent;
  }
