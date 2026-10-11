/* ChatNova pure helpers — no DOM, no network.
 * Loaded by index.html and by the node test suite (tests/test_frontend.mjs).
 * Markdown rendering escapes ALL HTML first, so model output can never
 * execute scripts or markup in the page.
 */
var ChatLib = (function () {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function uid() {
    return "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function clampStr(s, max) {
    s = String(s == null ? "" : s);
    return s.length > max ? s.slice(0, max) : s;
  }

  // -- inline markdown (input is already HTML-escaped) ----------------------
  function inlineMd(escaped) {
    var out = escaped;
    // inline code first (protect contents from further formatting)
    var codes = [];
    out = out.replace(/`([^`\n]+)`/g, function (m, code) {
      codes.push(code);
      return "\u0000CODE" + (codes.length - 1) + "\u0000";
    });
    // links [text](https://...) — http(s) and mailto only
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, href) {
      if (/^(https?:\/\/|mailto:)/i.test(href)) {
        return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
      }
      return text + " (" + href + ")";
    });
    // bold + italic
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    // restore inline code
    out = out.replace(/\u0000CODE(\d+)\u0000/g, function (m, i) {
      return "<code>" + codes[Number(i)] + "</code>";
    });
    return out;
  }

  function isTableSep(line) {
    var cells = line.replace(/^\||\|$/g, "").split("|");
    if (cells.length < 1) return false;
    return cells.every(function (c) {
      return /^:?-{1,}:?$/.test(c.trim());
    });
  }

  function splitRow(line) {
    return line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map(function (c) {
        return c.trim();
      });
  }

  // -- block markdown → safe HTML -------------------------------------------
  function renderMarkdown(src) {
    var text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    // extract fenced code blocks before escaping
    var fences = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      fences.push({ lang: (lang || "").slice(0, 20), code: code.replace(/\n$/, "") });
      return "\u0000FENCE" + (fences.length - 1) + "\u0000\n";
    });

    var escaped = escapeHtml(text);
    var lines = escaped.split("\n");
    var html = [];
    var i = 0;

    function flushList(stack) {
      while (stack.length) {
        html.push(stack.pop() === "ol" ? "</ol>" : "</ul>");
      }
    }

    var listStack = [];
    function pushList(kind) {
      if (listStack[listStack.length - 1] !== kind) {
        flushList(listStack);
        html.push(kind === "ol" ? "<ol>" : "<ul>");
        listStack.push(kind);
      }
    }

    while (i < lines.length) {
      var line = lines[i];
      var fenceOnly = line.match(/^\u0000FENCE(\d+)\u0000$/);
      if (fenceOnly) {
        flushList(listStack);
        var f = fences[Number(fenceOnly[1])];
        var langAttr = f.lang ? ' data-lang="' + f.lang + '"' : "";
        html.push(
          '<div class="codeblock"><div class="codebar"><span class="codelang">' +
            (f.lang || "code") +
            '</span><button type="button" class="copycode" data-copycode>Copy</button></div>' +
            "<pre><code" + langAttr + ">" + escapeHtml(f.code) + "</code></pre></div>"
        );
        i++;
        continue;
      }
      var t = line.trim();
      if (!t) {
        flushList(listStack);
        i++;
        continue;
      }
      // headings
      var h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushList(listStack);
        html.push("<h" + h[1].length + ">" + inlineMd(h[2]) + "</h" + h[1].length + ">");
        i++;
        continue;
      }
      // horizontal rule
      if (/^(-{3,}|\*{3,})$/.test(t)) {
        flushList(listStack);
        html.push("<hr>");
        i++;
        continue;
      }
      // blockquote
      if (/^&gt;/.test(t)) {
        flushList(listStack);
        var quotes = [];
        while (i < lines.length && /^&gt;/.test(lines[i].trim())) {
          quotes.push(lines[i].trim().replace(/^&gt;\s?/, ""));
          i++;
        }
        html.push("<blockquote>" + quotes.map(inlineMd).join("<br>") + "</blockquote>");
        continue;
      }
      // tables
      if (t.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
        flushList(listStack);
        var head = splitRow(t);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim().indexOf("|") !== -1) {
          rows.push(splitRow(lines[i].trim()));
          i++;
        }
        var th = head.map(function (c) { return "<th>" + inlineMd(c) + "</th>"; }).join("");
        var tb = rows
          .map(function (r) {
            return (
              "<tr>" +
              r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") +
              "</tr>"
            );
          })
          .join("");
        html.push('<div class="tablewrap"><table><thead><tr>' + th + "</tr></thead><tbody>" + tb + "</tbody></table></div>");
        continue;
      }
      // lists
      var ul = t.match(/^[-*•]\s+(.*)$/);
      var ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        pushList(ul ? "ul" : "ol");
        html.push("<li>" + inlineMd((ul ? ul[1] : ol[1])) + "</li>");
        i++;
        continue;
      }
      flushList(listStack);
      // paragraph (collect wrapped lines)
      var para = [t];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\u0000FENCE\d+\u0000$/.test(lines[i].trim()) &&
        !/^(#{1,4}\s|&gt;|[-*•]\s|\d+[.)]\s|(-{3,}|\*{3,}))/.test(lines[i].trim()) &&
        lines[i].trim().indexOf("|") === -1
      ) {
        para.push(lines[i].trim());
        i++;
      }
      html.push("<p>" + para.map(inlineMd).join("<br>") + "</p>");
    }
    flushList(listStack);
    return html.join("\n");
  }

  // -- conversation export / import ------------------------------------------
  function titleFrom(messages) {
    for (var k = 0; k < messages.length; k++) {
      if (messages[k].role === "user" && messages[k].content.trim()) {
        return clampStr(messages[k].content.trim().replace(/\s+/g, " "), 48);
      }
    }
    return "Untitled chat";
  }

  function buildExportMarkdown(conv) {
    var out = ["# " + (conv.title || titleFrom(conv.messages || [])), ""];
    (conv.messages || []).forEach(function (m) {
      out.push(m.role === "user" ? "## You" : "## ChatNova", "", m.content, "");
    });
    return out.join("\n");
  }

  function buildExportJSON(conv) {
    return JSON.stringify(
      { app: "AIChatbot", version: 1, title: conv.title, exported_at: new Date().toISOString(), messages: conv.messages },
      null,
      2
    );
  }

  // Returns {ok, conversation} or {ok:false, error}. Never throws.
  function validateImported(data) {
    try {
      var obj = typeof data === "string" ? JSON.parse(data) : data;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return { ok: false, error: "File is not a chat export object." };
      }
      var msgs = obj.messages;
      if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > 200) {
        return { ok: false, error: "Export must contain 1 to 200 messages." };
      }
      var cleaned = [];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
          return { ok: false, error: "Message #" + (i + 1) + " is invalid (needs user/assistant role and text)." };
        }
        var content = m.content.trim();
        if (!content) return { ok: false, error: "Message #" + (i + 1) + " is empty." };
        if (content.length > 20000) return { ok: false, error: "Message #" + (i + 1) + " is too long." };
        cleaned.push({ role: m.role, content: content });
      }
      var title = typeof obj.title === "string" && obj.title.trim()
        ? clampStr(obj.title.trim(), 80)
        : titleFrom(cleaned);
      return { ok: true, conversation: { id: uid(), title: title, messages: cleaned, updatedAt: Date.now() } };
    } catch (e) {
      return { ok: false, error: "File is not valid JSON." };
    }
  }

  return {
    escapeHtml: escapeHtml,
    uid: uid,
    clampStr: clampStr,
    renderMarkdown: renderMarkdown,
    titleFrom: titleFrom,
    buildExportMarkdown: buildExportMarkdown,
    buildExportJSON: buildExportJSON,
    validateImported: validateImported,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ChatLib;
}
