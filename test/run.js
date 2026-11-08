// Unit tests for the parts of the plugin that do not need Zotero.
// Run with: node test/run.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const root = path.join(__dirname, "..", "plugin");
const prefs = {};
const sandbox = {
  console,
  setTimeout,
  Zotero: {
    debug() {},
    Prefs: {
      get: k => prefs[k],
      set: (k, v) => { prefs[k] = v; },
      clear: k => { delete prefs[k]; }
    }
  },
  Services: {}
};
vm.createContext(sandbox);
for (const f of ["lib/vendor/markdown-it.min.js", "lib/core.js", "lib/providers.js", "lib/notes.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox, { filename: f });
}
const A = vm.runInContext("AISummary", sandbox);
// Objects created inside the vm have another realm's prototypes; normalise for deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok   " + name);
  } catch (e) {
    console.error("FAIL " + name + "\n     " + e.message);
    process.exitCode = 1;
  }
}

const base = {
  model: "", apiKey: "KEY", system: "SYS", user: "USER", pdf: null,
  maxTokens: 1000, temperature: null, effort: null
};

test("renderTemplate fills known variables and keeps unknown ones", () => {
  assert.equal(A.renderTemplate("Hi {{ title }} {{nope}}", { title: "X" }), "Hi X {{nope}}");
});

test("default presets and system prompt are used when prefs are empty", () => {
  assert.equal(A.getPresets().length, 5);
  assert.match(A.getSystemPrompt(), /\{\{language\}\}/);
  assert.equal(A.getPreset("critical").name, "Critical appraisal");
  assert.equal(A.getPreset("missing").id, "structured");
});

test("custom presets are read from prefs, invalid JSON falls back", () => {
  prefs["extensions.aisummary.presets"] = JSON.stringify([{ id: "a", name: "A", prompt: "p" }]);
  assert.equal(A.getPresets().length, 1);
  prefs["extensions.aisummary.presets"] = "{bad";
  assert.equal(A.getPresets().length, 5);
  delete prefs["extensions.aisummary.presets"];
});

test("buildPrompt puts the article before the instructions and adds language", () => {
  const ctx = { vars: { title: "T", authors: "Doe, J", abstract: "Abs" }, text: "BODY", pdf: null };
  const p = A.buildPrompt(ctx, { prompt: "Summarise {{title}}" }, { language: "Norwegian (Bokmål)" });
  assert.match(p.system, /Write in Norwegian \(Bokmål\)/);
  assert.ok(p.user.indexOf("<article>\nBODY") < p.user.indexOf("Summarise T"));
  assert.match(p.user, /Title: T\nAuthors: Doe, J/);
  assert.match(p.user, /Write the response in Norwegian \(Bokmål\)\.$/);
});

test("buildPrompt respects {{fulltext}} in the preset and handles missing text", () => {
  const ctx = { vars: { title: "T" }, text: "BODY", pdf: null };
  const p = A.buildPrompt(ctx, { prompt: "Read: {{fulltext}}" }, { language: "" });
  assert.equal(p.user.split("BODY").length, 2);
  assert.ok(!p.user.includes("<article>"));
  const none = A.buildPrompt({ vars: {}, text: "", pdf: null }, { prompt: "x" }, { language: "" });
  assert.match(none.user, /No full text was available/);
});

test("Anthropic request: headers, effort, fallbacks, PDF block", () => {
  const r = A.Providers.adapters.anthropic.buildRequest(Object.assign({}, base, {
    model: "claude-opus-5-5", effort: "medium", pdf: { base64: "QUJD", filename: "a.pdf" }
  }));
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.headers["x-api-key"], "KEY");
  assert.equal(r.headers["anthropic-version"], "2026-10-21");
  assert.equal(r.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(r.body.fallbacks, "default");
  assert.deepEqual(plain(r.body.output_config), { effort: "medium" });
  assert.equal(r.body.system, "SYS");
  assert.equal(r.body.messages[0].content[0].type, "document");
  assert.equal(r.body.messages[0].content[1].text, "USER");
  assert.equal("temperature" in r.body, false);
});

test("Anthropic request: no fallbacks for models outside the list", () => {
  const r = A.Providers.adapters.anthropic.buildRequest(Object.assign({}, base, { model: "claude-haiku-5-5" }));
  assert.equal(r.headers["anthropic-beta"], undefined);
  assert.equal(r.body.fallbacks, undefined);
  assert.equal(r.body.output_config, undefined);
});

test("Anthropic response: text joined, refusal throws, max_tokens flagged", () => {
  const ad = A.Providers.adapters.anthropic;
  const out = ad.parseResponse({
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: "A" }, { type: "text", text: "B" }],
    stop_reason: "max_tokens"
  });
  assert.equal(out.text, "AB");
  assert.equal(out.truncated, true);
  assert.throws(() => ad.parseResponse({ stop_reason: "refusal", stop_details: { explanation: "no" } }), /declined/);
});

test("OpenAI request and response", () => {
  const ad = A.Providers.adapters.openai;
  const r = ad.buildRequest(Object.assign({}, base, { model: "gpt-5", temperature: 0.2, pdf: { base64: "QUJD", filename: "a.pdf" } }));
  assert.equal(r.headers.authorization, "Bearer KEY");
  assert.equal(r.body.max_completion_tokens, 1000);
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.body.messages[0].role, "system");
  assert.equal(r.body.messages[1].content[0].file.file_data, "data:application/pdf;base64,QUJD");
  const out = ad.parseResponse({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] });
  assert.equal(out.text, "Hi");
  assert.equal(out.truncated, false);
});

test("Gemini request and response", () => {
  const ad = A.Providers.adapters.gemini;
  const r = ad.buildRequest(Object.assign({}, base, { model: "models/gemini-2.5-pro" }));
  assert.equal(r.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
  assert.equal(r.headers["x-goog-api-key"], "KEY");
  assert.equal(r.body.systemInstruction.parts[0].text, "SYS");
  assert.equal(r.body.generationConfig.maxOutputTokens, 1000);
  const out = ad.parseResponse({ candidates: [{ content: { parts: [{ text: "x", thought: true }, { text: "Y" }] }, finishReason: "STOP" }] });
  assert.equal(out.text, "Y");
  assert.throws(() => ad.parseResponse({ promptFeedback: { blockReason: "SAFETY" } }), /SAFETY/);
});

test("Perplexity strips <think> and returns citations", () => {
  const ad = A.Providers.adapters.perplexity;
  const r = ad.buildRequest(Object.assign({}, base, { model: "sonar-pro" }));
  assert.equal(r.url, "https://api.perplexity.ai/chat/completions");
  assert.equal(r.body.max_tokens, 1000);
  const out = ad.parseResponse({
    choices: [{ message: { content: "<think>hmm</think>\nAnswer" } }],
    search_results: [{ title: "S", url: "https://e.x" }]
  });
  assert.equal(out.text, "Answer");
  assert.deepEqual(plain(out.citations), [{ title: "S", url: "https://e.x" }]);
  const legacy = ad.parseResponse({ choices: [{ message: { content: "A" } }], citations: ["https://a"] });
  assert.equal(legacy.citations[0].url, "https://a");
});

test("model list parsers", () => {
  const P = A.Providers.adapters;
  assert.deepEqual(plain(P.anthropic.listModels.parse({ data: [{ id: "claude-opus-5-5" }] })), ["claude-opus-5-5"]);
  assert.deepEqual(plain(P.openai.listModels.parse({ data: [{ id: "gpt-5" }, { id: "text-embedding-3" }, { id: "gpt-4o-audio" }] })), ["gpt-5"]);
  assert.deepEqual(plain(P.gemini.listModels.parse({ models: [
    { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }
  ] })), ["gemini-2.5-pro"]);
});

test("error messages explain common failures", () => {
  assert.match(A.Providers.errorMessage("openai", 401, { error: { message: "bad" } }), /API key was rejected.*bad/);
  assert.match(A.Providers.errorMessage("gemini", 404, null), /model or endpoint not found/);
  assert.match(A.Providers.errorMessage("anthropic", 500, { error: { message: "x" } }), /HTTP 500 – x/);
});

test("note HTML: markdown rendered, raw HTML escaped, leading H1 and fences removed", () => {
  const html = A.Notes.buildHTML({
    title: "AI Summary · Test",
    markdown: "```markdown\n# Paper title\n\n## Findings\n\n- **a** <script>x</script>\n```",
    citations: [{ title: "S", url: "https://e.x" }],
    footer: "Generated <by> model",
    question: "Why?"
  });
  assert.match(html, /^<div data-schema-version="9"><h1>AI Summary · Test<\/h1>/);
  assert.match(html, /<h2>Findings<\/h2>/);
  assert.match(html, /<strong>a<\/strong> &lt;script&gt;/);
  assert.ok(!html.includes("Paper title"));
  assert.match(html, /<a href="https:\/\/e.x">S<\/a>/);
  assert.match(html, /Generated &lt;by&gt; model/);
  assert.match(html, /Question:<\/strong> Why\?/);
});

test("Q&A titles are shortened", () => {
  const t = A.Notes.qaTitle("x".repeat(200));
  assert.ok(t.startsWith("AI Q&A · "));
  assert.ok(t.length < 100);
});

console.log("\n" + passed + " tests passed");
