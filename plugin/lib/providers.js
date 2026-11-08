/* global Zotero, AISummary */
"use strict";

/**
 * Provider adapters. Each adapter has:
 *   buildRequest(opts)              -> { url, headers, body }      (pure, unit-tested)
 *   parseResponse(json)             -> { text, citations, truncated }
 *   streamEvent(data, state)        updates state from one SSE "data:" payload
 *   listModels                      { url, headers(key), parse(json) } or a static list
 *
 * opts: {
 *   model, apiKey,
 *   system,          instructions
 *   systemCached,    optional large, stable text (documents) appended to the system prompt;
 *                    marked for prompt caching on Claude, first in the prefix elsewhere
 *   messages,        [{ role: "user" | "assistant", content: string }]  (or `user` for one turn)
 *   user,            single user message (used when `messages` is absent)
 *   pdf,             { base64, filename } attached to the first user message, or null
 *   maxTokens, temperature, effort, stream
 * }
 */
AISummary.Providers = {
  ANTHROPIC_VERSION: "2026-10-21",
  // Claude models that accept server-side refusal fallbacks ("default" mode).
  ANTHROPIC_FALLBACK_MODELS: ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"],

  supportsPdf(provider) {
    return provider === "anthropic" || provider === "openai" || provider === "gemini";
  },

  messagesOf(o) {
    const list = o.messages && o.messages.length ? o.messages : [{ role: "user", content: o.user || "" }];
    return list.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
  },

  systemText(o) {
    return o.systemCached ? o.system + "\n\n" + o.systemCached : o.system;
  },

  newStreamState() {
    return { text: "", citations: [], truncated: false, done: false };
  },

  adapters: {
    anthropic: {
      buildRequest(o) {
        const P = AISummary.Providers;
        let pdfDone = !o.pdf;
        const messages = P.messagesOf(o).map(m => {
          if (!pdfDone && m.role === "user") {
            pdfDone = true;
            return {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: o.pdf.base64 } },
                { type: "text", text: m.content }
              ]
            };
          }
          return m;
        });
        const body = {
          model: o.model,
          max_tokens: o.maxTokens,
          system: o.systemCached
            ? [
              { type: "text", text: o.system },
              { type: "text", text: o.systemCached, cache_control: { type: "ephemeral" } }
            ]
            : o.system,
          messages
        };
        // Multi-turn: also cache the growing conversation.
        if (messages.length > 1) body.cache_control = { type: "ephemeral" };
        if (o.effort) body.output_config = { effort: o.effort };
        if (o.stream) body.stream = true;
        const headers = {
          "content-type": "application/json",
          "x-api-key": o.apiKey,
          "anthropic-version": P.ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true"
        };
        if (P.ANTHROPIC_FALLBACK_MODELS.includes(o.model)) {
          headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
          body.fallbacks = "default";
        }
        return { url: "https://api.anthropic.com/v1/messages", headers, body };
      },
      parseResponse(json) {
        if (json.stop_reason === "refusal") {
          const why = json.stop_details && json.stop_details.explanation;
          throw new Error("Claude declined the request" + (why ? ": " + why : "."));
        }
        const text = (json.content || [])
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("");
        return { text, citations: [], truncated: json.stop_reason === "max_tokens" };
      },
      streamEvent(data, s) {
        const ev = JSON.parse(data);
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          s.text += ev.delta.text;
        } else if (ev.type === "message_delta" && ev.delta) {
          if (ev.delta.stop_reason === "refusal") {
            throw new Error("Claude declined the request. The partial answer was discarded.");
          }
          if (ev.delta.stop_reason === "max_tokens") s.truncated = true;
        } else if (ev.type === "message_stop") {
          s.done = true;
        } else if (ev.type === "error") {
          throw new Error("Claude: " + ((ev.error && ev.error.message) || "stream error"));
        }
      },
      listModels: {
        url: "https://api.anthropic.com/v1/models?limit=1000",
        headers: key => ({ "x-api-key": key, "anthropic-version": AISummary.Providers.ANTHROPIC_VERSION }),
        parse: json => (json.data || []).map(m => m.id)
      }
    },

    openai: {
      buildRequest(o) {
        const P = AISummary.Providers;
        let pdfDone = !o.pdf;
        const messages = [{ role: "system", content: P.systemText(o) }];
        for (const m of P.messagesOf(o)) {
          if (!pdfDone && m.role === "user") {
            pdfDone = true;
            messages.push({
              role: "user",
              content: [
                { type: "file", file: { filename: o.pdf.filename, file_data: "data:application/pdf;base64," + o.pdf.base64 } },
                { type: "text", text: m.content }
              ]
            });
          } else {
            messages.push(m);
          }
        }
        const body = { model: o.model, messages, max_completion_tokens: o.maxTokens };
        if (o.temperature !== null && o.temperature !== undefined) body.temperature = o.temperature;
        if (o.stream) body.stream = true;
        return {
          url: "https://api.openai.com/v1/chat/completions",
          headers: { "content-type": "application/json", authorization: "Bearer " + o.apiKey },
          body
        };
      },
      parseResponse(json) {
        const choice = (json.choices || [])[0] || {};
        const msg = choice.message || {};
        if (msg.refusal) throw new Error("OpenAI declined the request: " + msg.refusal);
        return { text: msg.content || "", citations: [], truncated: choice.finish_reason === "length" };
      },
      streamEvent(data, s) {
        if (data.trim() === "[DONE]") {
          s.done = true;
          return;
        }
        const ev = JSON.parse(data);
        if (ev.error) throw new Error("OpenAI: " + (ev.error.message || "stream error"));
        const choice = (ev.choices || [])[0];
        if (!choice) return;
        if (choice.delta && typeof choice.delta.content === "string") s.text += choice.delta.content;
        if (choice.delta && choice.delta.refusal) throw new Error("OpenAI declined the request: " + choice.delta.refusal);
        if (choice.finish_reason === "length") s.truncated = true;
      },
      listModels: {
        url: "https://api.openai.com/v1/models",
        headers: key => ({ authorization: "Bearer " + key }),
        // Newest first.
        parse: json => (json.data || [])
          .slice()
          .sort((a, b) => (b.created || 0) - (a.created || 0))
          .map(m => m.id)
          .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(id))
      }
    },

    gemini: {
      buildRequest(o) {
        const P = AISummary.Providers;
        const model = String(o.model).replace(/^models\//, "");
        let pdfDone = !o.pdf;
        const contents = P.messagesOf(o).map(m => {
          const parts = [];
          if (!pdfDone && m.role === "user") {
            pdfDone = true;
            parts.push({ inline_data: { mime_type: "application/pdf", data: o.pdf.base64 } });
          }
          parts.push({ text: m.content });
          return { role: m.role === "assistant" ? "model" : "user", parts };
        });
        const generationConfig = { maxOutputTokens: o.maxTokens };
        if (o.temperature !== null && o.temperature !== undefined) generationConfig.temperature = o.temperature;
        const base = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model);
        return {
          url: base + (o.stream ? ":streamGenerateContent?alt=sse" : ":generateContent"),
          headers: { "content-type": "application/json", "x-goog-api-key": o.apiKey },
          body: {
            systemInstruction: { parts: [{ text: P.systemText(o) }] },
            contents,
            generationConfig
          }
        };
      },
      parseResponse(json) {
        if (json.promptFeedback && json.promptFeedback.blockReason) {
          throw new Error("Gemini blocked the request: " + json.promptFeedback.blockReason);
        }
        const cand = (json.candidates || [])[0];
        if (!cand) throw new Error("Gemini returned no answer.");
        const text = ((cand.content && cand.content.parts) || [])
          .filter(p => typeof p.text === "string" && !p.thought)
          .map(p => p.text)
          .join("");
        if (!text && cand.finishReason && cand.finishReason !== "STOP" && cand.finishReason !== "MAX_TOKENS") {
          throw new Error("Gemini stopped without an answer (" + cand.finishReason + ").");
        }
        return { text, citations: [], truncated: cand.finishReason === "MAX_TOKENS" };
      },
      streamEvent(data, s) {
        const ev = JSON.parse(data);
        if (ev.error) throw new Error("Gemini: " + (ev.error.message || "stream error"));
        if (ev.promptFeedback && ev.promptFeedback.blockReason) {
          throw new Error("Gemini blocked the request: " + ev.promptFeedback.blockReason);
        }
        const cand = (ev.candidates || [])[0];
        if (!cand) return;
        for (const p of (cand.content && cand.content.parts) || []) {
          if (typeof p.text === "string" && !p.thought) s.text += p.text;
        }
        if (cand.finishReason === "MAX_TOKENS") s.truncated = true;
        if (cand.finishReason) s.done = true;
      },
      listModels: {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        headers: key => ({ "x-goog-api-key": key }),
        parse: json => (json.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map(m => String(m.name).replace(/^models\//, ""))
      }
    },

    perplexity: {
      buildRequest(o) {
        const P = AISummary.Providers;
        const body = {
          model: o.model,
          messages: [{ role: "system", content: P.systemText(o) }].concat(P.messagesOf(o)),
          max_tokens: o.maxTokens
        };
        if (o.temperature !== null && o.temperature !== undefined) body.temperature = o.temperature;
        if (o.stream) body.stream = true;
        return {
          url: "https://api.perplexity.ai/chat/completions",
          headers: { "content-type": "application/json", authorization: "Bearer " + o.apiKey },
          body
        };
      },
      citationsOf(json) {
        if (Array.isArray(json.search_results) && json.search_results.length) {
          return json.search_results.map(r => ({ title: r.title || r.url, url: r.url }));
        }
        if (Array.isArray(json.citations) && json.citations.length) {
          return json.citations.map(u => ({ title: u, url: u }));
        }
        return null;
      },
      parseResponse(json) {
        const choice = (json.choices || [])[0] || {};
        const text = AISummary.Providers.stripThink((choice.message && choice.message.content) || "");
        const citations = this.citationsOf(json) || [];
        return { text, citations, truncated: choice.finish_reason === "length" };
      },
      streamEvent(data, s) {
        if (data.trim() === "[DONE]") {
          s.done = true;
          return;
        }
        const ev = JSON.parse(data);
        if (ev.error) throw new Error("Perplexity: " + (ev.error.message || "stream error"));
        const citations = this.citationsOf(ev);
        if (citations) s.citations = citations;
        const choice = (ev.choices || [])[0];
        if (!choice) return;
        if (choice.delta && typeof choice.delta.content === "string") s.text += choice.delta.content;
        if (choice.finish_reason === "length") s.truncated = true;
      },
      listModels: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"]
    }
  },

  /** Remove <think>…</think> reasoning (and an unfinished one while streaming). */
  stripThink(text) {
    return String(text)
      .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
      .replace(/<think>[\s\S]*$/, "");
  },

  errorMessage(provider, status, json) {
    let detail = "";
    if (json) {
      const err = Array.isArray(json) ? json[0] && json[0].error : json.error;
      if (err) detail = typeof err === "string" ? err : (err.message || JSON.stringify(err));
      else if (json.message) detail = json.message;
    }
    const label = AISummary.PROVIDER_LABELS[provider] || provider;
    if (status === 401 || status === 403) {
      return label + ": the API key was rejected (HTTP " + status + "). Check it in Settings → AI Summary." + (detail ? " " + detail : "");
    }
    if (status === 404) return label + ": model or endpoint not found (HTTP 404). Check the model name." + (detail ? " " + detail : "");
    if (status === 429) return label + ": rate limit or quota exceeded (HTTP 429)." + (detail ? " " + detail : "");
    return label + ": HTTP " + status + (detail ? " – " + detail : "");
  },

  checkReady(provider, opts) {
    if (!this.adapters[provider]) throw new Error("Unknown provider: " + provider);
    if (!opts.apiKey) {
      throw new Error("No API key set for " + AISummary.PROVIDER_LABELS[provider] + ". Add one in Settings → AI Summary.");
    }
    if (!opts.model) throw new Error("No model set for " + AISummary.PROVIDER_LABELS[provider] + ".");
  },

  isRetryable(status) {
    return status === 429 || status === 529 || status >= 500 || status === 0;
  },

  RETRY_DELAYS: [5000, 20000],

  async httpJSON(method, url, headers, body, timeoutMs) {
    const xhr = await Zotero.HTTP.request(method, url, {
      headers,
      body: body ? JSON.stringify(body) : undefined,
      responseType: "json",
      successCodes: false,
      timeout: timeoutMs || 600000
    });
    let json = xhr.response;
    if (typeof json === "string") {
      try { json = JSON.parse(json); } catch (e) { json = null; }
    }
    const retryAfter = Number(xhr.getResponseHeader && xhr.getResponseHeader("retry-after")) || 0;
    return { status: xhr.status, json, retryAfter };
  },

  /** Send one request and wait for the whole answer. Retries on rate limits and server errors. */
  async generate(provider, opts) {
    this.checkReady(provider, opts);
    const adapter = this.adapters[provider];
    const req = adapter.buildRequest(Object.assign({}, opts, { stream: false }));
    for (let attempt = 0; ; attempt++) {
      const { status, json, retryAfter } = await this.httpJSON("POST", req.url, req.headers, req.body);
      if (status >= 200 && status < 300 && json) return adapter.parseResponse(json);
      if (this.isRetryable(status) && attempt < this.RETRY_DELAYS.length) {
        await AISummary.sleep(retryAfter ? Math.min(retryAfter * 1000, 60000) : this.RETRY_DELAYS[attempt]);
        continue;
      }
      throw new Error(this.errorMessage(provider, status, json));
    }
  },

  /** Split a byte stream of server-sent events into "data:" payloads. */
  async *sseData(body, TextDecoderCtor) {
    const reader = body.getReader();
    const decoder = new TextDecoderCtor();
    let buf = "";
    const flush = function* (final) {
      let m;
      while ((m = buf.match(/\r?\n\r?\n/))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = raw.split(/\r?\n/)
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
      if (final && buf.trim()) {
        const data = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
        buf = "";
        if (data) yield data;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      yield* flush(false);
    }
    buf += decoder.decode();
    yield* flush(true);
  },

  /**
   * Stream an answer. Calls onText(textSoFar) as text arrives.
   * Falls back to a normal request when streaming is not available.
   */
  async generateStream(provider, opts, onText, signal) {
    this.checkReady(provider, opts);
    const win = Zotero.getMainWindow && Zotero.getMainWindow();
    if (!win || typeof win.fetch !== "function") {
      const res = await this.generate(provider, opts);
      onText(res.text);
      return res;
    }
    const adapter = this.adapters[provider];
    const req = adapter.buildRequest(Object.assign({}, opts, { stream: true }));
    for (let attempt = 0; ; attempt++) {
      const response = await win.fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal
      });
      if (!response.ok) {
        let json = null;
        try { json = JSON.parse(await response.text()); } catch (e) { /* not JSON */ }
        if (this.isRetryable(response.status) && attempt < this.RETRY_DELAYS.length) {
          const ra = Number(response.headers.get("retry-after")) || 0;
          await AISummary.sleep(ra ? Math.min(ra * 1000, 60000) : this.RETRY_DELAYS[attempt]);
          continue;
        }
        throw new Error(this.errorMessage(provider, response.status, json));
      }
      const state = this.newStreamState();
      for await (const data of this.sseData(response.body, win.TextDecoder)) {
        try {
          adapter.streamEvent(data, state);
        } catch (e) {
          if (e instanceof SyntaxError) continue; // keep-alive or partial line
          throw e;
        }
        onText(provider === "perplexity" ? this.stripThink(state.text) : state.text);
        if (state.done) break;
      }
      if (provider === "perplexity") state.text = this.stripThink(state.text);
      return { text: state.text, citations: state.citations, truncated: state.truncated };
    }
  },

  async listModels(provider, apiKey) {
    const spec = this.adapters[provider].listModels;
    if (Array.isArray(spec)) return spec.slice();
    if (!apiKey) throw new Error("Enter an API key first.");
    const { status, json } = await this.httpJSON("GET", spec.url, spec.headers(apiKey), null, 30000);
    if (status < 200 || status >= 300 || !json) throw new Error(this.errorMessage(provider, status, json));
    // Keep the provider's order (Anthropic lists newest first; OpenAI is sorted by date above).
    return [...new Set(spec.parse(json))];
  },

  /** Tiny request to confirm key + model work. */
  async test(provider, apiKey, model) {
    const res = await this.generate(provider, {
      model,
      apiKey,
      system: "You are a connection test.",
      user: "Reply with the single word OK.",
      pdf: null,
      maxTokens: 2000,
      temperature: null,
      effort: provider === "anthropic" ? "low" : null
    });
    return (res.text || "").trim().slice(0, 200) || "(empty reply)";
  }
};
