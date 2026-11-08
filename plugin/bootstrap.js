/* global Zotero, Services, IOUtils, PathUtils, Components */
"use strict";

var scope = null;
var chromeHandle = null;

const FILES = [
  "lib/vendor/markdown-it.min.js",
  "lib/core.js",
  "lib/providers.js",
  "lib/context.js",
  "lib/retrieval.js",
  "lib/notes.js",
  "lib/actions.js",
  "lib/chat.js",
  "lib/chatpane.js",
  "lib/chatwindow.js",
  "lib/litsearch.js",
  "lib/litpane.js",
  "lib/menu.js"
];

function install() {}

async function startup({ id, version, rootURI }) {
  // Lets the chat window be opened as chrome://aisummary/content/chatWindow.xhtml
  try {
    const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Components.interfaces.amIAddonManagerStartup);
    const manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "aisummary", rootURI + "content/"]]);
  } catch (e) {
    Zotero.logError(e);
  }
  scope = {
    Zotero,
    Services,
    IOUtils,
    PathUtils,
    Cc: Components.classes,
    Ci: Components.interfaces,
    pluginID: id,
    pluginVersion: version,
    rootURI
  };
  for (const file of FILES) {
    Services.scriptloader.loadSubScript(rootURI + file, scope);
  }
  await scope.AISummary.startup();
}

function onMainWindowLoad({ window }) {
  if (scope) scope.AISummary.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (scope) scope.AISummary.removeFromWindow(window);
}

function shutdown() {
  if (!scope) return;
  scope.AISummary.shutdown();
  scope = null;
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
