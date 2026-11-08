/* global AISummary */
"use strict";

/**
 * Local keyword search (BM25) over article chunks. Used by chat when the
 * sources are too long to send in full. Runs entirely inside Zotero.
 */
AISummary.Retrieval = {
  CHUNK_CHARS: 1800,
  OVERLAP_CHARS: 200,
  K1: 1.2,
  B: 0.75,

  STOPWORDS: new Set((
    // English
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "may more most no not of on or our so such than that the their them then there these they this those to was " +
    "we were what when where which while who why will with would you your about also any between both each other " +
    "over same some study paper article authors results show shows using used use based " +
    // Norwegian
    "og i det som er en et på til av for med at har ikke de den om var seg fra kan vi men så eller hva hvordan " +
    "hvorfor når hvor hvilke hvilken skal ble blir også etter ved under mellom denne dette disse sine sin"
  ).split(/\s+/)),

  tokenize(text) {
    const out = [];
    const re = /[\p{L}\p{N}]+/gu;
    let m;
    const lower = String(text).toLowerCase();
    while ((m = re.exec(lower))) {
      const t = m[0];
      if (t.length < 2 || this.STOPWORDS.has(t)) continue;
      out.push(t.length > 5 ? this.stem(t) : t);
    }
    return out;
  },

  /** Very light English suffix stripping so "effects"/"effect", "measured"/"measure" match. */
  stem(t) {
    return t.replace(/(ations|ation|ments|ment|ings|ing|ies|ed|es|s)$/, "");
  },

  /** Distinct words worth searching for in the library (longest first, at most `max`). */
  searchTerms(query, max = 8) {
    const words = String(query).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*[\p{L}\p{N}]/gu) || [];
    const uniq = [...new Set(words.filter(w => w.length >= 3 && !this.STOPWORDS.has(w)))];
    return uniq.sort((a, b) => b.length - a.length).slice(0, max);
  },

  /**
   * Rank item IDs by how many search terms they match, giving rare terms
   * more weight. hitsByTerm: Map(term -> [itemID]).
   */
  rankByTerms(hitsByTerm, limit) {
    const scores = new Map();
    for (const ids of hitsByTerm.values()) {
      if (!ids.length) continue;
      const weight = 1 / Math.log(2 + ids.length);
      for (const id of ids) scores.set(id, (scores.get(id) || 0) + weight);
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(e => e[0]);
  },

  /** Split text into overlapping chunks on paragraph boundaries. */
  chunk(text, size = this.CHUNK_CHARS, overlap = this.OVERLAP_CHARS) {
    const paras = String(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let cur = "";
    const push = () => {
      if (cur.trim()) chunks.push(cur.trim());
    };
    for (let p of paras) {
      while (p.length > size) {
        // Very long paragraph: hard split.
        if (cur) { push(); cur = ""; }
        chunks.push(p.slice(0, size));
        p = p.slice(size - overlap);
      }
      if (cur.length + p.length + 2 > size && cur) {
        push();
        cur = cur.slice(-overlap) + "\n\n" + p;
      } else {
        cur = cur ? cur + "\n\n" + p : p;
      }
    }
    push();
    return chunks;
  },

  /**
   * docs: [{ index, title, text }]  ->  index object for search().
   */
  buildIndex(docs) {
    const chunks = [];
    for (const d of docs) {
      if (!d.text) continue;
      this.chunk(d.text).forEach((text, pos) => {
        const tokens = this.tokenize(text);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        chunks.push({ doc: d.index, title: d.title, pos, text, tf, len: tokens.length });
      });
    }
    const df = new Map();
    for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const avgLen = chunks.reduce((s, c) => s + c.len, 0) / (chunks.length || 1);
    return { chunks, df, avgLen, N: chunks.length };
  },

  /** Return chunks ranked by BM25 score for the query, best first. */
  search(index, query) {
    const terms = [...new Set(this.tokenize(query))];
    if (!terms.length || !index.N) return [];
    const scored = [];
    for (const c of index.chunks) {
      let score = 0;
      for (const t of terms) {
        const f = c.tf.get(t);
        if (!f) continue;
        const n = index.df.get(t) || 0;
        const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
        score += idf * (f * (this.K1 + 1)) / (f + this.K1 * (1 - this.B + this.B * c.len / (index.avgLen || 1)));
      }
      if (score > 0) scored.push({ chunk: c, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  },

  /**
   * Pick passages for a question within a character budget. Falls back to the
   * opening chunks of each document when nothing matches. Result is ordered by
   * document and position so the excerpts read naturally.
   */
  select(index, query, budgetChars) {
    let ranked = this.search(index, query).map(r => r.chunk);
    if (!ranked.length) {
      const byDoc = new Map();
      for (const c of index.chunks) {
        if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
        byDoc.get(c.doc).push(c);
      }
      // Round-robin over the first chunks of each document.
      const lists = [...byDoc.values()];
      for (let i = 0; lists.some(l => i < l.length); i++) {
        for (const l of lists) if (i < l.length) ranked.push(l[i]);
      }
    }
    const picked = [];
    let used = 0;
    for (const c of ranked) {
      if (used + c.text.length > budgetChars) {
        if (picked.length) continue;
      }
      picked.push(c);
      used += c.text.length;
      if (used >= budgetChars) break;
    }
    picked.sort((a, b) => a.doc - b.doc || a.pos - b.pos);
    return picked;
  }
};
