/* global Zotero, AISummary */
"use strict";

/**
 * Provider adapters. Each adapter has:
 *   buildRequest(opts)  -> { url, headers, body }      (pure, unit-tested)
 *   parseResponse(json) -> { text, citations, truncated }
 *   listModels: { url, headers(key), parse(json) } or a static list
 *
 * opts: { model, apiKey, system, user, pdf: {base64, filename}|null,
 *         maxTokens, temperature, effort }
 */
AISummary.Providers = {
  ANTHROPIC_VERSION: "2026-10-21",
  // Claude models that accept server-side refusal fallbacks ("default" mode).
  ANTHROPIC_FALLBACK_MODELS: ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"],

  supportsPdf(provider) {
    return provider === "anthropic" || provider === "openai" || provider === "gemini";
  },

  adapters: {
    anthropic: {
      buildRequest(o) {
        const content = [];
        if (o.pdf) {
          content.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: o.pdf.base64 }
          });
        }
        content.push({ type: "text", text: o.user });
        const body = {
          model: o.model,
          max_tokens: o.maxTokens,
          system: o.system,
          messages: [{ role: "user", content }]
        };
        if (o.effort) body.output_config = { effort: o.effort };
        const headers = {
          "content-type": "application/json",
          "x-api-key": o.apiKey,
          "anthropic-version": AISummary.Providers.ANTHROPIC_VERSION
        };
        if (AISummary.Providers.ANTHROPIC_FALLBACK_MODELS.includes(o.model)) {
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
      listModels: {
        url: "https://api.anthropic.com/v1/models?limit=1000",
        headers: key => ({ "x-api-key": key, "anthropic-version": AISummary.Providers.ANTHROPIC_VERSION }),
        parse: json => (json.data || []).map(m => m.id)
      }
    },

    openai: {
      buildRequest(o) {
        const userContent = [];
        if (o.pdf) {
          userContent.push({
            type: "file",
            file: { filename: o.pdf.filename, file_data: "data:application/pdf;base64," + o.pdf.base64 }
          });
        }
        userContent.push({ type: "text", text: o.user });
        const body = {
          model: o.model,
          messages: [
            { role: "system", content: o.system },
            { role: "user", content: userContent }
          ],
          max_completion_tokens: o.maxTokens
        };
        if (o.temperature !== null && o.temperature !== undefined) body.temperature = o.temperature;
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
      listModels: {
        url: "https://api.openai.com/v1/models",
        headers: key => ({ authorization: "Bearer " + key }),
        parse: json => (json.data || [])
          .map(m => m.id)
          .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(id))
      }
    },

    gemini: {
      buildRequest(o) {
        const model = String(o.model).replace(/^models\//, "");
        const parts = [];
        if (o.pdf) parts.push({ inline_data: { mime_type: "application/pdf", data: o.pdf.base64 } });
        parts.push({ text: o.user });
        const generationConfig = { maxOutputTokens: o.maxTokens };
        if (o.temperature !== null && o.temperature !== undefined) generationConfig.temperature = o.temperature;
        return {
          url: "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
          headers: { "content-type": "application/json", "x-goog-api-key": o.apiKey },
          body: {
            systemInstruction: { parts: [{ text: o.system }] },
            contents: [{ role: "user", parts }],
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
        const body = {
          model: o.model,
          messages: [
            { role: "system", content: o.system },
            { role: "user", content: o.user }
          ],
          max_tokens: o.maxTokens
        };
        if (o.temperature !== null && o.temperature !== undefined) body.temperature = o.temperature;
        return {
          url: "https://api.perplexity.ai/chat/completions",
          headers: { "content-type": "application/json", authorization: "Bearer " + o.apiKey },
          body
        };
      },
      parseResponse(json) {
        const choice = (json.choices || [])[0] || {};
        let text = (choice.message && choice.message.content) || "";
        // Reasoning models prepend their reasoning in <think> tags.
        text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
        let citations = [];
        if (Array.isArray(json.search_results) && json.search_results.length) {
          citations = json.search_results.map(r => ({ title: r.title || r.url, url: r.url }));
        } else if (Array.isArray(json.citations)) {
          citations = json.citations.map(u => ({ title: u, url: u }));
        }
        return { text, citations, truncated: choice.finish_reason === "length" };
      },
      listModels: ["sonar", "sonar-pro", "sonar-reasoning-pro", "sonar-deep-research"]
    }
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

  /** Send one generation request. Retries on rate limits and server errors. */
  async generate(provider, opts) {
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error("Unknown provider: " + provider);
    if (!opts.apiKey) {
      throw new Error("No API key set for " + AISummary.PROVIDER_LABELS[provider] + ". Add one in Settings → AI Summary.");
    }
    if (!opts.model) throw new Error("No model set for " + AISummary.PROVIDER_LABELS[provider] + ".");
    const req = adapter.buildRequest(opts);
    const delays = [5000, 20000];
    for (let attempt = 0; ; attempt++) {
      const { status, json, retryAfter } = await this.httpJSON("POST", req.url, req.headers, req.body);
      if (status >= 200 && status < 300 && json) return adapter.parseResponse(json);
      const retryable = status === 429 || status === 529 || status >= 500 || status === 0;
      if (retryable && attempt < delays.length) {
        await AISummary.sleep(retryAfter ? Math.min(retryAfter * 1000, 60000) : delays[attempt]);
        continue;
      }
      throw new Error(this.errorMessage(provider, status, json));
    }
  },

  async listModels(provider, apiKey) {
    const spec = this.adapters[provider].listModels;
    if (Array.isArray(spec)) return spec.slice();
    if (!apiKey) throw new Error("Enter an API key first.");
    const { status, json } = await this.httpJSON("GET", spec.url, spec.headers(apiKey), null, 30000);
    if (status < 200 || status >= 300 || !json) throw new Error(this.errorMessage(provider, status, json));
    return [...new Set(spec.parse(json))].sort();
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
