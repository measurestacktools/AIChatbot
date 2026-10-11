/* ChatNova frontend — conversations in localStorage, key stays on server. */
(function () {
  "use strict";

  var LS_CONVS = "chatnova.convs.v1";
  var LS_SETTINGS = "chatnova.settings.v1";
  var LS_THEME = "chatnova.theme";

  var $ = function (id) { return document.getElementById(id); };
  var chatEl = $("chat"), messagesEl = $("messages"), welcomeEl = $("welcome");
  var inputEl = $("input"), sendBtn = $("send-btn"), charCount = $("char-count");
  var convListEl = $("conv-list"), convTitleEl = $("conv-title"), modelBadge = $("model-badge");
  var statusPill = $("status-pill"), setupBanner = $("setup-banner"), setupText = $("setup-text");
  var sidebar = $("sidebar"), scrim = $("scrim"), toastWrap = $("toast-wrap");

  var state = {
    convs: [],
    activeId: null,
    settings: { model: "", temperature: 0.7, max_tokens: 1024, system: "" },
    models: [],
    defaultModel: "",
    configured: false,
    streaming: false,
    abort: null,
  };

  // ---------------- storage ----------------
  function loadJSON(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full/blocked */ }
  }
  function loadConvs() {
    var raw = loadJSON(LS_CONVS, []);
    state.convs = Array.isArray(raw) ? raw.filter(function (c) {
      return c && typeof c.id === "string" && Array.isArray(c.messages);
    }) : [];
  }
  function saveConvs() { saveJSON(LS_CONVS, state.convs); }
  function loadSettings() {
    var s = loadJSON(LS_SETTINGS, {});
    if (typeof s.temperature === "number") state.settings.temperature = s.temperature;
    if (typeof s.max_tokens === "number") state.settings.max_tokens = s.max_tokens;
    if (typeof s.system === "string") state.settings.system = s.system;
    if (typeof s.model === "string") state.settings.model = s.model;
  }
  function saveSettings() { saveJSON(LS_SETTINGS, state.settings); }

  function activeConv() {
    for (var i = 0; i < state.convs.length; i++) {
      if (state.convs[i].id === state.activeId) return state.convs[i];
    }
    return null;
  }

  // ---------------- helpers ----------------
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    toastWrap.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function copyText(text, label) {
    function done() { toast(label || "Copied!"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    ta.remove();
  }
  function scrollBottom() {
    requestAnimationFrame(function () { chatEl.scrollTop = chatEl.scrollHeight; });
  }
  function setSending(on) {
    state.streaming = on;
    sendBtn.classList.toggle("stop", on);
    sendBtn.textContent = on ? "■" : "➤";
    sendBtn.setAttribute("aria-label", on ? "Stop generating" : "Send message");
  }

  // ---------------- theme ----------------
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    $("theme-toggle").textContent = (t === "dark" ? "🌙" : "☀️") + " Theme";
    try { localStorage.setItem(LS_THEME, t); } catch (e) { /* ignore */ }
  }
  $("theme-toggle").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(cur);
  });

  // ---------------- sidebar / drawer ----------------
  function openSide(o) {
    sidebar.classList.toggle("open", !!o);
    scrim.hidden = !o;
  }
  $("open-side").addEventListener("click", function () { openSide(true); });
  $("close-side").addEventListener("click", function () { openSide(false); });
  scrim.addEventListener("click", function () { openSide(false); });

  // ---------------- status ----------------
  function refreshStatus() {
    statusPill.textContent = "CHECKING…";
    statusPill.className = "status-pill";
    return fetch("/api/status").then(function (r) { return r.json(); }).then(function (d) {
      state.configured = !!d.configured;
      state.models = Array.isArray(d.models) ? d.models : [];
      state.defaultModel = d.model || "";
      if (!state.settings.model || !state.models.some(function (m) { return m.id === state.settings.model; })) {
        state.settings.model = state.defaultModel;
      }
      modelBadge.textContent = shortModel(state.settings.model);
      fillModelSelect();
      if (d.configured) {
        statusPill.textContent = "READY";
        statusPill.classList.add("ok");
        setupBanner.hidden = true;
        $("settings-status").textContent = "Status: ready — key loaded from the server .env file.";
      } else {
        statusPill.textContent = "NO KEY";
        statusPill.classList.add("bad");
        setupBanner.hidden = false;
        setupText.textContent = d.message || "Add your Groq API key to start chatting.";
        $("settings-status").textContent = "Status: no Groq key on the server yet. See the key guide below.";
      }
    }).catch(function () {
      statusPill.textContent = "OFFLINE";
      statusPill.classList.add("bad");
    });
  }
  function shortModel(id) {
    var m = state.models.filter(function (x) { return x.id === id; })[0];
    return m ? m.label.split("·")[0].trim() : (id || "AI");
  }
  $("setup-help").addEventListener("click", function () { openSettings(true); });

  // ---------------- conversations ----------------
  function newConversation(switchTo) {
    var c = { id: ChatLib.uid(), title: "New conversation", messages: [], updatedAt: Date.now() };
    state.convs.unshift(c);
    state.activeId = c.id;
    saveConvs();
    renderAll();
    if (switchTo !== false) { inputEl.focus(); }
    openSide(false);
    return c;
  }
  function renderSidebar() {
    convListEl.innerHTML = "";
    if (!state.convs.length) {
      var p = document.createElement("p");
      p.className = "conv-empty";
      p.textContent = "No chats yet — start one below.";
      convListEl.appendChild(p);
      return;
    }
    state.convs.forEach(function (c) {
      var item = document.createElement("div");
      item.className = "conv-item" + (c.id === state.activeId ? " active" : "");
      var name = document.createElement("span");
      name.className = "conv-name";
      name.textContent = c.title || "Untitled chat";
      name.title = c.title || "";
      item.appendChild(name);
      var ren = document.createElement("button");
      ren.className = "conv-act"; ren.type = "button"; ren.textContent = "✎"; ren.title = "Rename";
      ren.setAttribute("aria-label", "Rename conversation");
      ren.addEventListener("click", function (e) { e.stopPropagation(); startRename(c, item, name); });
      var del = document.createElement("button");
      del.className = "conv-act"; del.type = "button"; del.textContent = "🗑"; del.title = "Delete";
      del.setAttribute("aria-label", "Delete conversation");
      del.addEventListener("click", function (e) { e.stopPropagation(); deleteConv(c); });
      item.appendChild(ren); item.appendChild(del);
      item.addEventListener("click", function () {
        if (state.streaming) { toast("Wait for the reply to finish first."); return; }
        state.activeId = c.id;
        saveConvs(); renderAll(); openSide(false);
      });
      convListEl.appendChild(item);
    });
  }
  function startRename(c, item, nameEl) {
    var inp = document.createElement("input");
    inp.className = "conv-name-input";
    inp.value = c.title || "";
    inp.maxLength = 80;
    inp.setAttribute("aria-label", "Conversation name");
    item.replaceChild(inp, nameEl);
    inp.focus(); inp.select();
    function commit(save) {
      if (save && inp.value.trim()) { c.title = inp.value.trim().slice(0, 80); c.updatedAt = Date.now(); saveConvs(); }
      renderAll();
    }
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
    inp.addEventListener("blur", function () { commit(true); });
  }
  function deleteConv(c) {
    if (!window.confirm('Delete "' + (c.title || "Untitled chat") + '"? This cannot be undone.')) return;
    state.convs = state.convs.filter(function (x) { return x.id !== c.id; });
    if (state.activeId === c.id) state.activeId = state.convs.length ? state.convs[0].id : null;
    if (!state.convs.length) newConversation(false);
    saveConvs(); renderAll();
    toast("Conversation deleted.");
  }
  $("new-chat").addEventListener("click", function () { newConversation(true); });

  // ---------------- messages ----------------
  function renderMessages() {
    messagesEl.innerHTML = "";
    var conv = activeConv();
    var has = conv && conv.messages.length;
    welcomeEl.style.display = has ? "none" : "";
    convTitleEl.textContent = conv ? (conv.title || "New conversation") : "New conversation";
    if (!conv) return;
    conv.messages.forEach(function (m, idx) {
      messagesEl.appendChild(buildMsgEl(conv, m, idx));
    });
    scrollBottom();
  }
  function renderAll() { renderSidebar(); renderMessages(); }

  function buildMsgEl(conv, m, idx) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + (m.role === "user" ? "user" : "assistant");
    var row = document.createElement("div");
    row.className = "msg-row";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (m.role === "user") {
      bubble.textContent = m.content;
    } else {
      bubble.innerHTML = ChatLib.renderMarkdown(m.content);
    }
    row.appendChild(bubble);
    var meta = document.createElement("div");
    meta.className = "msg-meta";
    function mini(label, title, fn) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "mini-btn"; b.textContent = label; b.title = title;
      b.addEventListener("click", fn);
      meta.appendChild(b);
      return b;
    }
    mini("⧉ Copy", "Copy message", function () { copyText(m.content, "Message copied!"); });
    if (m.role === "assistant" && idx === conv.messages.length - 1) {
      mini("↻ Regenerate", "Regenerate response", function () { regenerate(); });
    }
    wrap.appendChild(row); wrap.appendChild(meta);
    return wrap;
  }

  function showError(conv, text, canRetry) {
    var wrap = document.createElement("div");
    wrap.className = "msg assistant msg-error";
    var row = document.createElement("div");
    row.className = "msg-row";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = "⚠ " + text;
    row.appendChild(bubble);
    if (canRetry) {
      var rr = document.createElement("div");
      rr.className = "retry-row";
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn btn-small btn-ghost"; btn.textContent = "↻ Retry";
      btn.addEventListener("click", function () { wrap.remove(); regenerate(); });
      rr.appendChild(btn);
      row.appendChild(rr);
    }
    wrap.appendChild(row);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  // copy-code delegation (buttons are rendered inside markdown HTML)
  messagesEl.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-copycode]") : null;
    if (!btn) return;
    var pre = btn.closest(".codeblock");
    var code = pre ? pre.querySelector("code") : null;
    if (code) copyText(code.textContent, "Code copied!");
  });

  // ---------------- sending ----------------
  function payloadFor(conv) {
    return {
      messages: conv.messages.map(function (m) { return { role: m.role, content: m.content }; }),
      model: state.settings.model,
      temperature: state.settings.temperature,
      max_tokens: state.settings.max_tokens,
      system: state.settings.system,
    };
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text) { toast("Type a message first."); return; }
    if (state.streaming) return;
    var conv = activeConv() || newConversation(false);
    if (!state.configured) {
      showError(conv, "No Groq API key on the server yet. See Settings → key guide, add the key, restart, then retry.", false);
      return;
    }
    conv.messages.push({ role: "user", content: text.slice(0, 6000) });
    if (conv.messages.length === 1 || (conv.title || "") === "New conversation") {
      conv.title = ChatLib.titleFrom(conv.messages);
    }
    conv.updatedAt = Date.now();
    inputEl.value = "";
    autogrow(); updateCount();
    saveConvs(); renderAll();
    streamReply(conv);
  }

  function regenerate() {
    var conv = activeConv();
    if (!conv || state.streaming) return;
    // drop trailing assistant message(s), keep ending on user
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") {
      conv.messages.pop();
    }
    if (!conv.messages.length || conv.messages[conv.messages.length - 1].role !== "user") {
      toast("Nothing to regenerate yet.");
      return;
    }
    saveConvs(); renderAll();
    streamReply(conv);
  }

  function streamReply(conv) {
    setSending(true);
    welcomeEl.style.display = "none";
    // placeholder assistant bubble
    var wrap = document.createElement("div");
    wrap.className = "msg assistant";
    var row = document.createElement("div");
    row.className = "msg-row";
    var bubble = document.createElement("div");
    bubble.className = "bubble streaming";
    row.appendChild(bubble);
    wrap.appendChild(row);
    messagesEl.appendChild(wrap);
    scrollBottom();

    var ctrl = new AbortController();
    state.abort = ctrl;
    var full = "";
    var settled = false;

    function finishOk() {
      if (settled) return;
      settled = true;
      setSending(false);
      state.abort = null;
      bubble.classList.remove("streaming");
      var reply = full.trim();
      if (!reply) {
        wrap.remove();
        showError(conv, "The AI answered with nothing. Try again.", true);
        return;
      }
      conv.messages.push({ role: "assistant", content: reply });
      conv.updatedAt = Date.now();
      saveConvs(); renderAll();
    }
    function finishStopped() {
      if (settled) return;
      settled = true;
      setSending(false);
      state.abort = null;
      var reply = full.trim();
      if (reply) {
        conv.messages.push({ role: "assistant", content: reply + "\n\n*(stopped)*" });
        conv.updatedAt = Date.now();
        saveConvs();
      }
      renderAll();
      toast("Stopped.");
    }
    function finishErr(msg) {
      if (settled) return;
      settled = true;
      setSending(false);
      state.abort = null;
      wrap.remove();
      showError(conv, msg, true);
    }

    fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadFor(conv)),
      signal: ctrl.signal,
    }).then(function (resp) {
      var ctype = resp.headers.get("content-type") || "";
      if (!resp.ok || ctype.indexOf("text/event-stream") === -1) {
        return resp.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d.error || ("Request failed (" + resp.status + ")."));
        });
      }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { finishOk(); return; }
          buf += decoder.decode(res.value, { stream: true });
          var parts = buf.split("\n\n");
          buf = parts.pop();
          parts.forEach(handleEvent);
          if (!settled) { bubble.innerHTML = ChatLib.renderMarkdown(full); scrollBottom(); }
          return pump();
        });
      }
      function handleEvent(chunk) {
        var lines = chunk.split("\n");
        var ev = "message", data = "";
        lines.forEach(function (ln) {
          if (ln.indexOf("event:") === 0) ev = ln.slice(6).trim();
          else if (ln.indexOf("data:") === 0) data += ln.slice(5).trim();
        });
        if (!data) return;
        var obj;
        try { obj = JSON.parse(data); } catch (e) { return; }
        if (ev === "done") { full = obj.reply || full; finishOk(); }
        else if (ev === "error") { finishErr(obj.error || "The AI service hiccuped. Try again."); }
        else if (obj.delta) { full += obj.delta; }
      }
      return pump();
    }).catch(function (err) {
      if (err && err.name === "AbortError") { finishStopped(); return; }
      finishErr((err && err.message) || "Could not reach the server. Is the app running?");
    });
  }

  sendBtn.addEventListener("click", function () {
    if (state.streaming) {
      if (state.abort) state.abort.abort();
    } else { send(); }
  });
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.querySelectorAll(".prompt").forEach(function (b) {
    b.addEventListener("click", function () {
      inputEl.value = b.textContent.trim();
      autogrow(); updateCount(); send();
    });
  });

  // composer niceties
  function autogrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }
  function updateCount() { charCount.textContent = inputEl.value.length + " / 6000"; }
  inputEl.addEventListener("input", function () { autogrow(); updateCount(); });

  // ---------------- conversation tools ----------------
  $("copy-conv").addEventListener("click", function () {
    var conv = activeConv();
    if (!conv || !conv.messages.length) { toast("Nothing to copy yet."); return; }
    copyText(ChatLib.buildExportMarkdown(conv), "Conversation copied!");
  });
  $("clear-conv").addEventListener("click", function () {
    var conv = activeConv();
    if (!conv || !conv.messages.length) { toast("Already empty."); return; }
    if (!window.confirm("Clear all messages in this conversation?")) return;
    conv.messages = [];
    conv.updatedAt = Date.now();
    saveConvs(); renderAll();
    toast("Conversation cleared.");
  });
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function safeName(title, ext) {
    var s = (title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return (s || "chat") + ext;
  }
  $("export-md").addEventListener("click", function () {
    var conv = activeConv();
    if (!conv || !conv.messages.length) { toast("Nothing to export yet."); return; }
    download(safeName(conv.title, ".md"), ChatLib.buildExportMarkdown(conv), "text/markdown");
    toast("Exported as Markdown.");
  });
  $("export-json").addEventListener("click", function () {
    var conv = activeConv();
    if (!conv || !conv.messages.length) { toast("Nothing to export yet."); return; }
    download(safeName(conv.title, ".json"), ChatLib.buildExportJSON(conv), "application/json");
    toast("Exported as JSON.");
  });
  $("import-chat").addEventListener("click", function () { $("import-file").click(); });
  $("import-file").addEventListener("change", function () {
    var f = $("import-file").files[0];
    $("import-file").value = "";
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var res = ChatLib.validateImported(reader.result);
      if (!res.ok) { toast("Import failed: " + res.error); return; }
      state.convs.unshift(res.conversation);
      state.activeId = res.conversation.id;
      saveConvs(); renderAll();
      toast("Chat imported!");
    };
    reader.readAsText(f);
  });

  // ---------------- settings ----------------
  var settingsModal = $("settings-modal");
  function fillModelSelect() {
    var sel = $("model-select");
    sel.innerHTML = "";
    state.models.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.value = state.settings.model || state.defaultModel;
  }
  function openSettings(show) {
    settingsModal.hidden = !show;
    if (show) {
      fillModelSelect();
      $("temp-range").value = state.settings.temperature;
      $("temp-val").textContent = state.settings.temperature;
      $("maxtok-range").value = state.settings.max_tokens;
      $("maxtok-val").textContent = state.settings.max_tokens;
      $("system-input").value = state.settings.system;
    }
  }
  $("open-settings").addEventListener("click", function () { openSettings(true); });
  $("open-settings-m").addEventListener("click", function () { openSettings(true); });
  $("close-settings").addEventListener("click", function () { openSettings(false); });
  settingsModal.addEventListener("click", function (e) { if (e.target === settingsModal) openSettings(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !settingsModal.hidden) openSettings(false); });
  $("temp-range").addEventListener("input", function (e) { $("temp-val").textContent = e.target.value; });
  $("maxtok-range").addEventListener("input", function (e) { $("maxtok-val").textContent = e.target.value; });
  $("save-settings").addEventListener("click", function () {
    state.settings.model = $("model-select").value || state.defaultModel;
    state.settings.temperature = parseFloat($("temp-range").value);
    state.settings.max_tokens = parseInt($("maxtok-range").value, 10);
    state.settings.system = $("system-input").value.trim().slice(0, 1000);
    saveSettings();
    modelBadge.textContent = shortModel(state.settings.model);
    openSettings(false);
    toast("Settings saved.");
  });
  $("reset-settings").addEventListener("click", function () {
    state.settings = { model: state.defaultModel, temperature: 0.7, max_tokens: 1024, system: "" };
    saveSettings();
    openSettings(true);
    modelBadge.textContent = shortModel(state.settings.model);
    toast("Settings reset.");
  });

  // ---------------- boot ----------------
  var theme = "dark";
  try { theme = localStorage.getItem(LS_THEME) || "dark"; } catch (e) { /* ignore */ }
  applyTheme(theme === "light" ? "light" : "dark");
  loadConvs();
  loadSettings();
  if (!state.convs.length) {
    state.activeId = null;
  } else {
    state.activeId = state.convs[0].id;
  }
  if (!state.activeId) {
    var c = { id: ChatLib.uid(), title: "New conversation", messages: [], updatedAt: Date.now() };
    state.convs.unshift(c);
    state.activeId = c.id;
  }
  renderAll();
  autogrow(); updateCount();
  refreshStatus();
})();
