/* global Zotero, AISummary */
"use strict";

/**
 * A separate, resizable chat window, opened from the toolbar icon next to
 * Zotero's search box (or the AI Summary menu). It chats with the selected
 * item(s) or the open PDF, and follows the selection when it gets focus.
 */
AISummary.ChatWindow = {
  URL: "chrome://aisummary/content/chatWindow.xhtml",
  win: null,
  view: null,

  open(mainWin) {
    mainWin = mainWin || Zotero.getMainWindow();
    if (this.win && !this.win.closed) {
      this.win.focus();
      if (this.view) this.view.followSelection(true);
      return this.win;
    }
    const w = mainWin.openDialog(this.URL, "aisummary-chat-window",
      "chrome,resizable,centerscreen,dialog=no,width=560,height=780");
    this.win = w;
    w.addEventListener("load", () => {
      const root = w.document.getElementById("root");
      this.view = new ChatWindowView(w.document, root);
      w.addEventListener("focus", () => this.view && this.view.followSelection(false));
    }, { once: true });
    w.addEventListener("unload", () => {
      if (this.view) this.view.destroy();
      this.view = null;
      this.win = null;
    }, { once: true });
    return w;
  },

  close() {
    if (this.win && !this.win.closed) this.win.close();
    this.win = null;
    this.view = null;
  },

  /** Items to chat with: the open PDF's item in a reader tab, else the library selection. */
  currentTarget() {
    const win = Zotero.getMainWindow();
    if (!win) return { items: [] };
    try {
      const tabs = win.Zotero_Tabs;
      if (tabs && tabs.selectedType && tabs.selectedType !== "library" && Zotero.Reader) {
        const reader = Zotero.Reader.getByTabID(tabs.selectedID);
        const att = reader && Zotero.Items.get(reader.itemID);
        const parent = att && (att.isRegularItem() ? att : att.parentItem);
        if (parent) return { items: [parent], fromReader: true };
      }
    } catch (e) {
      AISummary.log("Could not read the open PDF tab: " + e);
    }
    try {
      return { items: AISummary.Actions.targetItems(win).items };
    } catch (e) {
      return { items: [] };
    }
  }
};

class ChatWindowView extends AISummary.ChatView {
  constructor(doc, root) {
    super(AISummary.ChatPane, doc, root);
    this.mode = "selection"; // or "library"
    this.target = null; // session for the current selection
    this.librarySession = null;
    this.followSelection(true);
  }

  currentSession() {
    return this.mode === "library" ? this.librarySession : this.target;
  }

  /** Point the chat at the current selection (unless a library chat is shown or an answer is running). */
  followSelection(force) {
    if (this.mode !== "selection") return;
    if (!force && this.target && this.target.busy) return;
    const { items } = AISummary.ChatWindow.currentTarget();
    let next = null;
    if (items.length === 1) next = AISummary.Chat.sessionForItem(items[0]);
    else if (items.length > 1) next = AISummary.Chat.groupSession(items);
    if (next !== this.target || force) {
      this.target = next;
      this.item = items[0] || null;
      this.session = null;
      this.render("full");
    }
  }

  setLibraryMode(on) {
    if (on) {
      if (!this.librarySession) {
        const libraryID = (this.item && this.item.libraryID) || Zotero.Libraries.userLibraryID;
        this.librarySession = AISummary.Chat.startLibrary(libraryID, { pin: false });
      }
      this.mode = "library";
    } else {
      this.mode = "selection";
      this.followSelection(true);
    }
    this.session = null;
    this.render("full");
  }

  render(kind) {
    if (!this.currentSession()) {
      const wrap = this.el("div", { class: "aisummary-chat" });
      this.root.replaceChildren(wrap);
      this.buildHeader(wrap, null);
      wrap.appendChild(this.el("div", { class: "ais-empty" },
        "Select one or more items in Zotero (or open a PDF), then click this window – or tick “Whole library”."));
      this.session = null;
      return;
    }
    super.render(kind);
  }

  buildHeader(wrap, session) {
    const head = this.el("div", { class: "aisw-head" });

    // What we are chatting with
    let title;
    if (!session) title = "No item selected";
    else if (session.kind === "library") title = "🔎 " + session.label;
    else if (session.itemIDs.length === 1) title = "📄 " + session.label;
    else title = "📚 " + session.itemIDs.length + " items";
    head.appendChild(this.el("div", { class: "aisw-title" }, title));

    // Mode
    const modes = this.el("div", { class: "aisw-row" });
    const radio = (value, label) => {
      const l = this.el("label");
      const r = this.el("input", { type: "radio", name: "aisw-mode", value });
      r.checked = this.mode === value;
      r.disabled = !!(session && session.busy);
      r.addEventListener("change", () => this.setLibraryMode(value === "library"));
      l.append(r, this.el("span", {}, label));
      return l;
    };
    modes.append(radio("selection", "Selected item(s) / open PDF"), radio("library", "Whole library"));
    if (this.mode === "selection") {
      modes.appendChild(this.button("↻ Use current selection", () => this.followSelection(true),
        "Switch to the item(s) selected in Zotero or the PDF that is open"));
    }
    head.appendChild(modes);

    // Provider and model
    const pm = this.el("div", { class: "aisw-row" });
    const settings = AISummary.getSettings();
    const provSel = this.el("select", { title: "AI provider" });
    for (const p of AISummary.PROVIDER_IDS) {
      provSel.appendChild(this.el("option", { value: p }, AISummary.PROVIDER_LABELS[p] + (AISummary.getApiKey(p) ? "" : " (no key)")));
    }
    provSel.value = settings.provider;
    provSel.addEventListener("change", async () => {
      AISummary.setPref("provider", provSel.value);
      if (!AISummary.getApiKey(provSel.value)) await AISummary.promptApiKey(this.doc.defaultView, provSel.value);
      this.render("full");
    });
    const current = AISummary.getModel(settings.provider);
    const models = AISummary.getModelCache(settings.provider);
    const modelSel = this.el("select", { title: "Model" });
    if (current && !models.includes(current)) modelSel.appendChild(this.el("option", { value: current }, current));
    for (const m of models) modelSel.appendChild(this.el("option", { value: m }, m));
    modelSel.appendChild(this.el("option", { value: "__more__" }, "More models…"));
    modelSel.value = current || "__more__";
    modelSel.addEventListener("change", async () => {
      if (modelSel.value === "__more__") {
        await AISummary.promptModel(this.doc.defaultView, settings.provider);
      } else {
        AISummary.setPref("model." + settings.provider, modelSel.value);
      }
      this.render("full");
    });
    pm.append(this.el("span", {}, "Model:"), provSel, modelSel);
    head.appendChild(pm);

    wrap.appendChild(head);
  }
}

AISummary.ChatWindowView = ChatWindowView;
