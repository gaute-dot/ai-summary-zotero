/* global Zotero, AISummary */
"use strict";

/**
 * Literature search in open scholarly databases, and adding results to Zotero.
 * Google Scholar has no API (and blocks automated queries), so it is offered
 * as a link that opens the same search in the browser.
 */
AISummary.LitSearch = {
  SOURCES: {
    openalex: "OpenAlex",
    semanticscholar: "Semantic Scholar",
    arxiv: "arXiv",
    crossref: "Crossref"
  },
  LIMIT: 20,

  isoDaysAgo(days, now = new Date()) {
    const d = new Date(now.getTime() - days * 86400000);
    return d.toISOString().slice(0, 10);
  },

  scholarURL(query) {
    return "https://scholar.google.com/scholar?q=" + encodeURIComponent(query);
  },

  /** { url, responseType } for a search. opts: { recent: bool, limit, now } */
  buildRequest(source, query, opts = {}) {
    const q = encodeURIComponent(String(query).trim());
    const limit = opts.limit || this.LIMIT;
    const now = opts.now || new Date();
    const since = this.isoDaysAgo(365, now);
    switch (source) {
      case "openalex": {
        let url = "https://api.openalex.org/works?search=" + q + "&per-page=" + limit
          + "&select=id,doi,display_name,publication_year,publication_date,authorships,primary_location,cited_by_count,abstract_inverted_index,type";
        if (opts.recent) url += "&filter=from_publication_date:" + since + "&sort=publication_date:desc";
        return { url, responseType: "json" };
      }
      case "semanticscholar": {
        let url = "https://api.semanticscholar.org/graph/v1/paper/search?query=" + q + "&limit=" + limit
          + "&fields=title,authors,year,venue,abstract,citationCount,externalIds,url,publicationDate";
        if (opts.recent) url += "&year=" + (now.getFullYear() - 1) + "-";
        return { url, responseType: "json" };
      }
      case "arxiv": {
        const terms = String(query).trim().split(/\s+/).filter(Boolean)
          .map(t => "all:" + encodeURIComponent(t.replace(/["()]/g, "")));
        let url = "https://export.arxiv.org/api/query?search_query=" + terms.join("+AND+")
          + "&start=0&max_results=" + limit;
        url += opts.recent ? "&sortBy=submittedDate&sortOrder=descending" : "&sortBy=relevance";
        return { url, responseType: "text" };
      }
      case "crossref": {
        let url = "https://api.crossref.org/works?query=" + q + "&rows=" + limit
          + "&select=DOI,title,author,issued,container-title,is-referenced-by-count,abstract,URL,type";
        if (opts.recent) url += "&filter=from-pub-date:" + since + "&sort=published&order=desc";
        return { url, responseType: "json" };
      }
    }
    throw new Error("Unknown source: " + source);
  },

  cleanDOI(doi) {
    return doi ? String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim() : "";
  },

  stripTags(s) {
    return this.decodeXML(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  },

  decodeXML(s) {
    return String(s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
      .replace(/&amp;/g, "&");
  },

  /** OpenAlex stores abstracts as {word: [positions]}. */
  invertedToText(inv) {
    if (!inv) return "";
    const words = [];
    for (const [word, positions] of Object.entries(inv)) {
      for (const p of positions) words[p] = word;
    }
    return words.filter(w => w !== undefined).join(" ");
  },

  /** Normalise results to { title, authors[], year, venue, doi, arxiv, url, abstract, citations, source } */
  parse(source, data) {
    switch (source) {
      case "openalex":
        return (data.results || []).map(w => ({
          title: w.display_name || "",
          authors: (w.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean),
          year: w.publication_year || "",
          date: w.publication_date || "",
          venue: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || "",
          doi: this.cleanDOI(w.doi),
          arxiv: "",
          url: (w.primary_location && w.primary_location.landing_page_url) || w.doi || w.id || "",
          abstract: this.invertedToText(w.abstract_inverted_index),
          citations: w.cited_by_count,
          type: w.type || "",
          source
        }));
      case "semanticscholar":
        return (data.data || []).map(p => {
          const ids = p.externalIds || {};
          return {
            title: p.title || "",
            authors: (p.authors || []).map(a => a.name).filter(Boolean),
            year: p.year || "",
            date: p.publicationDate || "",
            venue: p.venue || "",
            doi: this.cleanDOI(ids.DOI),
            arxiv: ids.ArXiv || "",
            url: p.url || "",
            abstract: p.abstract || "",
            citations: p.citationCount,
            source
          };
        });
      case "arxiv": {
        const out = [];
        const entries = String(data).match(/<entry>[\s\S]*?<\/entry>/g) || [];
        const tag = (xml, name) => {
          const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">"));
          return m ? this.decodeXML(m[1]).replace(/\s+/g, " ").trim() : "";
        };
        for (const e of entries) {
          const absURL = tag(e, "id");
          const idMatch = absURL.match(/abs\/(.+?)(v\d+)?$/);
          const published = tag(e, "published");
          out.push({
            title: tag(e, "title"),
            authors: (e.match(/<author>[\s\S]*?<\/author>/g) || []).map(a => tag(a, "name")).filter(Boolean),
            year: published.slice(0, 4),
            date: published.slice(0, 10),
            venue: tag(e, "arxiv:journal_ref") || "arXiv",
            doi: this.cleanDOI(tag(e, "arxiv:doi")),
            arxiv: idMatch ? idMatch[1] : "",
            url: absURL,
            abstract: tag(e, "summary"),
            citations: undefined,
            source
          });
        }
        return out;
      }
      case "crossref":
        return ((data.message && data.message.items) || []).map(it => {
          const parts = (it.issued && it.issued["date-parts"] && it.issued["date-parts"][0]) || [];
          return {
            title: (it.title && it.title[0]) || "",
            authors: (it.author || []).map(a => [a.given, a.family].filter(Boolean).join(" ") || a.name).filter(Boolean),
            year: parts[0] || "",
            date: parts.filter(Boolean).map(n => String(n).padStart(2, "0")).join("-"),
            venue: (it["container-title"] && it["container-title"][0]) || "",
            doi: this.cleanDOI(it.DOI),
            arxiv: "",
            url: it.URL || (it.DOI ? "https://doi.org/" + it.DOI : ""),
            abstract: this.stripTags(it.abstract || ""),
            citations: it["is-referenced-by-count"],
            type: it.type || "",
            source
          };
        });
    }
    return [];
  },

  async search(source, query, opts = {}) {
    if (!String(query || "").trim()) throw new Error("Type something to search for.");
    const req = this.buildRequest(source, query, opts);
    const xhr = await Zotero.HTTP.request("GET", req.url, {
      responseType: req.responseType,
      successCodes: false,
      timeout: 30000,
      headers: { Accept: req.responseType === "json" ? "application/json" : "application/atom+xml" }
    });
    if (xhr.status === 429) {
      throw new Error(this.SOURCES[source] + " is busy (too many requests). Wait a minute, or try another source.");
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(this.SOURCES[source] + " search failed (HTTP " + xhr.status + ").");
    }
    let data = xhr.response;
    if (req.responseType === "json" && typeof data === "string") data = JSON.parse(data);
    if (req.responseType === "text") data = xhr.responseText || data;
    return this.parse(source, data).filter(r => r.title);
  },

  /** Mark results that are already in the library (by DOI, else by exact title). */
  async markInLibrary(libraryID, results) {
    for (const r of results) {
      try {
        const s = new Zotero.Search();
        s.libraryID = libraryID;
        if (r.doi) s.addCondition("DOI", "is", r.doi);
        else s.addCondition("title", "is", r.title);
        const ids = await s.search();
        r.inLibrary = ids.length ? ids[0] : null;
      } catch (e) {
        r.inLibrary = null;
      }
    }
    return results;
  },

  splitName(name) {
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return { name: parts[0], creatorType: "author", fieldMode: 1 };
    const lastName = parts.pop();
    return { firstName: parts.join(" "), lastName, creatorType: "author" };
  },

  /** Add a result to Zotero: full metadata (and open-access PDF) via DOI/arXiv lookup, else from the result itself. */
  async addToZotero(r, libraryID, collectionID) {
    const identifier = r.doi ? { DOI: r.doi } : r.arxiv ? { arXiv: r.arxiv } : null;
    if (identifier) {
      try {
        const t = new Zotero.Translate.Search();
        t.setIdentifier(identifier);
        const translators = await t.getTranslators();
        if (translators && translators.length) {
          t.setTranslator(translators);
          const items = await t.translate({
            libraryID,
            collections: collectionID ? [collectionID] : false,
            saveAttachments: true
          });
          if (items && items.length) return items[0];
        }
      } catch (e) {
        AISummary.log("Identifier lookup failed, adding basic metadata instead: " + e);
      }
    }
    const type = r.arxiv ? "preprint" : "journalArticle";
    const item = new Zotero.Item(type);
    item.libraryID = libraryID;
    const set = (field, value) => {
      if (!value) return;
      try { item.setField(field, String(value)); } catch (e) { /* field not valid for type */ }
    };
    set("title", r.title);
    set("date", r.date || r.year);
    set("DOI", r.doi);
    set("url", r.url);
    set("abstractNote", r.abstract);
    if (type === "journalArticle") set("publicationTitle", r.venue);
    else set("repository", "arXiv");
    if (r.arxiv) set("archiveID", "arXiv:" + r.arxiv);
    item.setCreators(r.authors.slice(0, 100).map(n => this.splitName(n)));
    if (collectionID) item.setCollections([collectionID]);
    await item.saveTx();
    return item;
  },

  /** Text for asking the AI about a result list. */
  resultsForPrompt(results, maxAbstract = 700) {
    return results.map((r, i) => {
      const by = r.authors.slice(0, 3).join(", ") + (r.authors.length > 3 ? " et al." : "");
      const abs = r.abstract ? (r.abstract.length > maxAbstract ? r.abstract.slice(0, maxAbstract) + "…" : r.abstract) : "(no abstract)";
      return "[R" + (i + 1) + "] " + r.title + " — " + [by, r.year, r.venue].filter(Boolean).join(", ")
        + (r.doi ? " — doi:" + r.doi : "") + "\n" + abs;
    }).join("\n\n");
  }
};
