# AI Summary for Zotero

A Zotero 7+ plugin that summarises articles with an AI model and saves the result as a **child note** under the item.

Right-click one or more items → **AI Summary** → pick what you want. The plugin reads the article text (or the PDF itself), sends it to the model you chose, and writes a formatted note next to the paper.

## Features

- **Choose the AI provider and model**: Anthropic Claude, OpenAI, Google Gemini or Perplexity. Type any model name, or use **Fetch models** to list the models your API key can use.
- **Your own system prompt**: general rules for every summary (tone, strictness, format, language).
- **Prompt presets**: built-in presets for *Structured summary*, *Short summary (TL;DR)*, *Critical appraisal*, *Methods and data extraction* and *Literature review notes*. Edit them or add your own in settings.
- **Template variables**: `{{title}}`, `{{authors}}`, `{{year}}`, `{{date}}`, `{{publication}}`, `{{itemType}}`, `{{doi}}`, `{{url}}`, `{{abstract}}`, `{{tags}}`, `{{language}}`, `{{fulltext}}`, `{{question}}`.
- **Batch mode**: select many items and summarise them one after another, with a progress window and a *Cancel running job* menu entry.
- **Chat with your sources** (the *AI Chat* section in the item pane, in the library and next to PDFs):
  - chat with one item, with several selected items, or with a whole collection;
  - answers cite sources as [1], [2] (click to jump to the item) and stream in as they are written;
  - quick-question buttons and your presets are one click away;
  - select text in the PDF reader and click **Ask AI** to explain, summarise, translate or critique the passage;
  - save one answer or the whole conversation as a Zotero note.
- **Ask a question (as note)**: type a question about the selected item(s); the answer is saved as an *AI Q&A* note.
- **Duplicate handling**: when an item already has a note from the same preset, choose to be asked, replace it, add another note, or skip.
- **Tags and footer**: notes are tagged (default `AI summary`, optionally also `ai:<model>`), and a footer records the model, date, preset and what input was used.
- **Text or PDF input**: send the extracted full text (all providers), or the PDF file itself (Claude, OpenAI, Gemini), which lets the model see figures and tables.
- **Configurable output language**: English by default; any language, or “the same language as the article”.
- API keys are stored in Zotero’s password manager, not in plain-text preferences.

## Install

1. Download `ai-summary-zotero-<version>.xpi` from the [releases page](https://github.com/gaute-dot/ai-summary-zotero/releases), or build it yourself (below).
2. In Zotero: **Tools → Plugins** → gear icon → **Install Plugin From File…** → choose the `.xpi`.
3. Open **Settings → AI Summary** (Zotero → Settings on macOS, Edit → Settings on Windows/Linux).
4. Paste an API key for at least one provider, choose the provider to use, check the model name, and press **Test**.

API keys:

| Provider | Where to get a key | Default model |
|---|---|---|
| Anthropic Claude | console.anthropic.com | `claude-opus-5-5` |
| OpenAI | platform.openai.com | `gpt-5` |
| Google Gemini | aistudio.google.com | `gemini-2.5-pro` |
| Perplexity | perplexity.ai → API settings | `sonar-pro` |

Model names change often. If a default model is no longer offered, press **Fetch models** and pick a current one.

## Usage

1. Select one or more items in your library (selecting a PDF attachment works too, the note goes to its parent item).
2. Right-click → **AI Summary**:
   - **Summarise: <default preset>**
   - **Summarise with preset ▸** – any of your presets
   - **Ask a question…**
   - **Settings…**
3. The note appears under each item, titled for example `AI Summary · Structured summary`.

The item needs a PDF, EPUB or web snapshot for a full-text summary. Without one, the plugin falls back to metadata and abstract, and says so in the note.

## Chat

- **One item**: select it and open the **AI Chat** section in the right-hand pane (or right-click → AI Summary → *Chat with this item*).
- **Several items**: select them, right-click → AI Summary → *Chat with the N selected items*.
- **A collection**: right-click the collection → *AI Chat with this collection* (items directly in the collection, up to 300).

Zotero hides the item pane when several items are selected, so multi-item and collection chats are **pinned**: the chat stays in the pane while you click single items. Press **Unpin** to go back to chatting with the selected item.

In the PDF reader, select text and click **Ask AI** in the popup. The passage is attached to the chat with shortcuts to explain, summarise, translate or critique it.

**How sources are sent.** If all sources together fit within *Send sources in full up to* (default 250,000 characters, roughly 60,000 tokens), the full text is sent with every question. On Claude it is cached between questions, which makes follow-ups faster and cheaper. Larger chats use a built-in keyword search (BM25) that runs inside Zotero: each question sends only the most relevant passages (default up to 40,000 characters), plus the title and metadata of every source. Nothing extra is uploaded and no extra services are needed.

Chats are kept while Zotero is open. Save the ones you want to keep as notes: a chat with one item is saved as a child note, and a multi-item chat as a standalone note linked to every source (and added to the collection).

## Settings

| Setting | What it does |
|---|---|
| Provider / API key / Model | Which service and model to use. Each provider keeps its own key and model. |
| Summary language | Output language. |
| Send to the model | *Extracted full text*, or *The PDF file itself* (Claude, OpenAI, Gemini; up to 30 MB). |
| Max characters of article text | Longer texts are cut to this length, and the note footer says so. |
| Max output tokens | Upper limit on the answer length. |
| Claude effort | How much the Claude model reasons before answering (low → max). Higher is slower and costs more. |
| Temperature | For OpenAI, Gemini and Perplexity. Empty means the provider default. |
| System prompt | Rules sent with every request. **Restore default** brings back the original. |
| Prompt presets | Create, duplicate, rename, edit, delete; choose the default preset. |
| Chat | Size limits for full text and passages, streaming, chat system prompt, quick-question buttons. |
| Notes | Duplicate handling, tags, footer, pause between items in batch mode. |

### How the request is built

- **System prompt**: your system prompt, with variables filled in.
- **User message**: a metadata block (title, authors, year, publication, DOI, abstract, tags), then the article text inside `<article>…</article>` (or the attached PDF), then the preset instructions, then “Write the response in <language>.”
- If a preset contains `{{fulltext}}`, the article text is placed there instead of being added automatically.

### Writing a preset

```text
Summarise this article for a master's-level course on {{publication}}.
## Main argument
## Method in plain language
## Three discussion questions for students
```

## Privacy and cost

- Article text (or the PDF) is sent to the provider you choose. Do not use it on confidential or embargoed documents unless the provider’s terms allow it.
- Each summary is a paid API call. Long articles, PDF input and higher Claude effort cost more.
- In chat, every question sends the sources again (or the relevant passages). Long conversations over many sources cost more than one summary.
- Perplexity searches the web while answering. Its sources are listed at the end of the note.
- Notes are AI-generated and can contain errors. Check important details against the article.

## Build from source

Requirements: `zip`, `python3`, and Node.js for the tests.

```bash
./build.sh
```

```bash
node test/run.js
```

`build.sh` writes `dist/ai-summary-zotero-<version>.xpi` and `dist/updates.json`. To publish a release, create a GitHub release tagged `v<version>` and attach both files. Zotero then finds updates automatically.

## Project layout

```
plugin/
  manifest.json            Plugin metadata (Zotero 7–9)
  bootstrap.js             Startup / shutdown, loads lib/
  prefs.js                 Default settings
  content/preferences.*    Settings pane
  lib/core.js              Settings, API keys, presets, prompt building
  lib/providers.js         Claude, OpenAI, Gemini, Perplexity adapters
  lib/context.js           Reads metadata, full text and PDFs from Zotero
  lib/notes.js             Markdown → Zotero note HTML
  lib/actions.js           Summarise, batch, Q&A, duplicate handling
  lib/chat.js              Chat sessions, source loading, prompts, saving chats
  lib/chatpane.js          AI Chat item-pane section and the reader "Ask AI" button
  lib/retrieval.js         Local keyword search (BM25) for large chats
  lib/menu.js              Right-click menus
  locale/en-US/            Labels for the item-pane section
test/run.js                Unit tests (no Zotero needed)
```

## Credits

Inspired by [zotero-ai-summary](https://github.com/ajs7270/zotero-ai-summary) (MIT), which connects AI command-line agents to Zotero notes. This plugin calls the AI providers directly from Zotero instead. Bundles [markdown-it](https://github.com/markdown-it/markdown-it) (MIT).

## License

MIT
