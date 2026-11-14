/* global Zotero, document */
"use strict";

var AISummaryPrefs = {
  initialized: false,
  presets: [],
  current: null,

  get core() {
    return Zotero.AISummary;
  },

  $(id) {
    return document.getElementById(id);
  },

  html(tag, attrs = {}, text) {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  },

  status(msg, isError) {
    const node = this.$("aisummary-status");
    if (!node) return;
    node.textContent = msg || "";
    node.style.color = isError ? "#c0392b" : "";
  },

  init() {
    if (this.initialized || !this.$("aisummary-pane") || !this.core) return;
    this.initialized = true;
    const hint = this.$("aisummary-fallback-hint");
    if (hint) hint.hidden = true;
    this.buildProviderRows();
    this.bindSimplePrefs();
    this.initSystemPrompt();
    this.initPresets();
  },

  /* ---------- simple data-pref bindings ---------- */

  bindSimplePrefs() {
    const core = this.core;
    for (const node of document.querySelectorAll("#aisummary-pane [data-pref]")) {
      const key = node.getAttribute("data-pref");
      if (key === "defaultPreset") continue; // handled with presets
      const value = core.getPref(key);
      if (node.type === "checkbox") node.checked = !!value;
      else node.value = value === undefined || value === null ? "" : String(value);
      const save = () => {
        let v;
        if (node.type === "checkbox") v = node.checked;
        else if (node.getAttribute("data-type") === "int") {
          v = parseInt(node.value, 10);
          if (!Number.isFinite(v) || v < 0) return;
        } else v = node.value;
        core.setPref(key, v);
      };
      node.addEventListener(node.type === "checkbox" || node.localName === "select" ? "change" : "input", save);
    }
  },

  /* ---------- providers ---------- */

  buildProviderRows() {
    const core = this.core;
    const tbody = this.$("aisummary-provider-rows");
    for (const p of core.PROVIDER_IDS) {
      const tr = this.html("tr");

      tr.appendChild(this.html("td", { style: "white-space: nowrap;" }, core.PROVIDER_LABELS[p]));

      const keyTd = this.html("td");
      if (p === "local" || p === "custom") this.serverFields(p, keyTd);
      const keyWrap = this.html("div", { style: "display: flex; gap: 4px;" });
      const key = this.html("input", { type: "password", id: "aisummary-key-" + p, placeholder: "API key", style: "flex: 1; min-width: 10em;" });
      key.value = core.getApiKey(p);
      key.addEventListener("change", async () => {
        await core.setApiKey(p, key.value);
        this.status(core.PROVIDER_LABELS[p] + " key saved.");
      });
      const show = this.html("button", { title: "Show or hide the key" }, "Show");
      show.addEventListener("click", () => {
        key.type = key.type === "password" ? "text" : "password";
        show.textContent = key.type === "password" ? "Show" : "Hide";
      });
      keyWrap.append(key, show);
      if (p === "local") keyWrap.hidden = true; // no key needed
      if (p === "custom") key.placeholder = "API key (if the service needs one)";
      keyTd.appendChild(keyWrap);
      tr.appendChild(keyTd);

      const modelTd = this.html("td");
      const select = this.html("select", { id: "aisummary-model-select-" + p, style: "width: 100%; min-width: 12em;" });
      const model = this.html("input", {
        type: "text", id: "aisummary-model-" + p, placeholder: "Type a model name",
        style: "width: 100%; min-width: 12em; margin-top: 2px;"
      });
      model.value = core.getModel(p);
      model.addEventListener("input", () => core.setPref("model." + p, model.value.trim()));
      select.addEventListener("change", () => {
        if (select.value === this.OTHER) {
          model.hidden = false;
          model.focus();
          return;
        }
        model.value = select.value;
        model.hidden = true;
        core.setPref("model." + p, select.value);
        this.status(core.PROVIDER_LABELS[p] + " model set to " + select.value + ".");
      });
      modelTd.append(select, model);
      tr.appendChild(modelTd);
      this.fillModelSelect(p, select, model);

      const btnTd = this.html("td", { style: "white-space: nowrap;" });
      const fetchBtn = this.html("button", {}, "Fetch models");
      fetchBtn.addEventListener("click", () => this.fetchModels(p, key, select, model, fetchBtn, false));
      const testBtn = this.html("button", {}, "Test");
      testBtn.addEventListener("click", () => this.testProvider(p, key, model, testBtn));
      btnTd.append(fetchBtn, testBtn);
      tr.appendChild(btnTd);

      tbody.appendChild(tr);

      // Load the list in the background the first time a key is available.
      if ((key.value || p === "local") && !core.getModelCache(p).length) {
        this.fetchModels(p, key, select, model, fetchBtn, true);
      }
      key.addEventListener("change", () => {
        if (key.value.trim()) this.fetchModels(p, key, select, model, fetchBtn, true);
      });
    }
  },

  /** Server address and options for the local and custom providers. */
  serverFields(p, td) {
    const core = this.core;
    const box = this.html("div", { style: "display: flex; flex-direction: column; gap: 3px; margin-bottom: 3px;" });
    const text = (pref, placeholder, width) => {
      const input = this.html("input", { type: "text", placeholder, style: "min-width: " + (width || "14em") + ";" });
      input.value = core.getPref(pref) || "";
      input.addEventListener("input", () => core.setPref(pref, input.value.trim()));
      return input;
    };
    if (p === "local") {
      const row = this.html("div", { style: "display: flex; gap: 4px; align-items: center; flex-wrap: wrap;" });
      const server = this.html("select", { title: "Which app runs the model" });
      server.appendChild(this.html("option", { value: "ollama" }, "Ollama"));
      server.appendChild(this.html("option", { value: "lmstudio" }, "LM Studio"));
      server.value = core.getPref("localServer") || "ollama";
      const url = text("localBaseURL", "", "12em");
      const setPlaceholder = () => {
        url.placeholder = server.value === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1";
      };
      setPlaceholder();
      server.addEventListener("change", () => {
        core.setPref("localServer", server.value);
        setPlaceholder();
      });
      row.append(server, url);
      const ctxRow = this.html("div", { style: "display: flex; gap: 4px; align-items: center;" });
      const ctx = this.html("input", { type: "number", min: "2048", step: "1024", style: "max-width: 7em;",
        title: "How much text the model can handle at once. In LM Studio, use the same value when loading the model." });
      ctx.value = String(core.getPref("localContextTokens") || 32768);
      ctx.addEventListener("input", () => {
        const n = parseInt(ctx.value, 10);
        if (n >= 2048) core.setPref("localContextTokens", n);
      });
      ctxRow.append(this.html("span", { style: "font-size: 11px; opacity: .8;" }, "Context length (tokens):"), ctx);
      box.append(row, ctxRow);
    } else {
      const url = text("customBaseURL", "https://ai.example.ac.uk/v1", "16em");
      const auth = this.html("select", { title: "How the key is sent" });
      auth.appendChild(this.html("option", { value: "authorization" }, "Key as Bearer token"));
      auth.appendChild(this.html("option", { value: "api-key" }, "Key as api-key header (Azure)"));
      auth.value = core.getPref("customAuthHeader") || "authorization";
      auth.addEventListener("change", () => core.setPref("customAuthHeader", auth.value));
      box.append(url, auth);
    }
    td.appendChild(box);
  },

  OTHER: "__other__",

  /** Dropdown of known models, plus the current one and "Other…". */
  fillModelSelect(p, select, model) {
    const core = this.core;
    const current = core.getModel(p);
    const list = core.getModelCache(p);
    while (select.firstChild) select.firstChild.remove();
    if (current && !list.includes(current)) {
      select.appendChild(this.html("option", { value: current }, current + (list.length ? " (not in fetched list)" : "")));
    }
    for (const id of list) select.appendChild(this.html("option", { value: id }, id));
    select.appendChild(this.html("option", { value: this.OTHER }, "Other (type a name)\u2026"));
    select.value = current || this.OTHER;
    model.hidden = !!current;
  },

  async fetchModels(p, keyInput, select, model, btn, quiet) {
    const core = this.core;
    const apiKey = keyInput.value.trim();
    if (!apiKey && core.needsKey(p)) {
      if (!quiet) this.status("Enter the " + core.PROVIDER_LABELS[p] + " API key first.", true);
      return;
    }
    btn.disabled = true;
    if (!quiet) this.status("Fetching models from " + core.PROVIDER_LABELS[p] + "\u2026");
    try {
      const ids = await core.Providers.listModels(p, apiKey);
      core.setModelCache(p, ids);
      this.fillModelSelect(p, select, model);
      this.status(ids.length + " models found for " + core.PROVIDER_LABELS[p] + ". Pick one from the dropdown.");
    } catch (e) {
      Zotero.logError(e);
      if (!quiet) this.status(e.message, true);
    } finally {
      btn.disabled = false;
    }
  },

  async testProvider(p, keyInput, modelInput, btn) {
    const core = this.core;
    btn.disabled = true;
    this.status("Testing " + core.PROVIDER_LABELS[p] + " (" + modelInput.value + ")\u2026");
    try {
      const reply = await core.Providers.test(p, keyInput.value.trim(), modelInput.value.trim());
      this.status(core.PROVIDER_LABELS[p] + " works. Reply: \u201C" + reply + "\u201D");
    } catch (e) {
      this.status(e.message, true);
      if (e.suggestedModel) {
        const use = this.html("button", { style: "margin-inline-start: 8px;" }, "Use " + e.suggestedModel);
        use.addEventListener("click", () => {
          core.setPref("model." + p, e.suggestedModel);
          modelInput.value = e.suggestedModel;
          const select = this.$("aisummary-model-select-" + p);
          if (select) this.fillModelSelect(p, select, modelInput);
          this.status(core.PROVIDER_LABELS[p] + " model set to " + e.suggestedModel + ". Press Test again to check it.");
        });
        this.$("aisummary-status").appendChild(use);
      }
    } finally {
      btn.disabled = false;
    }
  },

  /* ---------- system prompt ---------- */

  initSystemPrompt() {
    const core = this.core;
    this.bindDefaultable("aisummary-systemPrompt", "systemPrompt", core.DEFAULT_SYSTEM_PROMPT);
    this.bindDefaultable("aisummary-chatSystemPrompt", "chatSystemPrompt", core.Chat.DEFAULT_SYSTEM_PROMPT);
    this.bindDefaultable("aisummary-chatQuickQuestions", "chatQuickQuestions", core.Chat.DEFAULT_QUICK_QUESTIONS);
  },

  /** A textarea whose pref is stored empty while it equals the built-in default. */
  bindDefaultable(id, prefKey, defaultText) {
    const core = this.core;
    const ta = this.$(id);
    if (!ta) return;
    const stored = core.getPref(prefKey);
    ta.value = stored && stored.trim() ? stored : defaultText;
    ta.addEventListener("input", () => {
      core.setPref(prefKey, ta.value.trim() === defaultText.trim() ? "" : ta.value);
    });
    const reset = this.$(id + "-reset");
    if (reset) {
      reset.addEventListener("click", () => {
        core.setPref(prefKey, "");
        ta.value = defaultText;
      });
    }
  },

  /* ---------- presets ---------- */

  initPresets() {
    this.presets = this.core.getPresets();
    this.current = this.presets[0] ? this.presets[0].id : null;

    this.$("aisummary-preset-list").addEventListener("change", (e) => {
      this.current = e.target.value;
      this.showPreset();
    });
    this.$("aisummary-preset-name").addEventListener("input", (e) => {
      const p = this.find();
      if (!p) return;
      p.name = e.target.value.trim() || "Untitled";
      this.save();
      this.renderLists();
    });
    this.$("aisummary-preset-prompt").addEventListener("input", (e) => {
      const p = this.find();
      if (!p) return;
      p.prompt = e.target.value;
      this.save();
    });
    this.$("aisummary-preset-default").addEventListener("change", (e) => {
      this.core.setPref("defaultPreset", e.target.value);
    });
    this.$("aisummary-preset-new").addEventListener("click", () => {
      this.add({ name: "New preset", prompt: "Summarise the article focusing on …" });
    });
    this.$("aisummary-preset-duplicate").addEventListener("click", () => {
      const p = this.find();
      if (p) this.add({ name: p.name + " (copy)", prompt: p.prompt });
    });
    this.$("aisummary-preset-delete").addEventListener("click", () => {
      if (this.presets.length <= 1) {
        this.status("Keep at least one preset.", true);
        return;
      }
      this.presets = this.presets.filter(p => p.id !== this.current);
      this.current = this.presets[0].id;
      this.save();
      this.renderLists();
      this.showPreset();
    });
    this.$("aisummary-preset-restore").addEventListener("click", () => {
      const builtIn = this.core.DEFAULT_PRESETS.map(p => Object.assign({}, p));
      const custom = this.presets.filter(p => !builtIn.some(b => b.id === p.id));
      this.presets = builtIn.concat(custom);
      this.current = this.presets[0].id;
      this.save();
      this.renderLists();
      this.showPreset();
      this.status("Built-in presets restored. Your own presets were kept.");
    });

    this.renderLists();
    this.showPreset();
  },

  find() {
    return this.presets.find(p => p.id === this.current);
  },

  add({ name, prompt }) {
    const id = "custom-" + Date.now().toString(36);
    this.presets.push({ id, name, prompt });
    this.current = id;
    this.save();
    this.renderLists();
    this.showPreset();
    this.$("aisummary-preset-name").focus();
  },

  save() {
    this.core.savePresets(this.presets);
  },

  renderLists() {
    const list = this.$("aisummary-preset-list");
    const def = this.$("aisummary-preset-default");
    const defaultId = this.core.getPreset().id;
    for (const sel of [list, def]) while (sel.firstChild) sel.firstChild.remove();
    for (const p of this.presets) {
      list.appendChild(this.html("option", { value: p.id }, p.name));
      def.appendChild(this.html("option", { value: p.id }, p.name));
    }
    list.value = this.current;
    def.value = this.presets.some(p => p.id === defaultId) ? defaultId : this.presets[0].id;
  },

  showPreset() {
    const p = this.find();
    this.$("aisummary-preset-name").value = p ? p.name : "";
    this.$("aisummary-preset-prompt").value = p ? p.prompt : "";
  }
};

// The pane's onload attribute should call init(). Newer Zotero versions may not
// run it, so also try now and keep checking briefly until the pane is in place.
(function startAISummaryPrefs() {
  let tries = 0;
  const attempt = () => {
    try {
      AISummaryPrefs.init();
    } catch (e) {
      Zotero.logError(e);
    }
    if (!AISummaryPrefs.initialized && tries++ < 50) setTimeout(attempt, 100);
  };
  attempt();
})();
