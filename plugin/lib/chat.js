/* global Zotero, AISummary */
"use strict";

/**
 * Chat sessions with one item, several items or a collection.
 *
 * A session is either tied to the item shown in the item pane, or "pinned":
 * a pinned session stays visible while the user clicks other items, which is
 * how multi-item and collection chats are shown (Zotero hides the item pane
 * when several items are selected).
 */
AISummary.Chat = {
  MAX_ITEMS: 300,
  sessions: new Map(), // itemID -> per-item session
  pinned: null,
  listeners: new Set(),
  textCache: new Map(), // itemID -> { text, source }
  nextID: 1,

  DEFAULT_SYSTEM_PROMPT: [
    "You are a research assistant helping the user understand and work with the sources provided below, which are documents from their Zotero library.",
    "",
    "Rules:",
    "- Answer from the sources. When you use information from a source, cite it by its number in square brackets, for example [1] or [2, 3].",
    "- Quote exactly when quoting, and keep numbers exact.",
    "- If the sources do not contain the answer, say so plainly. You may add general background knowledge only when it is clearly labelled as such.",
    "- When you only see excerpts, mention it if the excerpts may not be enough to answer fully.",
    "- Be concise and use Markdown formatting where it helps.",
    "- Write in {{language}}."
  ].join("\n"),

  // One topic button per line: "Label | question sent to the model".
  DEFAULT_QUICK_QUESTIONS: [
    "Summary | Summarise the main points in a few short paragraphs.",
    "Topic | What is the topic, and what research question is addressed?",
    "Background | What background and earlier research does this build on?",
    "Methods | Explain the method and data in simple terms.",
    "Findings | What are the main findings? Include the key numbers.",
    "Innovations | What is new or original compared with earlier work?",
    "Challenges | What are the limitations, weaknesses and open challenges?",
    "Outlook | What are the implications, and what future research is suggested?",
    "Compare | How do these sources agree or disagree?"
  ].join("\n"),

  /* ---------- settings ---------- */

  settings() {
    const s = AISummary.getSettings();
    const num = (key, d) => {
      const n = Number(AISummary.getPref(key));
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    s.chatContextChars = num("chatContextChars", 250000);
    s.chatRetrievalChars = num("chatRetrievalChars", 40000);
    s.chatStreaming = AISummary.getPref("chatStreaming") !== false;
    if (s.localInputChars) {
      // A local model's context is small: leave room for the conversation.
      s.chatContextChars = Math.min(s.chatContextChars, Math.floor(s.localInputChars * 0.7));
      s.chatRetrievalChars = Math.min(s.chatRetrievalChars, Math.floor(s.localInputChars * 0.5));
    }
    return s;
  },

  systemPrompt() {
    const custom = AISummary.getPref("chatSystemPrompt");
    return custom && custom.trim() ? custom : this.DEFAULT_SYSTEM_PROMPT;
  },

  /** Topic buttons: [{ label, prompt }]. Lines without "|" use the text as both. */
  quickQuestions() {
    const raw = AISummary.getPref("chatQuickQuestions");
    const text = raw && raw.trim() ? raw : this.DEFAULT_QUICK_QUESTIONS;
    return text.split("\n").map(line => line.trim()).filter(Boolean).map((line) => {
      const i = line.indexOf("|");
      if (i < 0) return { label: line, prompt: line };
      const label = line.slice(0, i).trim();
      const prompt = line.slice(i + 1).trim();
      return { label: label || prompt, prompt: prompt || label };
    });
  },


  /* ---------- sessions ---------- */

  newSession({ items, label, kind, collectionID }) {
    return {
      id: this.nextID++,
      kind, // "item" | "items" | "collection"
      label,
      itemIDs: items.map(i => i.id),
      libraryID: items[0].libraryID,
      collectionID: collectionID || null,
      messages: [], // { role, content, citations?, error?, truncated? }
      quote: "",
      busy: false,
      abort: null,
      status: "",
      docs: null,
      index: null,
      mode: null, // "full" | "excerpts"
      loading: null
    };
  },

  sessionForItem(item) {
    let s = this.sessions.get(item.id);
    if (!s) {
      s = this.newSession({ items: [item], label: item.getField("title") || "Untitled", kind: "item" });
      this.sessions.set(item.id, s);
    }
    return s;
  },

  current(item) {
    if (this.pinned) return this.pinned;
    return item ? this.sessionForItem(item) : null;
  },

  pin(session) {
    this.pinned = session;
    this.notify(null, "full");
  },

  unpin() {
    if (this.pinned && this.pinned.abort) this.pinned.abort.abort();
    this.pinned = null;
    this.notify(null, "full");
  },

  startPinned(items, { label, kind, collectionID }) {
    let list = items.filter(i => i && i.isRegularItem());
    let note = "";
    if (list.length > this.MAX_ITEMS) {
      note = "Only the first " + this.MAX_ITEMS + " of " + list.length + " items are included.";
      list = list.slice(0, this.MAX_ITEMS);
    }
    if (!list.length) throw new Error("There are no regular items to chat with.");
    const s = this.newSession({ items: list, label, kind, collectionID });
    s.status = note;
    this.pin(s);
    return s;
  },

  reset(session) {
    if (session.abort) session.abort.abort();
    session.messages = [];
    session.quote = "";
    session.status = "";
    // Re-read the sources next time, in case attachments changed.
    for (const id of session.itemIDs) this.textCache.delete(id);
    session.docs = null;
    session.index = null;
    session.mode = null;
    this.notify(session, "full");
  },

  notify(session, kind) {
    for (const fn of this.listeners) {
      try {
        fn(session, kind);
      } catch (e) {
        AISummary.log("Chat listener failed: " + e);
      }
    }
  },

  setQuote(session, text) {
    session.quote = String(text || "").trim();
    this.notify(session, "full");
  },

  /* ---------- sources ---------- */

  async ensureLoaded(session) {
    if (session.docs) return session.docs;
    if (session.loading) return session.loading;
    session.loading = (async () => {
      const settings = this.settings();
      const items = Zotero.Items.get(session.itemIDs).filter(Boolean);
      const docs = await this.loadDocs(session, items, "Reading sources");
      const total = docs.reduce((n, d) => n + d.text.length, 0);
      session.mode = total <= settings.chatContextChars ? "full" : "excerpts";
      if (session.mode === "excerpts") session.index = AISummary.Retrieval.buildIndex(docs);
      const missing = docs.filter(d => !d.text).length;
      const parts = [];
      if (session.status && /Only the first/.test(session.status)) parts.push(session.status);
      parts.push(docs.length + (docs.length === 1 ? " source" : " sources") + ", "
        + (total < 1000 ? total + " characters" : Math.round(total / 1000) + "k characters"));
      parts.push(session.mode === "full" ? "all text is sent to the model" : "the most relevant passages are sent with each question");
      if (missing) parts.push(missing + " without full text (metadata only)");
      session.status = parts.join(" · ");
      session.docs = docs;
      return docs;
    })();
    try {
      return await session.loading;
    } finally {
      session.loading = null;
    }
  },

  /** Read text and metadata for items (cached for the Zotero session). */
  async loadDocs(session, items, verb) {
    const settings = this.settings();
    const textSettings = Object.assign({}, settings, { inputMode: "text", maxChars: Infinity });
    const docs = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (items.length > 1) {
        session.status = verb + " " + (i + 1) + " of " + items.length + "\u2026";
        this.notify(session, "status");
      }
      let cached = this.textCache.get(item.id);
      if (!cached) {
        const ctx = await AISummary.Context.collect(item, textSettings, settings.provider);
        cached = { text: ctx.text, source: ctx.source, vars: ctx.vars };
        this.textCache.set(item.id, cached);
      }
      docs.push({ index: i + 1, itemID: item.id, title: cached.vars.title || "Untitled", vars: cached.vars, text: cached.text, source: cached.source });
    }
    return docs;
  },

  /* ---------- whole library ---------- */

  LIBRARY_TOP: 20,

  startLibrary(libraryID, { pin = true } = {}) {
    const lib = Zotero.Libraries.get(libraryID);
    const s = {
      id: this.nextID++, kind: "library", label: "Whole library" + (lib && lib.name ? ": " + lib.name : ""),
      itemIDs: [], libraryID, collectionID: null, messages: [], quote: "", busy: false, abort: null,
      status: "Each question searches the library for the most relevant items.", docs: null, index: null,
      mode: "excerpts", loading: null
    };
    if (pin) this.pin(s);
    return s;
  },

  groupSessions: new Map(), // "id,id,…" -> session, for the chat window

  /** A remembered (not pinned) session for a set of items. */
  groupSession(items) {
    const list = items.filter(i => i && i.isRegularItem()).slice(0, this.MAX_ITEMS);
    const key = list.map(i => i.id).sort((a, b) => a - b).join(",");
    let s = this.groupSessions.get(key);
    if (!s) {
      s = this.newSession({ items: list, label: list.length + " selected items", kind: "items" });
      this.groupSessions.set(key, s);
    }
    return s;
  },

  /** Find the items that best match a question, using Zotero's own search (incl. full text). */
  async findLibraryItems(libraryID, query) {
    const R = AISummary.Retrieval;
    const terms = R.searchTerms(query);
    const hits = new Map();
    for (const term of terms) {
      const search = new Zotero.Search();
      search.libraryID = libraryID;
      search.addCondition("quicksearch-everything", "contains", term);
      const ids = await search.search();
      const top = new Set();
      for (const it of Zotero.Items.get(ids)) {
        if (!it) continue;
        const parent = it.isRegularItem() ? it : it.parentItem;
        if (parent && parent.isRegularItem() && !parent.deleted) top.add(parent.id);
      }
      hits.set(term, [...top]);
    }
    return R.rankByTerms(hits, this.LIBRARY_TOP);
  },

  async prepareLibrary(session, question) {
    session.status = "Searching the library\u2026";
    this.notify(session, "status");
    const ids = await this.findLibraryItems(session.libraryID, this.questionText(question));
    const items = Zotero.Items.get(ids).filter(Boolean);
    const docs = await this.loadDocs(session, items, "Reading item");
    session.docs = docs;
    session.mode = "excerpts";
    session.index = AISummary.Retrieval.buildIndex(docs);
    for (const d of docs) if (!session.itemIDs.includes(d.itemID)) session.itemIDs.push(d.itemID);
    session.status = docs.length
      ? "Answer based on the " + docs.length + " most relevant items for this question"
      : "No items in the library matched this question";
  },

  docHeader(d) {
    return "<title>" + d.title + "</title>\n<metadata>\n" + AISummary.metadataBlock(d.vars) + "\n</metadata>";
  },

  /** Build system prompt, cached documents block and message list for the next request. */
  buildRequest(session, settings) {
    const docs = session.docs || [];
    const system = AISummary.renderTemplate(this.systemPrompt(), { language: settings.language });
    let systemCached;
    const sourcesBlock = () => "<sources>\n" + docs.map(d =>
      '<source index="' + d.index + '">\n' + this.docHeader(d) + "\n</source>"
    ).join("\n") + "\n</sources>";
    if (session.kind === "library") {
      systemCached = null;
    } else if (session.mode === "full") {
      systemCached = "<documents>\n" + docs.map(d =>
        '<document index="' + d.index + '">\n' + this.docHeader(d) + "\n<content>\n"
        + (d.text || "(No full text available: only the metadata above.)") + "\n</content>\n</document>"
      ).join("\n") + "\n</documents>";
    } else {
      systemCached = "<sources>\n" + docs.map(d =>
        '<source index="' + d.index + '">\n' + this.docHeader(d) + "\n</source>"
      ).join("\n") + "\n</sources>\n\nOnly excerpts of these sources are sent, together with each question.";
    }

    const history = session.messages.filter(m => !m.error && m.content);
    const messages = history.map(m => ({ role: m.role, content: m.content }));
    if (session.mode === "excerpts" && messages.length) {
      const last = messages[messages.length - 1];
      const prevUser = history.slice(0, -1).reverse().find(m => m.role === "user");
      const query = last.content + (prevUser ? "\n" + prevUser.content : "");
      const picked = AISummary.Retrieval.select(session.index, query, settings.chatRetrievalChars);
      const excerpts = picked.map(c =>
        '<excerpt source="' + c.doc + '" title="' + String(c.title).replace(/"/g, "'") + '">\n' + c.text + "\n</excerpt>"
      ).join("\n");
      const block = "<excerpts>\n" + (excerpts || "(No matching passages were found.)") + "\n</excerpts>\n\n";
      last.content = session.kind === "library"
        ? (docs.length
          ? "These items from my Zotero library matched my question:\n" + sourcesBlock() + "\n\n" + block
          : "(No items in my library matched this question.)\n\n") + last.content
        : block + last.content;
    }
    return { system, systemCached, messages };
  },

  /* ---------- sending ---------- */

  composeUserMessage(session, text) {
    let content = String(text || "").trim();
    if (session.quote) {
      const quoted = session.quote.split("\n").map(l => "> " + l).join("\n");
      content = "About this passage:\n\n" + quoted + "\n\n" + (content || "Explain this passage.");
      session.quote = "";
    }
    return content;
  },

  /** options.display: short text shown in the chat instead of a long prompt. */
  async send(session, text, options = {}) {
    if (session.busy) return;
    if (!String(text || "").trim() && !session.quote) return;
    const settings = this.settings();
    const provider = settings.provider;
    const what = session.kind === "library"
      ? "your question and text from the best-matching items in your library"
      : "your question and the text of " + (session.itemIDs.length === 1 ? "this item" : session.itemIDs.length + " items");
    if (!AISummary.confirmSend(Zotero.getMainWindow(), provider, what)) {
      session.status = "Not sent.";
      this.notify(session, "status");
      return;
    }
    const content = this.composeUserMessage(session, text);
    if (!content) return;

    const userMsg = { role: "user", content };
    if (options.display) userMsg.display = options.display;
    session.messages.push(userMsg);
    const answer = { role: "assistant", content: "", pending: true };
    session.messages.push(answer);
    session.busy = true;
    this.notify(session, "full");

    const win = Zotero.getMainWindow();
    session.abort = win && win.AbortController ? new win.AbortController() : null;
    try {
      if (session.kind === "library") await this.prepareLibrary(session, content);
      else await this.ensureLoaded(session);
      if (session.kind === "library") {
        answer.sources = session.docs.map(d => ({ index: d.index, itemID: d.itemID, title: d.title }));
      }
      this.notify(session, "status");
      // The pending answer must not be part of the request.
      session.messages.pop();
      const req = this.buildRequest(session, settings);
      session.messages.push(answer);

      const opts = {
        model: AISummary.getModel(provider),
        apiKey: AISummary.getApiKey(provider),
        system: req.system,
        systemCached: req.systemCached,
        messages: req.messages,
        pdf: null,
        maxTokens: settings.maxTokens,
        temperature: provider === "anthropic" ? null : settings.temperature,
        effort: provider === "anthropic" ? settings.anthropicEffort || null : null
      };
      let lastPaint = 0;
      const onText = (t) => {
        answer.content = t;
        const now = Date.now();
        if (now - lastPaint > 80) {
          lastPaint = now;
          this.notify(session, "stream");
        }
      };
      const res = settings.chatStreaming
        ? await AISummary.Providers.generateStream(provider, opts, onText, session.abort && session.abort.signal)
        : await AISummary.Providers.generate(provider, opts);
      answer.content = res.text;
      answer.citations = res.citations || [];
      answer.truncated = res.truncated;
      answer.model = opts.model;
      if (!answer.content.trim()) throw new Error("The model returned an empty answer.");
    } catch (e) {
      if (e && e.name === "AbortError") {
        answer.content = answer.content || "";
        answer.stopped = true;
        if (!answer.content) answer.error = "Stopped.";
      } else {
        AISummary.log("Chat failed: " + (e && (e.stack || e)));
        answer.error = e.message || String(e);
        if (e.suggestedModel) answer.suggestedModel = e.suggestedModel;
      }
    } finally {
      answer.pending = false;
      session.busy = false;
      session.abort = null;
      this.notify(session, "full");
    }
  },

  /** Remove a failed answer and ask the same question again. */
  retryLast(session) {
    if (session.busy) return;
    const msgs = session.messages;
    if (!msgs.length || msgs[msgs.length - 1].role !== "assistant") return;
    msgs.pop();
    const user = msgs.pop();
    if (user) this.send(session, user.content, { display: user.display });
  },

  stop(session) {
    if (session.abort) session.abort.abort();
  },

  /* ---------- notes ---------- */

  sourcesHTML(session) {
    const docs = (session.kind !== "library" && session.docs) || Zotero.Items.get(session.itemIDs).filter(Boolean).map((it, i) => ({
      index: i + 1, title: it.getField("title"), vars: AISummary.Context.vars(it)
    }));
    const esc = s => AISummary.Notes.escape(s);
    return "<h2>Sources</h2>\n<ol>\n" + docs.map(d => {
      const by = [d.vars.authors && d.vars.authors.split(";")[0], d.vars.year].filter(Boolean).join(", ");
      return "<li>" + esc(d.title) + (by ? " (" + esc(by) + ")" : "") + "</li>";
    }).join("\n") + "\n</ol>\n";
  },

  turnHTML(user, answer) {
    const N = AISummary.Notes;
    let html = "<h3>" + N.escape("Question") + "</h3>\n" + N.md().render(user.content);
    html += "<h3>Answer</h3>\n" + N.md().render(answer.content || "");
    if (answer.citations && answer.citations.length) {
      html += "<p><strong>Web sources:</strong></p>\n<ol>\n" + answer.citations.map(c =>
        '<li><a href="' + N.escape(c.url) + '">' + N.escape(c.title || c.url) + "</a></li>").join("\n") + "\n</ol>\n";
    }
    return html;
  },

  /** The question without a quoted passage in front of it. */
  questionText(content) {
    return String(content).split("\n\n")
      .filter(p => p !== "About this passage:" && !p.startsWith(">"))
      .join(" ").replace(/\s+/g, " ").trim() || "Passage";
  },

  shorten(text, n) {
    text = String(text).replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
  },

  /** Save the whole chat, or one answer (by its index in session.messages). */
  async saveAsNote(session, answerIndex) {
    const N = AISummary.Notes;
    const settings = this.settings();
    const pairs = [];
    const msgs = session.messages;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== "assistant" || msgs[i].error || !msgs[i].content) continue;
      if (answerIndex !== undefined && i !== answerIndex) continue;
      const user = msgs.slice(0, i).reverse().find(m => m.role === "user");
      if (user) pairs.push([user, msgs[i]]);
    }
    if (!pairs.length) throw new Error("There is nothing to save yet.");

    const single = answerIndex !== undefined;
    const title = single
      ? "AI Chat · " + this.shorten(this.questionText(pairs[0][0].content), 80)
      : "AI Chat · " + this.shorten(session.label, 80) + " · " + new Date().toLocaleDateString();
    const model = AISummary.getModel(settings.provider);
    let html = "<h1>" + N.escape(title) + "</h1>\n";
    if (session.itemIDs.length > 1) html += this.sourcesHTML(session);
    html += pairs.map(([u, a]) => this.turnHTML(u, a)).join("\n<hr>\n");
    if (settings.addFooter) {
      html += "<hr>\n<p><em>" + N.escape("Chat with " + AISummary.PROVIDER_LABELS[settings.provider] + " (" + model + ") on "
        + new Date().toLocaleString() + ". AI-generated – verify against the sources.") + "</em></p>\n";
    }
    html = '<div data-schema-version="9">' + html + "</div>";

    const items = Zotero.Items.get(session.itemIDs).filter(Boolean);
    const note = new Zotero.Item("note");
    note.libraryID = session.libraryID;
    if (items.length === 1) note.parentID = items[0].id;
    else if (session.collectionID) note.addToCollection(session.collectionID);
    note.setNote(html);
    for (const tag of N.tagsFor(settings, settings.provider, model)) note.addTag(tag);
    if (items.length > 1) {
      for (const it of items) note.addRelatedItem(it);
    }
    await note.saveTx();
    if (items.length > 1) {
      for (const it of items) {
        if (it.addRelatedItem(note)) await it.saveTx();
      }
    }
    return note;
  }
};
