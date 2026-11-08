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
for (const f of ["lib/vendor/markdown-it.min.js", "lib/core.js", "lib/providers.js", "lib/notes.js", "lib/retrieval.js", "lib/chat.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox, { filename: f });
}
const A = vm.runInContext("AISummary", sandbox);
// Objects created inside the vm have another realm's prototypes; normalise for deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));

let passed = 0;
let queue = Promise.resolve();
function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log("ok   " + name);
    } catch (e) {
      console.error("FAIL " + name + "\n     " + e.message);
      process.exitCode = 1;
    }
  });
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

test("OpenAI models are listed newest first", () => {
  const ids = A.Providers.adapters.openai.listModels.parse({ data: [
    { id: "gpt-4.1", created: 100 }, { id: "gpt-5", created: 300 }, { id: "o3", created: 200 }
  ] });
  assert.deepEqual(plain(ids), ["gpt-5", "o3", "gpt-4.1"]);
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

/* ---------- chat: providers ---------- */

const convo = [
  { role: "user", content: "Q1" },
  { role: "assistant", content: "A1" },
  { role: "user", content: "Q2" }
];

test("Anthropic multi-turn: cached documents block, conversation caching, stream flag", () => {
  const r = A.Providers.adapters.anthropic.buildRequest(Object.assign({}, base, {
    model: "claude-sonnet-5-5", systemCached: "<documents>D</documents>", messages: convo, stream: true
  }));
  assert.equal(r.body.system[0].text, "SYS");
  assert.deepEqual(plain(r.body.system[1]), { type: "text", text: "<documents>D</documents>", cache_control: { type: "ephemeral" } });
  assert.deepEqual(plain(r.body.cache_control), { type: "ephemeral" });
  assert.equal(r.body.messages.length, 3);
  assert.equal(r.body.messages[1].role, "assistant");
  assert.equal(r.body.stream, true);
});

test("OpenAI, Gemini, Perplexity multi-turn shapes", () => {
  const P = A.Providers.adapters;
  const o = Object.assign({}, base, { model: "m", systemCached: "DOCS", messages: convo, stream: true });
  const oa = P.openai.buildRequest(o).body;
  assert.equal(oa.messages[0].content, "SYS\n\nDOCS");
  assert.equal(oa.messages.length, 4);
  assert.equal(oa.stream, true);
  const g = P.gemini.buildRequest(o);
  assert.match(g.url, /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(plain(g.body.contents.map(c => c.role)), ["user", "model", "user"]);
  assert.equal(g.body.systemInstruction.parts[0].text, "SYS\n\nDOCS");
  const px = P.perplexity.buildRequest(o).body;
  assert.deepEqual(plain(px.messages.map(m => m.role)), ["system", "user", "assistant", "user"]);
});

test("stream events: Anthropic", () => {
  const ad = A.Providers.adapters.anthropic;
  const s = A.Providers.newStreamState();
  ad.streamEvent(JSON.stringify({ type: "content_block_start", content_block: { type: "fallback" } }), s);
  ad.streamEvent(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }), s);
  ad.streamEvent(JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } }), s);
  ad.streamEvent(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }), s);
  ad.streamEvent(JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } }), s);
  ad.streamEvent(JSON.stringify({ type: "message_stop" }), s);
  assert.equal(s.text, "Hello");
  assert.equal(s.truncated, true);
  assert.equal(s.done, true);
  assert.throws(() => ad.streamEvent(JSON.stringify({ type: "message_delta", delta: { stop_reason: "refusal" } }), s), /declined/);
  assert.throws(() => ad.streamEvent(JSON.stringify({ type: "error", error: { message: "overloaded" } }), s), /overloaded/);
});

test("stream events: OpenAI, Gemini, Perplexity", () => {
  const P = A.Providers.adapters;
  let s = A.Providers.newStreamState();
  P.openai.streamEvent(JSON.stringify({ choices: [{ delta: { content: "A" } }] }), s);
  P.openai.streamEvent(JSON.stringify({ choices: [{ delta: { content: "B" }, finish_reason: "length" }] }), s);
  P.openai.streamEvent("[DONE]", s);
  assert.equal(s.text, "AB");
  assert.equal(s.truncated, true);
  assert.equal(s.done, true);

  s = A.Providers.newStreamState();
  P.gemini.streamEvent(JSON.stringify({ candidates: [{ content: { parts: [{ text: "x" }] } }] }), s);
  P.gemini.streamEvent(JSON.stringify({ candidates: [{ content: { parts: [{ text: "y" }] }, finishReason: "STOP" }] }), s);
  assert.equal(s.text, "xy");
  assert.equal(s.done, true);

  s = A.Providers.newStreamState();
  P.perplexity.streamEvent(JSON.stringify({ choices: [{ delta: { content: "<think>a" } }] }), s);
  assert.equal(A.Providers.stripThink(s.text), "");
  P.perplexity.streamEvent(JSON.stringify({ choices: [{ delta: { content: "b</think>Ans" } }], search_results: [{ title: "T", url: "u" }] }), s);
  assert.equal(A.Providers.stripThink(s.text), "Ans");
  assert.equal(s.citations[0].url, "u");
});

test("SSE parser splits events, joins multi-line data and handles CRLF and a trailing event", async () => {
  const parts = ["event: a\ndata: {\"x\"", ":1}\n\ndata: line1\r\ndata: line2\r\n\r\ndata: [DONE]"];
  const enc = new TextEncoder();
  let i = 0;
  const body = { getReader: () => ({ read: async () => (i < parts.length ? { value: enc.encode(parts[i++]), done: false } : { done: true }) }) };
  const out = [];
  for await (const d of A.Providers.sseData(body, TextDecoder)) out.push(d);
  assert.deepEqual(out, ['{"x":1}', "line1\nline2", "[DONE]"]);
});

/* ---------- chat: retrieval ---------- */

test("chunking keeps paragraphs together and splits long text", () => {
  const para = "word ".repeat(100).trim();
  const chunks = A.Retrieval.chunk([para, para, para, para, para].join("\n\n"), 1200, 100);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.length <= 1200 + 100 + 2));
  assert.equal(A.Retrieval.chunk("x".repeat(5000), 1000, 100).length, 6);
});

test("BM25 finds the relevant passage and falls back to openings", () => {
  const filler = "General background text about many unrelated things in society. ".repeat(20);
  const docs = [
    { index: 1, title: "A", text: filler + "\n\n" + "Participants reported lower anxiety after mindfulness training sessions." + "\n\n" + filler },
    { index: 2, title: "B", text: filler + "\n\n" + "Teachers' workload increased during the reform period in Norway." }
  ];
  const idx = A.Retrieval.buildIndex(docs);
  const top = A.Retrieval.search(idx, "Did mindfulness reduce anxiety?")[0].chunk;
  assert.equal(top.doc, 1);
  assert.match(top.text, /mindfulness/);
  const nb = A.Retrieval.search(idx, "lærernes workload i Norway")[0].chunk;
  assert.equal(nb.doc, 2);
  const picked = A.Retrieval.select(idx, "zzzz qqqq", 3000);
  assert.ok(picked.length >= 2);
  assert.deepEqual([...new Set(picked.map(c => c.doc))].sort(), [1, 2]);
});

/* ---------- chat: prompt building ---------- */

function fakeSession(mode, docs) {
  return {
    itemIDs: docs.map((d, i) => i + 1), messages: [], quote: "", mode, docs,
    index: mode === "excerpts" ? A.Retrieval.buildIndex(docs) : null
  };
}
const chatSettings = { language: "English", chatRetrievalChars: 2000 };
const docA = { index: 1, title: "Alpha", vars: { title: "Alpha", authors: "Doe, J" }, text: "Alpha full text about cats." };
const docB = { index: 2, title: "Beta", vars: { title: "Beta" }, text: "" };

test("chat full mode: all documents in the cached block, history passed through", () => {
  const s = fakeSession("full", [docA, docB]);
  s.messages = [{ role: "user", content: "Q1" }, { role: "assistant", content: "A1" }, { role: "assistant", content: "", error: "x" }, { role: "user", content: "Q2" }];
  const r = A.Chat.buildRequest(s, chatSettings);
  assert.match(r.system, /cite it by its number/);
  assert.match(r.system, /Write in English/);
  assert.match(r.systemCached, /<document index="1">[\s\S]*Alpha full text about cats/);
  assert.match(r.systemCached, /<document index="2">[\s\S]*No full text available/);
  assert.deepEqual(plain(r.messages.map(m => m.content)), ["Q1", "A1", "Q2"]);
});

test("chat excerpts mode: only the last question carries excerpts", () => {
  const long = { index: 1, title: "Alpha", vars: { title: "Alpha" }, text: ("Filler sentence here. ".repeat(80) + "\n\n").repeat(3) + "Dogs bark loudly at night." };
  const s = fakeSession("excerpts", [long, docB]);
  s.messages = [{ role: "user", content: "Tell me about cats" }, { role: "assistant", content: "A" }, { role: "user", content: "Why do dogs bark?" }];
  const r = A.Chat.buildRequest(s, chatSettings);
  assert.match(r.systemCached, /<sources>[\s\S]*Only excerpts/);
  assert.ok(!r.systemCached.includes("Dogs bark"));
  assert.equal(r.messages[0].content, "Tell me about cats");
  assert.match(r.messages[2].content, /^<excerpts>\n<excerpt source="1" title="Alpha">[\s\S]*Dogs bark loudly[\s\S]*<\/excerpts>\n\nWhy do dogs bark\?$/);
  assert.equal(s.messages[2].content, "Why do dogs bark?"); // stored history unchanged
});

test("chat quote is prepended once and question text is recovered for titles", () => {
  const s = { quote: "Line one\nLine two" };
  const msg = A.Chat.composeUserMessage(s, "");
  assert.equal(msg, "About this passage:\n\n> Line one\n> Line two\n\nExplain this passage.");
  assert.equal(s.quote, "");
  assert.equal(A.Chat.questionText(msg), "Explain this passage.");
  assert.equal(A.Chat.shorten("x".repeat(100), 10).length, 10);
});

test("chat defaults: quick questions and system prompt", () => {
  assert.ok(A.Chat.quickQuestions().length >= 4);
  prefs["extensions.aisummary.chatQuickQuestions"] = "One\n\n Two ";
  assert.deepEqual(plain(A.Chat.quickQuestions()), ["One", "Two"]);
  delete prefs["extensions.aisummary.chatQuickQuestions"];
});

process.on("beforeExit", () => {
  if (!done) {
    done = true;
    console.log("\n" + passed + " tests passed");
  }
});
let done = false;
