/* Default preferences. Zotero loads this file automatically. */
pref("extensions.aisummary.provider", "anthropic");

pref("extensions.aisummary.model.anthropic", "claude-opus-5-5");
pref("extensions.aisummary.model.openai", "gpt-5");
pref("extensions.aisummary.model.gemini", "gemini-3.1-pro-preview");
pref("extensions.aisummary.model.perplexity", "sonar-pro");

/* Empty = use the built-in default (see lib/core.js). */
pref("extensions.aisummary.systemPrompt", "");
pref("extensions.aisummary.presets", "");
pref("extensions.aisummary.defaultPreset", "structured");

pref("extensions.aisummary.language", "English");
/* "text" = send extracted full text; "pdf" = send the PDF file itself when the provider supports it. */
pref("extensions.aisummary.inputMode", "text");
pref("extensions.aisummary.maxChars", 300000);
pref("extensions.aisummary.maxTokens", 16000);
/* Empty = provider default. Not sent to Claude (current Claude models reject it). */
pref("extensions.aisummary.temperature", "");
/* Claude only: low | medium | high | xhigh | max | "" (model default). */
pref("extensions.aisummary.anthropicEffort", "medium");

/* ask | replace | new | skip */
pref("extensions.aisummary.duplicateMode", "ask");
pref("extensions.aisummary.tagNotes", true);
pref("extensions.aisummary.noteTag", "AI summary");
pref("extensions.aisummary.tagWithModel", false);
pref("extensions.aisummary.addFooter", true);
pref("extensions.aisummary.batchDelayMs", 1000);

/* Chat */
pref("extensions.aisummary.chatSystemPrompt", "");
pref("extensions.aisummary.chatQuickQuestions", "");
/* Sources up to this size are sent in full; larger ones are searched for relevant passages. */
pref("extensions.aisummary.chatContextChars", 250000);
pref("extensions.aisummary.chatRetrievalChars", 40000);
pref("extensions.aisummary.chatStreaming", true);

/* Literature search: openalex | semanticscholar | arxiv | crossref */
pref("extensions.aisummary.litSource", "openalex");

/* Local AI (Ollama / LM Studio) and custom OpenAI-compatible services */
pref("extensions.aisummary.model.local", "");
pref("extensions.aisummary.model.custom", "");
/* ollama | lmstudio */
pref("extensions.aisummary.localServer", "ollama");
/* Empty = default address of the chosen app */
pref("extensions.aisummary.localBaseURL", "");
pref("extensions.aisummary.localContextTokens", 32768);
pref("extensions.aisummary.customBaseURL", "");
/* authorization (Bearer) | api-key (Azure) */
pref("extensions.aisummary.customAuthHeader", "authorization");

/* Privacy */
pref("extensions.aisummary.privateMode", false);
pref("extensions.aisummary.warnBeforeSending", true);
