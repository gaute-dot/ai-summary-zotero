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

  PROVIDER_IDS: ["anthropic", "openai", "gemini", "perplexity"],
  PROVIDER_LABELS: {
    anthropic: "Anthropic Claude",
    openai: "OpenAI",
    gemini: "Google Gemini",
    perplexity: "Perplexity"
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

  getSettings() {
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

  getModel(provider) {
    return (this.getPref("model." + provider) || "").trim();
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
