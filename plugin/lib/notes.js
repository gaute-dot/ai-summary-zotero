/* global Zotero, AISummary, markdownit */
"use strict";

AISummary.Notes = {
  _md: null,

  md() {
    if (!this._md) {
      if (typeof markdownit !== "function") throw new Error("markdown-it failed to load");
      // html:false so model output can never inject raw HTML into the note.
      this._md = markdownit({ html: false, linkify: true, typographer: false });
    }
    return this._md;
  },

  escape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  /** Strip a ``` fence wrapping the whole answer, and a leading H1 (the note gets its own). */
  cleanMarkdown(text) {
    let t = String(text || "").trim();
    const fence = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    if (fence) t = fence[1].trim();
    t = t.replace(/^#\s+[^\n]*\n+/, "");
    return t;
  },

  summaryTitle(preset) {
    return AISummary.NOTE_PREFIX + " · " + preset.name;
  },

  qaTitle(question) {
    const q = question.replace(/\s+/g, " ").trim();
    return AISummary.QA_PREFIX + " · " + (q.length > 80 ? q.slice(0, 77) + "…" : q);
  },

  buildHTML({ title, markdown, citations, footer, question }) {
    let html = "<h1>" + this.escape(title) + "</h1>\n";
    if (question) html += "<blockquote><p><strong>Question:</strong> " + this.escape(question) + "</p></blockquote>\n";
    html += this.md().render(this.cleanMarkdown(markdown));
    if (citations && citations.length) {
      html += "<h2>Sources</h2>\n<ol>\n" + citations.map(c =>
        '<li><a href="' + this.escape(c.url) + '">' + this.escape(c.title || c.url) + "</a></li>"
      ).join("\n") + "\n</ol>\n";
    }
    if (footer) html += "<hr>\n<p><em>" + this.escape(footer) + "</em></p>\n";
    return '<div data-schema-version="9">' + html + "</div>";
  },

  findByTitle(parent, title) {
    const notes = Zotero.Items.get(parent.getNotes());
    return notes.find(n => n && !n.deleted && n.getNoteTitle() === title) || null;
  },

  tagsFor(settings, provider, model) {
    const tags = [];
    if (settings.tagNotes && settings.noteTag) tags.push(settings.noteTag);
    if (settings.tagWithModel && model) tags.push("ai:" + model);
    return tags;
  },

  async save({ parent, existing, html, tags }) {
    const note = existing || new Zotero.Item("note");
    if (!existing) {
      note.libraryID = parent.libraryID;
      note.parentID = parent.id;
    }
    note.setNote(html);
    for (const tag of tags) note.addTag(tag);
    await note.saveTx();
    return note;
  }
};
