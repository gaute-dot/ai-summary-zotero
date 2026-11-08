/* global Zotero, Services, IOUtils, PathUtils, Components */
"use strict";

var scope = null;

const FILES = [
  "lib/vendor/markdown-it.min.js",
  "lib/core.js",
  "lib/providers.js",
  "lib/context.js",
  "lib/notes.js",
  "lib/actions.js",
  "lib/menu.js"
];

function install() {}

async function startup({ id, version, rootURI }) {
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
}

function uninstall() {}
