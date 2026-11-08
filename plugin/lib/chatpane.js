/* global Zotero, Services, AISummary */
"use strict";

/**
 * The "AI Chat" section in Zotero's item pane (library and PDF reader), and
 * the "Ask AI" button in the reader's text-selection popup.
 */
AISummary.ChatPane = {
  paneID: null,
  readerHandler: null,

  CSS: `
.aisummary-chat { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.aisummary-chat button { font-size: 12px; }
.aisummary-chat .ais-banner { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 4px 6px; border-radius: 5px; background: var(--fill-quinary, rgba(127,127,127,.12)); }
.aisummary-chat .ais-banner .ais-label { flex: 1; font-weight: 600; min-width: 8em; }
.aisummary-chat details.ais-sources summary { cursor: pointer; opacity: .8; }
.aisummary-chat details.ais-sources ol { margin: 4px 0 0 0; padding-inline-start: 22px; max-height: 10em; overflow: auto; }
.aisummary-chat details.ais-sources li { cursor: pointer; }
.aisummary-chat details.ais-sources li:hover { text-decoration: underline; }
.aisummary-chat .ais-status { font-size: 11px; opacity: .7; }
.aisummary-chat .ais-status.ais-error { color: #c0392b; opacity: 1; }
.aisummary-chat .ais-messages { display: flex; flex-direction: column; gap: 8px; max-height: 55vh; overflow-y: auto; }
.aisummary-chat .ais-empty { opacity: .7; font-style: italic; }
.aisummary-chat .ais-msg { padding: 6px 8px; border-radius: 8px; overflow-wrap: anywhere; }
.aisummary-chat .ais-msg.user { align-self: flex-end; max-width: 92%; white-space: pre-wrap;
  background: var(--accent-blue10, rgba(64,114,229,.14)); }
.aisummary-chat .ais-msg.assistant { background: var(--fill-quinary, rgba(127,127,127,.10)); }
.aisummary-chat .ais-msg.assistant > .ais-body > :first-child { margin-top: 0; }
.aisummary-chat .ais-msg.assistant > .ais-body > :last-child { margin-bottom: 0; }
.aisummary-chat .ais-msg.assistant table { border-collapse: collapse; }
.aisummary-chat .ais-msg.assistant td, .aisummary-chat .ais-msg.assistant th { border: 1px solid rgba(127,127,127,.4); padding: 2px 4px; }
.aisummary-chat .ais-msg.error { color: #c0392b; }
.aisummary-chat .ais-msg .ais-actions { display: flex; gap: 4px; margin-top: 4px; opacity: .8; }
.aisummary-chat .ais-msg .ais-note { font-size: 11px; opacity: .7; margin-top: 4px; }
.aisummary-chat .ais-cite { color: var(--accent-blue, #4072e5); cursor: pointer; }
.aisummary-chat .ais-quick { display: flex; flex-wrap: wrap; gap: 4px; }
.aisummary-chat .ais-quick button { border-radius: 10px; padding: 1px 8px; }
.aisummary-chat .ais-quote { display: flex; gap: 6px; align-items: flex-start; padding: 4px 6px; border-inline-start: 3px solid var(--accent-blue, #4072e5);
  background: var(--fill-quinary, rgba(127,127,127,.10)); font-style: italic; max-height: 8em; overflow: auto; white-space: pre-wrap; }
.aisummary-chat .ais-quote span { flex: 1; }
.aisummary-chat textarea { width: 100%; box-sizing: border-box; min-height: 4.5em; resize: vertical; font: inherit; }
.aisummary-chat .ais-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.aisummary-chat .ais-row .ais-spacer { flex: 1; }
.aisummary-chat .ais-pending::after { content: "\\2026"; animation: ais-blink 1s infinite; }
@keyframes ais-blink { 50% { opacity: .2; } }
`,

  /* ---------- registration ---------- */

  register() {
    if (!Zotero.ItemPaneManager || !Zotero.ItemPaneManager.registerSection) {
      AISummary.log("ItemPaneManager not available; chat panel disabled.");
      return;
    }
    const self = this;
    this.paneID = Zotero.ItemPaneManager.registerSection({
      paneID: "aisummary-chat",
      pluginID: AISummary.id,
      header: { l10nID: "aisummary-chat-header", icon: AISummary.rootURI + "icons/chat-16.svg" },
      sidenav: { l10nID: "aisummary-chat-sidenav", icon: AISummary.rootURI + "icons/chat-20.svg" },
      bodyXHTML: '<html:div class="aisummary-chat"></html:div>',
      onInit({ body, doc }) {
        body._aisummary = new ChatView(self, doc, body);
      },
      onDestroy({ body }) {
        if (body._aisummary) body._aisummary.destroy();
        body._aisummary = null;
      },
      onItemChange({ item, setEnabled }) {
        setEnabled(!!self.targetItem(item) || !!AISummary.Chat.pinned);
        return true;
      },
      onRender({ body, item }) {
        if (body._aisummary) body._aisummary.setItem(self.targetItem(item));
      }
    });

    this.readerHandler = (event) => this.onReaderSelection(event);
    try {
      Zotero.Reader.registerEventListener("renderTextSelectionPopup", this.readerHandler, AISummary.id);
    } catch (e) {
      AISummary.log("Could not add reader button: " + e);
    }
  },

  unregister() {
    try {
      if (this.paneID) Zotero.ItemPaneManager.unregisterSection(this.paneID);
    } catch (e) { /* already gone */ }
    try {
      if (this.readerHandler) Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this.readerHandler);
    } catch (e) { /* already gone */ }
    this.paneID = null;
    this.readerHandler = null;
  },

  targetItem(item) {
    if (!item) return null;
    if (item.isRegularItem()) return item;
    if ((item.isAttachment() || item.isNote()) && item.parentItem) return item.parentItem;
    return null;
  },

  /** Scroll the item pane to the chat section and focus the input. */
  reveal(win) {
    win = win || Zotero.getMainWindow();
    if (!win) return;
    const doIt = () => {
      for (const details of win.document.querySelectorAll("item-details")) {
        try {
          if (details.scrollToPane) details.scrollToPane(this.paneID);
        } catch (e) { /* not visible */ }
      }
      for (const ta of win.document.querySelectorAll(".aisummary-chat textarea")) {
        if (ta.getBoundingClientRect().width > 0) {
          ta.focus();
          break;
        }
      }
    };
    win.setTimeout(doIt, 150);
  },

  selectItem(itemID) {
    const win = Zotero.getMainWindow();
    if (!win) return;
    try {
      if (win.Zotero_Tabs && win.Zotero_Tabs.selectedID !== "zotero-pane") win.Zotero_Tabs.select("zotero-pane");
      win.ZoteroPane.selectItem(itemID);
    } catch (e) {
      AISummary.log("selectItem failed: " + e);
    }
  },

  /* ---------- reader: "Ask AI" on selected text ---------- */

  onReaderSelection(event) {
    const { reader, doc, params, append } = event;
    const text = params && params.annotation && params.annotation.text;
    if (!text) return;
    const btn = doc.createElement("button");
    btn.textContent = "Ask AI";
    btn.title = "Send the selected text to AI Chat";
    btn.style.cssText = "margin: 2px 4px; padding: 2px 8px; cursor: pointer;";
    btn.addEventListener("click", () => {
      const att = Zotero.Items.get(reader.itemID);
      const parent = att && (att.isRegularItem() ? att : att.parentItem);
      const win = Zotero.getMainWindow();
      if (!parent) {
        AISummary.alert(win, "This PDF has no parent item. Right-click it in the library and choose “Create Parent Item” first.");
        return;
      }
      const Chat = AISummary.Chat;
      if (Chat.pinned && !Chat.pinned.itemIDs.includes(parent.id)) {
        const ok = Services.prompt.confirm(win, "AI Chat",
          "The pinned chat (“" + Chat.pinned.label + "”) does not include this article.\n\nClose it and ask about this article instead?");
        if (!ok) return;
        Chat.unpin();
      }
      Chat.setQuote(Chat.current(parent), text);
      this.reveal(win);
    });
    append(btn);
  }
};

/** One rendered chat panel (there can be several: library pane and reader pane). */
class ChatView {
  constructor(pane, doc, body) {
    this.pane = pane;
    this.doc = doc;
    this.body = body;
    this.item = null;
    this.session = null;
    this.listener = (session, kind) => {
      if (session && session !== this.session) return;
      if (!session && kind === "full") this.session = null; // pin state changed
      this.render(kind);
    };
    AISummary.Chat.listeners.add(this.listener);
    const style = this.el("style");
    style.textContent = pane.CSS;
    body.appendChild(style);
    this.root = this.el("div");
    this.root.style.display = "contents";
    body.appendChild(this.root);
  }

  destroy() {
    AISummary.Chat.listeners.delete(this.listener);
  }

  el(tag, attrs = {}, text) {
    const node = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  button(label, onClick, title) {
    const b = this.el("button", title ? { title } : {}, label);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick(e);
    });
    return b;
  }

  setItem(item) {
    this.item = item;
    this.session = null;
    this.render("full");
  }

  currentSession() {
    return AISummary.Chat.current(this.item);
  }

  render(kind) {
    const session = this.currentSession();
    if (!session) {
      this.root.replaceChildren(this.el("div", { class: "ais-empty" }, "Select an item to chat with it."));
      this.session = null;
      return;
    }
    if (kind === "stream" && session === this.session && this.lastBubble) {
      const msg = session.messages[session.messages.length - 1];
      this.fillAssistant(this.lastBubble, msg, session, session.messages.length - 1);
      this.scrollDown();
      return;
    }
    if (kind === "status" && session === this.session && this.statusNode) {
      this.statusNode.textContent = session.status || "";
      return;
    }
    const draft = this.input ? this.input.value : "";
    const sameSession = session === this.session;
    this.session = session;
    this.buildFull(session);
    if (sameSession && draft && this.input) this.input.value = draft;
  }

  buildFull(session) {
    const Chat = AISummary.Chat;
    const root = this.root;
    root.replaceChildren();
    const wrap = this.el("div", { class: "aisummary-chat" });
    root.appendChild(wrap);

    // Banner
    if (Chat.pinned === session) {
      const banner = this.el("div", { class: "ais-banner" });
      const n = session.itemIDs.length;
      banner.appendChild(this.el("span", { class: "ais-label" },
        "📌 " + session.label + " (" + n + (n === 1 ? " source)" : " sources)")));
      banner.appendChild(this.button("Unpin", () => Chat.unpin(), "Go back to chatting with the selected item"));
      wrap.appendChild(banner);
    }

    // Sources list for multi-source chats
    if (session.itemIDs.length > 1) {
      const details = this.el("details", { class: "ais-sources" });
      details.appendChild(this.el("summary", {}, "Sources"));
      const ol = this.el("ol");
      for (const it of Zotero.Items.get(session.itemIDs).filter(Boolean)) {
        const li = this.el("li", { title: "Show in library" }, it.getField("title") || "Untitled");
        li.addEventListener("click", () => this.pane.selectItem(it.id));
        ol.appendChild(li);
      }
      details.appendChild(ol);
      wrap.appendChild(details);
    }

    this.statusNode = this.el("div", { class: "ais-status" }, session.status || "");
    wrap.appendChild(this.statusNode);

    // Messages
    const list = this.el("div", { class: "ais-messages" });
    this.messagesNode = list;
    this.lastBubble = null;
    if (!session.messages.length) {
      list.appendChild(this.el("div", { class: "ais-empty" },
        session.itemIDs.length > 1
          ? "Ask a question across these sources. Answers cite sources as [1], [2] …"
          : "Ask anything about this item. Tip: select text in the PDF and click “Ask AI”."));
    }
    session.messages.forEach((m, i) => {
      if (m.role === "user") {
        list.appendChild(this.el("div", { class: "ais-msg user" }, m.display || m.content));
      } else {
        const bubble = this.el("div", { class: "ais-msg assistant" });
        this.fillAssistant(bubble, m, session, i);
        list.appendChild(bubble);
        this.lastBubble = bubble;
      }
    });
    wrap.appendChild(list);

    // Quick questions and presets
    const quick = this.el("div", { class: "ais-quick" });
    for (const q of Chat.quickQuestions()) {
      if (session.itemIDs.length === 1 && /these sources/i.test(q)) continue;
      const b = this.button(q, () => this.send(q));
      b.disabled = session.busy;
      quick.appendChild(b);
    }
    const presetSel = this.el("select", { title: "Run one of your summary presets in the chat" });
    presetSel.appendChild(this.el("option", { value: "" }, "Run preset…"));
    for (const p of AISummary.getPresets()) presetSel.appendChild(this.el("option", { value: p.id }, p.name));
    presetSel.disabled = session.busy;
    presetSel.addEventListener("change", () => {
      const id = presetSel.value;
      presetSel.value = "";
      if (id) this.runPreset(id);
    });
    quick.appendChild(presetSel);
    wrap.appendChild(quick);

    // Quoted passage from the PDF
    if (session.quote) {
      const q = this.el("div", { class: "ais-quote" });
      q.appendChild(this.el("span", {}, session.quote));
      q.appendChild(this.button("×", () => Chat.setQuote(session, ""), "Remove the quoted passage"));
      wrap.appendChild(q);
      const actions = this.el("div", { class: "ais-quick" });
      for (const [label, prompt] of [
        ["Explain", "Explain this passage in simple terms."],
        ["Summarise", "Summarise this passage in two or three sentences."],
        ["Translate", "Translate this passage into " + (AISummary.getSettings().language || "English") + "."],
        ["Critique", "Critically assess the claim in this passage. Is it supported by the evidence in the article?"]
      ]) {
        const b = this.button(label, () => this.send(prompt));
        b.disabled = session.busy;
        actions.appendChild(b);
      }
      wrap.appendChild(actions);
    }

    // Input
    const input = this.el("textarea", {
      placeholder: session.quote ? "Ask about the quoted passage…" : "Ask a question… (Enter to send, Shift+Enter for a new line)"
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send(input.value);
      }
    });
    this.input = input;
    wrap.appendChild(input);

    const row = this.el("div", { class: "ais-row" });
    if (session.busy) row.appendChild(this.button("Stop", () => Chat.stop(session)));
    else row.appendChild(this.button("Send", () => this.send(input.value)));
    row.appendChild(this.el("span", { class: "ais-spacer" }));
    const save = this.button("Save chat as note", () => this.save(), "Save the whole conversation as a Zotero note");
    save.disabled = session.busy || !session.messages.some(m => m.role === "assistant" && m.content && !m.error);
    row.appendChild(save);
    const reset = this.button("New chat", () => Chat.reset(session), "Clear this conversation");
    reset.disabled = session.busy || !session.messages.length;
    row.appendChild(reset);
    wrap.appendChild(row);

    this.scrollDown();
  }

  fillAssistant(bubble, m, session, index) {
    bubble.replaceChildren();
    bubble.classList.toggle("error", !!m.error && !m.content);
    const body = this.el("div", { class: "ais-body" });
    if (m.content) {
      body.innerHTML = AISummary.Notes.md().render(AISummary.Notes.cleanMarkdown(m.content));
      this.linkify(body, session);
    } else if (!m.error) {
      body.appendChild(this.el("span", { class: "ais-pending" }, session.status && session.status.startsWith("Reading") ? session.status : "Thinking"));
    }
    bubble.appendChild(body);
    if (m.citations && m.citations.length) {
      const ol = this.el("ol", { class: "ais-note" });
      for (const c of m.citations) {
        const li = this.el("li");
        const a = this.el("a", { href: c.url }, c.title || c.url);
        li.appendChild(a);
        ol.appendChild(li);
      }
      this.linkify(ol, session);
      bubble.appendChild(ol);
    }
    const notes = [];
    if (m.error) notes.push(m.error);
    if (m.stopped && m.content) notes.push("Stopped before the answer was finished.");
    if (m.truncated) notes.push("The answer hit the output token limit and may be cut off.");
    for (const n of notes) bubble.appendChild(this.el("div", { class: "ais-note" }, n));
    if (!m.pending && m.content) {
      const actions = this.el("div", { class: "ais-actions" });
      actions.appendChild(this.button("Copy", () => {
        Zotero.Utilities.Internal.copyTextToClipboard(m.content);
        this.flash("Copied.");
      }));
      actions.appendChild(this.button("Save as note", async () => {
        try {
          await AISummary.Chat.saveAsNote(session, index);
          this.flash("Saved as a note.");
        } catch (e) {
          this.flash(e.message, true);
        }
      }));
      bubble.appendChild(actions);
    }
  }

  /** Open links in the browser and make [1]-style citations clickable. */
  linkify(container, session) {
    for (const a of container.querySelectorAll("a[href]")) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        Zotero.launchURL(a.getAttribute("href"));
      });
    }
    const ids = session.itemIDs;
    const walker = this.doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    while (walker.nextNode()) {
      if (/\[\d+(?:\s*[,–-]\s*\d+)*\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      if (node.parentNode.closest && node.parentNode.closest("code, pre, a")) continue;
      const frag = this.doc.createDocumentFragment();
      const re = /\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g;
      let last = 0;
      let m;
      const text = node.nodeValue;
      while ((m = re.exec(text))) {
        frag.appendChild(this.doc.createTextNode(text.slice(last, m.index)));
        const nums = m[1].split(/\s*,\s*/).map(s => parseInt(s, 10));
        const first = nums[0];
        const span = this.el("span", { class: "ais-cite" }, m[0]);
        const itemID = ids[first - 1];
        if (itemID) {
          const it = Zotero.Items.get(itemID);
          span.title = (it && it.getField("title")) || "";
          span.addEventListener("click", () => this.pane.selectItem(itemID));
        }
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      frag.appendChild(this.doc.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  scrollDown() {
    if (this.messagesNode) this.messagesNode.scrollTop = this.messagesNode.scrollHeight;
  }

  flash(msg, isError) {
    if (!this.statusNode) return;
    const prev = this.session ? this.session.status : "";
    this.statusNode.textContent = msg;
    this.statusNode.classList.toggle("ais-error", !!isError);
    const win = this.doc.defaultView;
    win.setTimeout(() => {
      if (!this.statusNode) return;
      this.statusNode.textContent = this.session ? this.session.status || "" : prev;
      this.statusNode.classList.remove("ais-error");
    }, isError ? 8000 : 2500);
  }

  send(text) {
    const session = this.currentSession();
    if (!session || session.busy) return;
    if (!String(text || "").trim() && !session.quote) return;
    if (!AISummary.getApiKey(AISummary.getSettings().provider)) {
      AISummary.ensureApiKey(this.doc.defaultView).then((ok) => {
        if (ok) this.send(text);
      });
      return;
    }
    if (this.input) this.input.value = "";
    AISummary.Chat.send(session, text);
  }

  runPreset(id) {
    const session = this.currentSession();
    if (!session || session.busy) return;
    const preset = AISummary.getPresets().find(p => p.id === id);
    if (!preset) return;
    const first = Zotero.Items.get(session.itemIDs[0]);
    const vars = Object.assign({}, first ? AISummary.Context.vars(first) : {}, {
      language: AISummary.getSettings().language, fulltext: "", question: ""
    });
    const prompt = AISummary.renderTemplate(preset.prompt, vars);
    if (!AISummary.getApiKey(AISummary.getSettings().provider)) {
      AISummary.ensureApiKey(this.doc.defaultView).then((ok) => {
        if (ok) this.runPreset(id);
      });
      return;
    }
    AISummary.Chat.send(session, prompt).catch(e => this.flash(e.message, true));
    // Show the preset name instead of the long prompt.
    const userMsg = session.messages[session.messages.length - 2];
    if (userMsg && userMsg.role === "user") {
      userMsg.display = "Preset: " + preset.name;
      this.render("full");
    }
  }

  async save() {
    try {
      await AISummary.Chat.saveAsNote(this.currentSession());
      this.flash("Chat saved as a note.");
    } catch (e) {
      this.flash(e.message, true);
    }
  }
}

AISummary.ChatView = ChatView;
