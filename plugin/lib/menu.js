/* global Zotero, AISummary */
"use strict";

const AISUMMARY_IDS = ["aisummary-separator", "aisummary-menu"];

AISummary.addToWindow = function (win) {
  const doc = win.document;
  const itemMenu = doc.getElementById("zotero-itemmenu");
  if (!itemMenu || doc.getElementById("aisummary-menu")) return;

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
    add(popup, "Model: " + AISummary.PROVIDER_LABELS[provider] + " – " + model, null, { disabled: "true" });
    add(popup, "Settings…", () => AISummary.openSettings());
  });

  itemMenu.appendChild(sep);
  itemMenu.appendChild(menu);
  this.windows.add(win);
};

AISummary.removeFromWindow = function (win) {
  const doc = win.document;
  for (const id of AISUMMARY_IDS) {
    const node = doc.getElementById(id);
    if (node) node.remove();
  }
  this.windows.delete(win);
};

AISummary.openSettings = function () {
  try {
    Zotero.Utilities.Internal.openPreferences(this.prefPaneID || undefined);
  } catch (e) {
    this.log("Could not open preferences: " + e);
  }
};
