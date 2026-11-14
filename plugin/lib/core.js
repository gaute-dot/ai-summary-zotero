/* global Zotero, Services, Cc, Ci, pluginID, pluginVersion, rootURI */
"use strict";

var AISummary = {
  id: typeof pluginID !== "undefined" ? pluginID : "ai-summary-zotero@gaute-dot.github.io",
  version: typeof pluginVersion !== "undefined" ? pluginVersion : "dev",
  rootURI: typeof rootURI !== "undefined" ? rootURI : "",
  PREF_PREFIX: "extensions.aisummary.",
  NOTE_PREFIX: "AI Summary",
  QA_PREFIX: "AI Q&A",
  prefPaneID: null,
  windows: new Set(),
  batch: { running: false, cancel: false },

  PROVIDER_IDS: ["anthropic", "openai", "gemini", "perplexity", "local", "custom"],
  PROVIDER_LABELS: {
    anthropic: "Anthropic Claude",
    openai: "OpenAI",
    gemini: "Google Gemini",
    perplexity: "Perplexity",
    local: "Local AI on this computer",
    custom: "Custom / university service"
  },

  DEFAULT_SYSTEM_PROMPT: [
    "You are a meticulous research assistant who writes notes about academic articles for a researcher's Zotero library.",
    "",
    "Rules:",
    "- Base every statement on the supplied article. Do not invent results, numbers, quotes or references.",
    "- If something is not reported in the article, say so explicitly instead of guessing.",
    "- Keep quantitative results exact (sample sizes, effect sizes, confidence intervals, p-values) when they are reported.",
    "- Separate what the authors claim from your own assessment.",
    "- Write in {{language}}, in clear and concise academic prose.",
    "- Format the answer as Markdown: use ## headings, bullet points and tables where they help. Do not wrap the answer in a code block."
  ].join("\n"),

  DEFAULT_PRESETS: [
    {
      id: "structured",
      name: "Structured summary",
      prompt: [
        "Write a structured summary of the article with these sections:",
        "",
        "## TL;DR",
        "Two or three sentences with the main contribution.",
        "## Research question and aim",
        "## Methods",
        "Design, data/sample (with n), setting, key variables and analysis.",
        "## Key findings",
        "Bullet points with the most important results, including numbers.",
        "## Limitations",
        "Limitations stated by the authors, then any further limitations you notice (label these clearly).",
        "## Implications and takeaways",
        "## Key concepts",
        "A short list of central terms with one-line definitions."
      ].join("\n")
    },
    {
      id: "tldr",
      name: "Short summary (TL;DR)",
      prompt: [
        "Write a short summary of the article:",
        "1. One paragraph (at most 120 words) covering aim, method, main result and conclusion.",
        "2. Then five bullet points with the most important takeaways."
      ].join("\n")
    },
    {
      id: "critical",
      name: "Critical appraisal",
      prompt: [
        "Write a critical appraisal of the article with these sections:",
        "## Summary of claims",
        "## Strengths",
        "## Weaknesses and threats to validity",
        "Consider internal validity, external validity, measurement, confounding, statistical analysis and risk of bias.",
        "## Do the conclusions follow from the evidence?",
        "## Overall assessment",
        "Rate the strength of evidence as low, moderate or high and justify the rating in two or three sentences."
      ].join("\n")
    },
    {
      id: "methods",
      name: "Methods and data extraction",
      prompt: [
        "Extract the study characteristics into a Markdown table with the columns Field and Value. Include rows for:",
        "study design, country/setting, population, sample size, recruitment, intervention or exposure, comparison,",
        "outcomes and how they were measured, follow-up period, statistical methods, main results, funding and conflicts of interest.",
        "Write \"Not reported\" when the article does not give the information.",
        "After the table, add a short paragraph on anything unusual about the methods."
      ].join("\n")
    },
    {
      id: "litreview",
      name: "Literature review notes",
      prompt: [
        "Write notes I can use in a literature review:",
        "## Main argument",
        "## Key claims and evidence",
        "Bullet points; give page or section references when the text makes them available.",
        "## Theoretical framework and key concepts",
        "## How it relates to other research",
        "Debates or research traditions the article positions itself in.",
        "## Useful quotes",
        "Up to five short verbatim quotes, copied exactly from the text.",
        "## Open questions and gaps"
      ].join("\n")
    }
  ],

  QA_PROMPT: "Answer the following question about the article. Quote or refer to the relevant parts of the text, and say clearly if the article does not answer it.\n\nQuestion: {{question}}",

  TEMPLATE_VARIABLES: [
    "title", "authors", "year", "date", "publication", "itemType", "doi", "url",
    "abstract", "tags", "language", "question", "fulltext"
  ],

  /* ---------- lifecycle ---------- */

  async startup() {
    Zotero.AISummary = this;
    try {
      this.prefPaneID = await Zotero.PreferencePanes.register({
        pluginID: this.id,
        src: this.rootURI + "content/preferences.xhtml",
        scripts: [this.rootURI + "content/preferences.js"],
        label: "AI Summary",
        image: this.rootURI + "icons/icon-48.png"
      });
    } catch (e) {
      this.log("Could not register preference pane: " + e);
    }
    try {
      this.ChatPane.register();
    } catch (e) {
      this.log("Could not register chat panel: " + e);
    }
    try {
      this.LitPane.register();
    } catch (e) {
      this.log("Could not register literature search: " + e);
    }
    for (const win of Zotero.getMainWindows()) {
      if (win.ZoteroPane) this.addToWindow(win);
    }
  },

  shutdown() {
    for (const win of [...this.windows]) this.removeFromWindow(win);
    this.batch.cancel = true;
    if (this.Chat) {
      for (const session of [...this.Chat.sessions.values(), this.Chat.pinned]) {
        if (session && session.abort) session.abort.abort();
      }
      this.Chat.listeners.clear();
    }
    if (this.ChatPane) this.ChatPane.unregister();
    if (this.LitPane) this.LitPane.unregister();
    if (this.ChatWindow) this.ChatWindow.close();
    if (Zotero.AISummary === this) delete Zotero.AISummary;
  },

  log(msg) {
    Zotero.debug("[AI Summary] " + msg);
  },

  /* ---------- preferences ---------- */

  getPref(key) {
    return Zotero.Prefs.get(this.PREF_PREFIX + key, true);
  },

  setPref(key, value) {
    return Zotero.Prefs.set(this.PREF_PREFIX + key, value, true);
  },

  baseSettings() {
    const num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const temp = String(this.getPref("temperature") ?? "").trim();
    return {
      provider: this.getPref("provider") || "anthropic",
      language: (this.getPref("language") || "English").trim(),
      inputMode: this.getPref("inputMode") || "text",
      maxChars: num(this.getPref("maxChars"), 300000),
      maxTokens: num(this.getPref("maxTokens"), 16000),
      temperature: temp === "" || Number.isNaN(Number(temp)) ? null : Number(temp),
      anthropicEffort: this.getPref("anthropicEffort") || "",
      duplicateMode: this.getPref("duplicateMode") || "ask",
      tagNotes: !!this.getPref("tagNotes"),
      noteTag: (this.getPref("noteTag") || "").trim(),
      tagWithModel: !!this.getPref("tagWithModel"),
      addFooter: this.getPref("addFooter") !== false,
      batchDelayMs: Number(this.getPref("batchDelayMs")) || 0
    };
  },

  /**
   * Settings, adjusted to what a local model can hold: its context length
   * (in tokens) has to fit the article text, the instructions and the answer.
   */
  getSettings() {
    const s = this.baseSettings();
    if (s.provider === "local") {
      const ctx = Number(this.getPref("localContextTokens")) || 32768;
      s.maxTokens = Math.min(s.maxTokens, Math.max(1024, Math.floor(ctx * 0.25)));
      // About 3 characters per token, keeping room for instructions.
      s.localInputChars = Math.max(4000, Math.floor((ctx - s.maxTokens - 1500) * 3));
      s.maxChars = Math.min(s.maxChars, s.localInputChars);
    }
    return s;
  },

  /** Cloud providers need an API key; local and custom servers may not. */
  needsKey(provider) {
    return provider !== "local" && provider !== "custom";
  },

  hasCredentials(provider) {
    if (provider === "custom") return !!(this.getPref("customBaseURL") || "").trim();
    return !this.needsKey(provider) || !!this.getApiKey(provider);
  },

  isPrivate() {
    return !!this.getPref("privateMode");
  },

  sendConfirmed: new Set(),

  /**
   * "Warn before sending": ask once per provider per Zotero session before
   * article text goes to a provider that is not on this computer.
   */
  confirmSend(win, provider, what) {
    if (provider === "local" || this.getPref("warnBeforeSending") === false) return true;
    if (this.sendConfirmed.has(provider)) return true;
    const ps = Services.prompt;
    const check = { value: false };
    const model = this.getModel(provider);
    const where = provider === "custom"
      ? "the custom service at " + ((this.getPref("customBaseURL") || "").trim() || "(no address)")
      : this.PROVIDER_LABELS[provider];
    const flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL;
    const choice = ps.confirmEx(win || null, "AI Summary \u2013 send data?",
      "This sends " + what + " to " + where + (model ? " (" + model + ")" : "") + ", outside this computer.\n\n"
        + "Check that your university\u2019s rules and the article\u2019s licence allow this.",
      flags, "Send", null, null, "Don\u2019t ask again for this provider until Zotero restarts", check);
    if (choice !== 0) return false;
    if (check.value) this.sendConfirmed.add(provider);
    return true;
  },

  getModel(provider) {
    return (this.getPref("model." + provider) || "").trim();
  },

  /** Model names last fetched from the provider (kept so the dropdown is filled next time). */
  getModelCache(provider) {
    try {
      const list = JSON.parse(this.getPref("modelCache." + provider) || "[]");
      return Array.isArray(list) ? list.filter(x => typeof x === "string") : [];
    } catch (e) {
      return [];
    }
  },

  setModelCache(provider, list) {
    this.setPref("modelCache." + provider, JSON.stringify(list || []));
  },

  getSystemPrompt() {
    const custom = this.getPref("systemPrompt");
    return custom && custom.trim() ? custom : this.DEFAULT_SYSTEM_PROMPT;
  },

  getPresets() {
    const raw = this.getPref("presets");
    if (raw) {
      try {
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length) {
          return list.filter(p => p && p.id && p.name && typeof p.prompt === "string");
        }
      } catch (e) {
        this.log("Invalid presets JSON, using defaults: " + e);
      }
    }
    return this.DEFAULT_PRESETS.map(p => Object.assign({}, p));
  },

  savePresets(list) {
    this.setPref("presets", JSON.stringify(list));
  },

  getPreset(id) {
    const presets = this.getPresets();
    return presets.find(p => p.id === id)
      || presets.find(p => p.id === this.getPref("defaultPreset"))
      || presets[0];
  },

  /* ---------- API keys (stored in the Firefox/Zotero login manager) ---------- */

  LOGIN_ORIGIN: "chrome://ai-summary-zotero",

  getApiKey(provider) {
    try {
      const logins = Services.logins.findLogins(this.LOGIN_ORIGIN, null, provider);
      if (logins && logins.length) return logins[0].password;
    } catch (e) {
      this.log("Login manager read failed: " + e);
    }
    return this.getPref("apiKey." + provider) || "";
  },

  async setApiKey(provider, value) {
    value = (value || "").trim();
    try {
      const logins = Services.logins.findLogins(this.LOGIN_ORIGIN, null, provider);
      for (const l of logins) Services.logins.removeLogin(l);
      if (value) {
        const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
        info.init(this.LOGIN_ORIGIN, null, provider, "api-key", value, "", "");
        if (Services.logins.addLoginAsync) await Services.logins.addLoginAsync(info);
        else Services.logins.addLogin(info);
      }
      // Remove any plain-text fallback copy.
      Zotero.Prefs.clear(this.PREF_PREFIX + "apiKey." + provider, true);
    } catch (e) {
      this.log("Login manager write failed, storing key in prefs: " + e);
      this.setPref("apiKey." + provider, value);
    }
  },

  /**
   * Ask for an API key in a simple dialog. Works even when the settings pane
   * cannot be shown. Returns true when a key was saved.
   */
  async promptApiKey(win, provider) {
    provider = provider || this.getSettings().provider;
    const label = this.PROVIDER_LABELS[provider] || provider;
    const where = {
      anthropic: "console.anthropic.com \u2192 API keys",
      openai: "platform.openai.com \u2192 API keys",
      gemini: "aistudio.google.com \u2192 Get API key",
      perplexity: "perplexity.ai \u2192 Settings \u2192 API"
    }[provider] || "the provider's website";
    const input = { value: "" };
    const ok = Services.prompt.promptPassword(
      win || null, "AI Summary \u2013 " + label + " API key",
      "Paste your " + label + " API key (from " + where + ").\n"
        + (this.getApiKey(provider) ? "A key is already saved; a new one replaces it. Leave empty to remove it." : ""),
      input
    );
    if (!ok) return false;
    await this.setApiKey(provider, input.value);
    return !!this.getApiKey(provider);
  },

  /** Let the user pick a model from the provider's list, or type one. */
  async promptModel(win, provider) {
    provider = provider || this.getSettings().provider;
    const label = this.PROVIDER_LABELS[provider];
    let list = this.getModelCache(provider);
    const apiKey = this.getApiKey(provider);
    if (apiKey || !this.needsKey(provider)) {
      try {
        list = await this.Providers.listModels(provider, apiKey);
        this.setModelCache(provider, list);
      } catch (e) {
        this.log("Fetching models failed: " + e);
        if (!list.length) this.alert(win, "Could not fetch the model list: " + e.message + "\n\nYou can type a model name instead.");
      }
    }
    const current = this.getModel(provider);
    if (list.length) {
      const OTHER = "Other (type a name)\u2026";
      const choices = list.concat([OTHER]);
      const selected = { value: Math.max(0, list.indexOf(current)) };
      const ok = Services.prompt.select(win || null, "AI Summary \u2013 model",
        "Choose the " + label + " model (current: " + (current || "none") + "):", choices, selected);
      if (!ok) return;
      if (choices[selected.value] !== OTHER) {
        this.setPref("model." + provider, choices[selected.value]);
        return;
      }
    }
    const input = { value: current };
    const ok = Services.prompt.prompt(win || null, "AI Summary \u2013 model",
      "Model name for " + label + ":", input, null, { value: false });
    if (ok && input.value.trim()) this.setPref("model." + provider, input.value.trim());
  },

  /** Make sure the active provider has a key, asking for one if needed. */
  async ensureApiKey(win) {
    const provider = this.getSettings().provider;
    if (this.isPrivate() && provider !== "local") {
      this.alert(win, "Private mode is on, so only the local AI on this computer can be used.\n\n"
        + "Choose \u201C" + this.PROVIDER_LABELS.local + "\u201D as provider (AI Summary \u2192 AI provider), or turn private mode off in Settings \u2192 AI Summary.");
      return false;
    }
    if (provider === "custom" && !this.hasCredentials(provider)) {
      this.alert(win, "Set the address of your custom AI service in Settings \u2192 AI Summary first.");
      this.openSettings();
      return false;
    }
    if (this.hasCredentials(provider)) return true;
    return this.promptApiKey(win, provider);
  },

  /* ---------- templating ---------- */

  renderTemplate(template, vars) {
    return String(template || "").replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (m, name) => {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? "") : m;
    });
  },

  templateUses(template, name) {
    return new RegExp("\\{\\{\\s*" + name + "\\s*\\}\\}").test(template || "");
  },

  /**
   * Build the system prompt and user message for one request.
   * ctx comes from AISummary.Context.collect(); preset is {id, name, prompt}.
   */
  buildPrompt(ctx, preset, settings, extraVars = {}) {
    const vars = Object.assign({}, ctx.vars, { language: settings.language }, extraVars);
    const usesFulltext = this.templateUses(preset.prompt, "fulltext");
    vars.fulltext = ctx.text || "";

    const system = this.renderTemplate(this.getSystemPrompt(), vars);
    const parts = [];

    // Long material first, instructions last.
    parts.push("<metadata>\n" + this.metadataBlock(vars) + "\n</metadata>");
    if (!usesFulltext) {
      if (ctx.pdf) {
        parts.push("The full article is attached as a PDF document.");
      } else if (ctx.text) {
        parts.push("<article>\n" + ctx.text + "\n</article>");
      } else {
        parts.push("No full text was available. Base your answer on the metadata and abstract only, and state this at the start of your answer.");
      }
    }
    parts.push(this.renderTemplate(preset.prompt, vars));
    if (settings.language) parts.push("Write the response in " + settings.language + ".");

    return { system, user: parts.join("\n\n") };
  },

  metadataBlock(vars) {
    const rows = [
      ["Title", vars.title], ["Authors", vars.authors], ["Year", vars.year],
      ["Publication", vars.publication], ["Item type", vars.itemType],
      ["DOI", vars.doi], ["URL", vars.url], ["Tags", vars.tags], ["Abstract", vars.abstract]
    ];
    return rows.filter(r => r[1]).map(r => r[0] + ": " + r[1]).join("\n");
  },

  /* ---------- helpers ---------- */

  sleep(ms) {
    if (typeof Zotero !== "undefined" && Zotero.Promise && Zotero.Promise.delay) {
      return Zotero.Promise.delay(ms);
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  alert(win, message) {
    Services.prompt.alert(win || null, "AI Summary", message);
  }
};

if (typeof module !== "undefined") module.exports = AISummary;
