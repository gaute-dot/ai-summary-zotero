/* global Zotero, IOUtils, AISummary */
"use strict";

/** Collects metadata and article content for a regular Zotero item. */
AISummary.Context = {
  MAX_PDF_BYTES: 30 * 1024 * 1024,

  field(item, name) {
    try {
      return item.getField(name) || "";
    } catch (e) {
      return "";
    }
  },

  vars(item) {
    const f = n => this.field(item, n);
    const authors = item.getCreators()
      .map(c => (c.name ? c.name : [c.lastName, c.firstName].filter(Boolean).join(", ")))
      .filter(Boolean)
      .join("; ");
    let year = "";
    try {
      year = (item.getField("date", true, true) || "").slice(0, 4);
      if (year === "0000") year = "";
    } catch (e) { /* no date */ }
    let itemType = item.itemType;
    try {
      itemType = Zotero.ItemTypes.getLocalizedString(item.itemType) || item.itemType;
    } catch (e) { /* keep raw */ }
    return {
      title: f("title"),
      authors,
      year,
      date: f("date"),
      publication: f("publicationTitle") || f("bookTitle") || f("proceedingsTitle")
        || f("websiteTitle") || f("university") || f("publisher"),
      itemType,
      doi: f("DOI"),
      url: f("url"),
      abstract: f("abstractNote"),
      tags: item.getTags().map(t => t.tag).join(", ")
    };
  },

  /** Attachments ordered best-first: the "best" attachment, then PDFs, EPUBs, snapshots. */
  async attachments(item) {
    const out = [];
    try {
      const best = await item.getBestAttachment();
      if (best) out.push(best);
    } catch (e) { /* older API */ }
    const rank = a => {
      const t = a.attachmentContentType || "";
      if (t === "application/pdf") return 0;
      if (t === "application/epub+zip") return 1;
      if (t.startsWith("text/html")) return 2;
      return 3;
    };
    const others = Zotero.Items.get(item.getAttachments())
      .filter(a => a && !a.deleted && !a.isTopLevelItem() && a.isFileAttachment && a.isFileAttachment())
      .sort((a, b) => rank(a) - rank(b));
    for (const a of others) if (!out.some(o => o.id === a.id)) out.push(a);
    return out;
  },

  async attachmentText(att) {
    let text = "";
    try {
      text = (await att.attachmentText) || "";
    } catch (e) {
      AISummary.log("attachmentText failed for " + att.key + ": " + e);
    }
    if (!text && att.attachmentContentType === "application/pdf" && Zotero.PDFWorker) {
      try {
        const res = await Zotero.PDFWorker.getFullText(att.id);
        text = (res && res.text) || "";
      } catch (e) {
        AISummary.log("PDFWorker.getFullText failed for " + att.key + ": " + e);
      }
    }
    return text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  },

  base64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    // btoa is not always defined in the plugin sandbox; borrow it from a window.
    const encode = typeof btoa === "function" ? btoa : (s => Zotero.getMainWindow().btoa(s));
    return encode(binary);
  },

  async readPdf(att) {
    const path = await att.getFilePathAsync();
    if (!path) return null;
    const info = await IOUtils.stat(path);
    if (info.size > this.MAX_PDF_BYTES) return null;
    const bytes = await IOUtils.read(path);
    const filename = att.attachmentFilename || "article.pdf";
    return { base64: this.base64(bytes), filename };
  },

  /**
   * Returns { vars, text, pdf, source, notes[] } where `notes` are human-readable
   * remarks for the note footer (truncation, fallbacks).
   */
  async collect(item, settings, provider) {
    const ctx = { vars: this.vars(item), text: "", pdf: null, source: "metadata only", notes: [] };
    const atts = await this.attachments(item);

    if (settings.inputMode === "pdf") {
      if (!AISummary.Providers.supportsPdf(provider)) {
        ctx.notes.push(AISummary.PROVIDER_LABELS[provider] + " cannot read PDF files; extracted text was sent instead");
      } else {
        const pdfAtt = atts.find(a => a.attachmentContentType === "application/pdf");
        if (pdfAtt) {
          try {
            ctx.pdf = await this.readPdf(pdfAtt);
          } catch (e) {
            AISummary.log("Reading PDF failed: " + e);
          }
          if (ctx.pdf) {
            ctx.source = "PDF file (" + ctx.pdf.filename + ")";
            return ctx;
          }
          ctx.notes.push("the PDF was missing or larger than 30 MB; extracted text was sent instead");
        }
      }
    }

    for (const att of atts) {
      const text = await this.attachmentText(att);
      if (text.length > 200) {
        const name = att.attachmentFilename || att.getField("title") || "attachment";
        if (text.length > settings.maxChars) {
          ctx.text = text.slice(0, settings.maxChars);
          ctx.notes.push("the article text was cut to " + settings.maxChars.toLocaleString() + " of "
            + text.length.toLocaleString() + " characters (raise the limit in settings to send more)");
        } else {
          ctx.text = text;
        }
        ctx.source = "full text of " + name;
        return ctx;
      }
    }

    ctx.source = ctx.vars.abstract ? "metadata and abstract only" : "metadata only";
    ctx.notes.push("no full text was found; the note is based on " + ctx.source);
    return ctx;
  }
};
