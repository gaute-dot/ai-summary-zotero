/* global Zotero, AISummary */
"use strict";

/** The "Find papers" section in the item pane: literature search with Add to Zotero. */
AISummary.LitPane = {
  paneID: null,
  state: new Map(), // itemID (or "pinned") -> { query, source, recent, results, error, busy }

  CSS: `
.aisummary-lit { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.aisummary-lit button { font-size: 12px; }
.aisummary-lit .ail-row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.aisummary-lit .ail-row input[type=text] { flex: 1; min-width: 10em; }
.aisummary-lit .ail-status { font-size: 11px; opacity: .75; }
.aisummary-lit .ail-status.ail-error { color: #c0392b; opacity: 1; }
.aisummary-lit .ail-results { display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow-y: auto; }
.aisummary-lit .ail-card { padding: 6px 8px; border-radius: 6px; background: var(--fill-quinary, rgba(127,127,127,.10)); }
.aisummary-lit .ail-title { font-weight: 600; cursor: pointer; }
.aisummary-lit .ail-title:hover { text-decoration: underline; }
.aisummary-lit .ail-meta { font-size: 11px; opacity: .75; margin-top: 2px; }
.aisummary-lit details { font-size: 12px; margin-top: 2px; }
.aisummary-lit details summary { cursor: pointer; opacity: .8; }
.aisummary-lit .ail-badge { font-size: 11px; color: #3f6b14; font-weight: 600; }
`,

  register() {
    if (!Zotero.ItemPaneManager || !Zotero.ItemPaneManager.registerSection) return;
    const self = this;
    this.paneID = Zotero.ItemPaneManager.registerSection({
      paneID: "aisummary-lit",
      pluginID: AISummary.id,
      header: { l10nID: "aisummary-lit-header", icon: AISummary.rootURI + "icons/lit-16.svg" },
      sidenav: { l10nID: "aisummary-lit-sidenav", icon: AISummary.rootURI + "icons/lit-20.svg" },
      bodyXHTML: '<html:div class="aisummary-lit"></html:div>',
      onInit({ body, doc }) {
        body._aisummaryLit = new LitView(self, doc, body);
      },
      onDestroy({ body }) {
        body._aisummaryLit = null;
      },
      onItemChange({ item, setEnabled }) {
        setEnabled(!!AISummary.ChatPane.targetItem(item));
        return true;
      },
      onRender({ body, item }) {
        if (body._aisummaryLit) body._aisummaryLit.setItem(AISummary.ChatPane.targetItem(item));
      }
    });
  },

  unregister() {
    try {
      if (this.paneID) Zotero.ItemPaneManager.unregisterSection(this.paneID);
    } catch (e) { /* already gone */ }
    this.paneID = null;
  },

  stateFor(item) {
    const key = item ? item.id : "none";
    let st = this.state.get(key);
    if (!st) {
      st = {
        query: item ? item.getField("title") : "",
        source: AISummary.getPref("litSource") || "openalex",
        recent: false,
        results: null,
        error: "",
        status: "",
        busy: false
      };
      this.state.set(key, st);
    }
    return st;
  },

  /** Where to save new items: the selected collection in the library view, if any. */
  target(item) {
    const win = Zotero.getMainWindow();
    let libraryID = item ? item.libraryID : Zotero.Libraries.userLibraryID;
    let collectionID = null;
    try {
      const pane = win && win.ZoteroPane;
      if (pane) {
        const coll = pane.getSelectedCollection();
        if (coll && coll.libraryID === libraryID) collectionID = coll.id;
      }
    } catch (e) { /* reader tab */ }
    return { libraryID, collectionID };
  }
};

class LitView {
  constructor(pane, doc, body) {
    this.pane = pane;
    this.doc = doc;
    this.body = body;
    this.item = null;
    const style = this.el("style");
    style.textContent = pane.CSS;
    body.appendChild(style);
    this.root = this.el("div");
    this.root.style.display = "contents";
    body.appendChild(this.root);
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
    this.render();
  }

  render() {
    const LS = AISummary.LitSearch;
    const st = this.pane.stateFor(this.item);
    const wrap = this.el("div", { class: "aisummary-lit" });
    this.root.replaceChildren(wrap);
    if (AISummary.isPrivate()) {
      wrap.appendChild(this.el("div", { class: "ail-status" },
        "\uD83D\uDD12 Private mode is on, so paper search is turned off (it would send your search words to online databases). "
        + "Turn private mode off in Settings \u2192 AI Summary to use it."));
      return;
    }

    // Query
    const row = this.el("div", { class: "ail-row" });
    const input = this.el("input", { type: "text", placeholder: "Topic, title or keywords" });
    input.value = st.query;
    input.addEventListener("input", () => { st.query = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.run(st);
      }
    });
    const go = this.button(st.busy ? "Searching\u2026" : "Search", () => this.run(st));
    go.disabled = st.busy;
    row.append(input, go);
    wrap.appendChild(row);

    // Options
    const opts = this.el("div", { class: "ail-row" });
    const sel = this.el("select", { title: "Database to search" });
    for (const [id, label] of Object.entries(LS.SOURCES)) sel.appendChild(this.el("option", { value: id }, label));
    sel.value = st.source;
    sel.addEventListener("change", () => {
      st.source = sel.value;
      AISummary.setPref("litSource", sel.value);
    });
    const recentLabel = this.el("label", { title: "Only papers from the last 12 months, newest first" });
    const recent = this.el("input", { type: "checkbox" });
    recent.checked = st.recent;
    recent.addEventListener("change", () => { st.recent = recent.checked; });
    recentLabel.append(recent, this.el("span", {}, " New (last 12 months)"));
    const scholar = this.button("Google Scholar \u2197", () => Zotero.launchURL(LS.scholarURL(input.value || st.query)),
      "Open this search on Google Scholar in your browser");
    opts.append(sel, recentLabel, scholar);
    wrap.appendChild(opts);

    if (this.item && this.item.getField("title") && st.query !== this.item.getField("title")) {
      const reset = this.button("Use this item\u2019s title", () => {
        st.query = this.item.getField("title");
        this.render();
      });
      wrap.appendChild(this.el("div", { class: "ail-row" })).appendChild(reset);
    }

    const status = this.el("div", { class: "ail-status" + (st.error ? " ail-error" : "") }, st.error || st.status || "");
    wrap.appendChild(status);
    this.statusNode = status;

    if (st.results && st.results.length) {
      const actions = this.el("div", { class: "ail-row" });
      actions.appendChild(this.button("Ask AI about these results", () => this.askAI(st),
        "Send the titles and abstracts to the AI Chat and ask which are most relevant"));
      wrap.appendChild(actions);

      const list = this.el("div", { class: "ail-results" });
      st.results.forEach((r) => list.appendChild(this.card(r, st)));
      wrap.appendChild(list);
    }
  }

  card(r, st) {
    const c = this.el("div", { class: "ail-card" });
    const title = this.el("div", { class: "ail-title", title: "Open in browser" }, r.title);
    title.addEventListener("click", () => {
      if (r.url) Zotero.launchURL(r.url);
    });
    c.appendChild(title);
    const by = r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? " et al." : "");
    const meta = [by, r.year, r.venue, r.citations !== undefined && r.citations !== null ? "cited by " + r.citations : ""]
      .filter(Boolean).join(" \u00B7 ");
    c.appendChild(this.el("div", { class: "ail-meta" }, meta));
    if (r.abstract) {
      const d = this.el("details");
      d.appendChild(this.el("summary", {}, "Abstract"));
      d.appendChild(this.el("div", {}, r.abstract));
      c.appendChild(d);
    }
    const row = this.el("div", { class: "ail-row" });
    if (r.inLibrary) {
      row.appendChild(this.el("span", { class: "ail-badge" }, "\u2713 In your library"));
      row.appendChild(this.button("Show", () => AISummary.ChatPane.selectItem(r.inLibrary)));
    } else {
      const add = this.button(r.adding ? "Adding\u2026" : "Add to Zotero", async () => {
        r.adding = true;
        this.render();
        try {
          const { libraryID, collectionID } = this.pane.target(this.item);
          const item = await AISummary.LitSearch.addToZotero(r, libraryID, collectionID);
          r.inLibrary = item.id;
          st.status = "Added \u201C" + r.title + "\u201D" + (collectionID ? " to the selected collection." : " to the library.");
          st.error = "";
        } catch (e) {
          st.error = "Could not add the item: " + e.message;
        } finally {
          r.adding = false;
          this.render();
        }
      }, "Adds the item with full metadata (and an open-access PDF when available)");
      add.disabled = !!r.adding;
      row.appendChild(add);
    }
    if (r.url) row.appendChild(this.button("Open \u2197", () => Zotero.launchURL(r.url)));
    c.appendChild(row);
    return c;
  }

  async run(st) {
    if (st.busy) return;
    st.busy = true;
    st.error = "";
    st.status = "Searching " + AISummary.LitSearch.SOURCES[st.source] + "\u2026";
    this.render();
    try {
      const results = await AISummary.LitSearch.search(st.source, st.query, { recent: st.recent });
      const libraryID = this.item ? this.item.libraryID : Zotero.Libraries.userLibraryID;
      await AISummary.LitSearch.markInLibrary(libraryID, results);
      st.results = results;
      const inLib = results.filter(r => r.inLibrary).length;
      st.status = results.length
        ? results.length + " results from " + AISummary.LitSearch.SOURCES[st.source]
          + (inLib ? " \u00B7 " + inLib + " already in your library" : "")
        : "No results. Try other words or another source.";
    } catch (e) {
      st.results = null;
      st.error = e.message;
    } finally {
      st.busy = false;
      this.render();
    }
  }

  askAI(st) {
    const Chat = AISummary.Chat;
    const session = Chat.current(this.item);
    if (!session) return;
    if (session.busy) {
      st.error = "The AI Chat is busy. Try again when the current answer is finished.";
      this.render();
      return;
    }
    const text = "Here are search results for \u201C" + st.query + "\u201D:\n\n"
      + AISummary.LitSearch.resultsForPrompt(st.results)
      + "\n\nWhich of these papers are most relevant to the source(s) we are discussing, and why? "
      + "Group them by theme, refer to them as [R1], [R2] \u2026, and point out any that look especially important or that challenge the source(s).";
    const go = () => {
      Chat.send(session, text, { display: "Discuss " + st.results.length + " search results for \u201C" + st.query + "\u201D" });
      AISummary.ChatPane.reveal(this.doc.defaultView);
    };
    if (!AISummary.hasCredentials(AISummary.getSettings().provider) || (AISummary.isPrivate() && AISummary.getSettings().provider !== "local")) {
      AISummary.ensureApiKey(this.doc.defaultView).then(ok => ok && go());
    } else {
      go();
    }
  }
}

AISummary.LitView = LitView;
