/* global Zotero, AISummary */
"use strict";

const AISUMMARY_IDS = ["aisummary-separator", "aisummary-menu", "aisummary-collection-separator", "aisummary-collection-chat"];

AISummary.addToWindow = function (win) {
  const doc = win.document;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (!itemMenu || doc.getElementById("aisummary-menu")) return;
  try {
    win.MozXULElement.insertFTLIfNeeded("aisummary.ftl");
  } catch (e) {
    this.log("Could not load localisation: " + e);
  }

  const el = (tag, attrs = {}) => {
    const node = doc.createXULElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const sep = el("menuseparator", { id: "aisummary-separator" });
  const menu = el("menu", { id: "aisummary-menu", label: "AI Summary" });
  const popup = el("menupopup", { id: "aisummary-menupopup" });
  menu.appendChild(popup);

  popup.addEventListener("popupshowing", (event) => {
    if (event.target !== popup) return;
    while (popup.firstChild) popup.firstChild.remove();
    const busy = AISummary.batch.running;
    const provider = AISummary.getSettings().provider;
    const model = AISummary.getModel(provider) || "no model set";
    const defaultPreset = AISummary.getPreset();

    const add = (parent, label, onCommand, extra = {}) => {
      const mi = el("menuitem", Object.assign({ label }, extra));
      if (onCommand) mi.addEventListener("command", onCommand);
      parent.appendChild(mi);
      return mi;
    };

    add(popup, "Summarise: " + defaultPreset.name, () => AISummary.Actions.summarise(win, defaultPreset.id),
      busy ? { disabled: "true" } : {});

    const sub = el("menu", { label: "Summarise with preset" });
    if (busy) sub.setAttribute("disabled", "true");
    const subPopup = el("menupopup");
    for (const preset of AISummary.getPresets()) {
      add(subPopup, preset.name, () => AISummary.Actions.summarise(win, preset.id));
    }
    sub.appendChild(subPopup);
    popup.appendChild(sub);

    add(popup, "Ask a question…", () => AISummary.Actions.ask(win), busy ? { disabled: "true" } : {});

    if (busy) {
      popup.appendChild(el("menuseparator"));
      add(popup, "Cancel running job", () => { AISummary.batch.cancel = true; });
    }

    popup.appendChild(el("menuseparator"));
    const setup = el("menu", { label: "AI provider: " + AISummary.PROVIDER_LABELS[provider] + " \u2013 " + model });
    const setupPopup = el("menupopup");
    for (const p of AISummary.PROVIDER_IDS) {
      const hasKey = !!AISummary.getApiKey(p);
      add(setupPopup, "Use " + AISummary.PROVIDER_LABELS[p] + (hasKey ? "" : " (no API key)"), () => {
        AISummary.setPref("provider", p);
        if (!hasKey) AISummary.promptApiKey(win, p);
      }, { type: "radio", checked: p === provider ? "true" : "false" });
    }
    setupPopup.appendChild(el("menuseparator"));
    for (const p of AISummary.PROVIDER_IDS) {
      add(setupPopup, (AISummary.getApiKey(p) ? "Change " : "Enter ") + AISummary.PROVIDER_LABELS[p] + " API key\u2026",
        () => AISummary.promptApiKey(win, p));
    }
    setupPopup.appendChild(el("menuseparator"));
    add(setupPopup, "Change model for " + AISummary.PROVIDER_LABELS[provider] + "\u2026", () => AISummary.promptModel(win, provider));
    setup.appendChild(setupPopup);
    popup.appendChild(setup);
    add(popup, "Settings…", () => AISummary.openSettings());
  });

  itemMenu.appendChild(sep);
  itemMenu.appendChild(menu);

  const collectionMenu = doc.getElementById("zotero-collectionmenu");
  if (collectionMenu) {
    const csep = el("menuseparator", { id: "aisummary-collection-separator" });
    const chat = el("menuitem", { id: "aisummary-collection-chat", label: "AI Chat with this collection" });
    chat.addEventListener("command", () => AISummary.openChatForCollection(win));
    win._aisummaryCollectionListener = (event) => {
      if (event.target !== collectionMenu) return;
      const show = !!win.ZoteroPane.getSelectedCollection();
      csep.hidden = !show;
      chat.hidden = !show;
    };
    collectionMenu.addEventListener("popupshowing", win._aisummaryCollectionListener);
    collectionMenu.appendChild(csep);
    collectionMenu.appendChild(chat);
  }
  this.windows.add(win);
};

AISummary.removeFromWindow = function (win) {
  const doc = win.document;
  for (const id of AISUMMARY_IDS) {
    const node = doc.getElementById(id);
    if (node) node.remove();
  }
  const collectionMenu = doc.getElementById("zotero-collectionmenu");
  if (collectionMenu && win._aisummaryCollectionListener) {
    collectionMenu.removeEventListener("popupshowing", win._aisummaryCollectionListener);
    delete win._aisummaryCollectionListener;
  }
  const ftl = doc.querySelector('link[href="aisummary.ftl"]');
  if (ftl) ftl.remove();
  this.windows.delete(win);
};

AISummary.openSettings = function () {
  try {
    Zotero.Utilities.Internal.openPreferences(this.prefPaneID || undefined);
  } catch (e) {
    this.log("Could not open preferences: " + e);
  }
};

AISummary.openChatForSelection = function (win) {
  const { items } = this.Actions.targetItems(win);
  if (!items.length) return;
  try {
    if (items.length === 1) {
      if (this.Chat.pinned) this.Chat.unpin();
    } else {
      this.Chat.startPinned(items, { label: items.length + " selected items", kind: "items" });
      win.ZoteroPane.selectItem(items[0].id);
    }
    this.ChatPane.reveal(win);
  } catch (e) {
    this.alert(win, e.message);
  }
};

AISummary.openChatForCollection = function (win) {
  const collection = win.ZoteroPane.getSelectedCollection();
  if (!collection) return;
  const items = collection.getChildItems(false).filter(i => i.isRegularItem());
  if (!items.length) {
    this.alert(win, "\u201C" + collection.name + "\u201D has no items to chat with (sub-collections are not included).");
    return;
  }
  try {
    this.Chat.startPinned(items, { label: collection.name, kind: "collection", collectionID: collection.id });
    win.ZoteroPane.selectItem(items[0].id);
    this.ChatPane.reveal(win);
  } catch (e) {
    this.alert(win, e.message);
  }
};
