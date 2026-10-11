/* Frontend unit tests for static/chatlib.js (markdown, XSS, export/import).
 * Run: node tests/test_frontend.mjs   (no browser, no API key needed)
 */
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ChatLib = require("../static/chatlib.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// --- 16. Markdown / XSS handling -------------------------------------------
check("script tags are escaped, never executed", () => {
  const html = ChatLib.renderMarkdown('<script>alert("x")</script>');
  assert.ok(!html.includes("<script>"), "raw script leaked: " + html);
  assert.ok(html.includes("&lt;script&gt;"), "escaped script missing: " + html);
});

check("img onerror injection is inert", () => {
  const html = ChatLib.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes("<img"), "raw img leaked: " + html);
  assert.ok(html.includes("&lt;img"), "escaped img missing");
});

check("javascript: links are neutralized", () => {
  const html = ChatLib.renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!html.includes("<a href="), "clickable link created: " + html);
});

check("https links become safe anchors", () => {
  const html = ChatLib.renderMarkdown("[Groq](https://groq.com)");
  assert.ok(html.includes('<a href="https://groq.com"'), "anchor missing: " + html);
  assert.ok(html.includes('rel="noopener noreferrer"'), "rel missing");
});

check("fenced code blocks render with copy button", () => {
  const html = ChatLib.renderMarkdown("```python\nprint('hi')\n```");
  assert.ok(html.includes("<pre><code"), "pre/code missing: " + html);
  assert.ok(html.includes("data-copycode"), "copy button missing");
  assert.ok(html.includes("print(&#39;hi&#39;)"), "code content wrong: " + html);
});

check("inline code, bold, italic render", () => {
  const html = ChatLib.renderMarkdown("Use `pip install x` for **fast** *setup*.");
  assert.ok(html.includes("<code>pip install x</code>"), "inline code: " + html);
  assert.ok(html.includes("<strong>fast</strong>"), "bold: " + html);
  assert.ok(html.includes("<em>setup</em>"), "italic: " + html);
});

check("headings, lists, blockquote render", () => {
  const html = ChatLib.renderMarkdown("# Title\n\n- one\n- two\n\n> quoted");
  assert.ok(html.includes("<h1>Title</h1>"), "h1: " + html);
  assert.ok(html.includes("<ul>") && html.includes("<li>one</li>"), "list: " + html);
  assert.ok(html.includes("<blockquote>quoted</blockquote>"), "quote: " + html);
});

check("ordered lists and tables render", () => {
  const html = ChatLib.renderMarkdown("1. first\n2. second\n\n| A | B |\n|---|---|\n| 1 | 2 |");
  assert.ok(html.includes("<ol>"), "ol: " + html);
  assert.ok(html.includes("<table>") && html.includes("<th>A</th>") && html.includes("<td>2</td>"), "table: " + html);
});

// --- 17/18. export + import -------------------------------------------------
check("markdown export contains title and turns", () => {
  const md = ChatLib.buildExportMarkdown({
    title: "My chat",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ],
  });
  assert.ok(md.startsWith("# My chat"), "title: " + md);
  assert.ok(md.includes("## You") && md.includes("## ChatNova"), "turns: " + md);
});

check("json export round-trips through import validation", () => {
  const conv = { title: "Round", messages: [{ role: "user", content: "Q" }, { role: "assistant", content: "A" }] };
  const res = ChatLib.validateImported(ChatLib.buildExportJSON(conv));
  assert.equal(res.ok, true);
  assert.equal(res.conversation.messages.length, 2);
  assert.equal(res.conversation.title, "Round");
});

check("import rejects garbage", () => {
  assert.equal(ChatLib.validateImported("not json").ok, false);
  assert.equal(ChatLib.validateImported("{}").ok, false);
  assert.equal(ChatLib.validateImported({ messages: [] }).ok, false);
  assert.equal(ChatLib.validateImported({ messages: [{ role: "bot", content: "x" }] }).ok, false);
  assert.equal(ChatLib.validateImported({ messages: [{ role: "user", content: "   " }] }).ok, false);
  assert.equal(ChatLib.validateImported({ messages: [{ role: "user" }] }).ok, false);
  const tooMany = { messages: Array.from({ length: 201 }, () => ({ role: "user", content: "x" })) };
  assert.equal(ChatLib.validateImported(tooMany).ok, false);
});

check("import of plain message array without title gets derived title", () => {
  const res = ChatLib.validateImported({ messages: [{ role: "user", content: "Explain photosynthesis" }] });
  assert.equal(res.ok, true);
  assert.equal(res.conversation.title, "Explain photosynthesis");
});

console.log(`\n${passed} frontend tests passed.`);
