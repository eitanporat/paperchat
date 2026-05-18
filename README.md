# paperchat

A PDF reader with two ways to read with LLMs:

- **Threads** — select a passage, start a discussion in the margin.
  Invite different models with `@mentions` (`@claude`, `@grok`, `@gpt`,
  `@code`). Inspired by [Fermat's Library][fermat].
- **Chapter summaries** — drop a PDF, get a standalone interactive site
  for the chapter — one section per concept, interactive figures, 3D
  models, math, review flashcards. [**Live demo →**][demo]

[fermat]: https://fermatslibrary.com/
[demo]: https://eitanporat.github.io/paperchat/chapters/crystalline-solids/

![paperchat demo](assets/demo.gif)

*(4× speed — threads)*

Everything stays in your browser — PDFs, threads, settings. No
server-side database.

## Threads

- **Multiple models in one conversation** — `@mention` different agents
  to bring them into the thread.
- **Built-in tools** — the agents can search inside the paper, look up
  arXiv references, browse web pages, run Python, scroll the viewer,
  and highlight passages for you.
- **`@code`** — lets Claude run shell commands and edit files in a
  dedicated workspace, for deeper paper-aware tasks.

## Chapter summaries

A planner reads the chapter, decides the sections, then runs one writer
per section in parallel. Each writer produces a self-contained
interactive page with figures, math, 3D models, definitions, and
review cards. The output is a static website — that's literally what
the [live demo][demo] is.

Roughly per ~40-page chapter:

| Model                       | Cost   |
| --------------------------- | ------ |
| Claude Opus                 | ~$1.50 |
| Kimi K2.6 (OpenRouter)      | ~$0.30 |
| GLM-5.1 (OpenRouter)        | ~$0.50 |
| DeepSeek V4 (OpenRouter)    | ~$0.20 |

In ⚙ Settings, pick a planner + writer model, drop a PDF, click
**Summarize**.

## Getting started

```sh
curl -fsSL https://raw.githubusercontent.com/eitanporat/paperchat/main/install.sh | bash
```

The installer clones to `~/paperchat`, installs dependencies, and asks
for an [OpenRouter](https://openrouter.ai/keys) API key. After that:

1. Open <http://localhost:5173>.
2. Drop a PDF.
3. For a **thread**: select a passage and click `@claude`, `@grok`, or
   `@gpt`. On macOS, `@code` works automatically against your local
   `claude` CLI.
4. For a **chapter summary**: open ⚙ Settings, pick a planner + writer
   model, then click **Summarize** on the chapter chip. Output lands in
   `cc-workdir/chapter-<id>/`.

Manual install:

```sh
git clone https://github.com/eitanporat/paperchat.git
cd paperchat
npm install
npm run dev
```

## Security

The dev server is intended for **localhost only** — don't expose it on
a public interface. `@code` runs with full filesystem and shell access
inside its sandbox directory. Treat as semi-trusted.

## License

MIT — see [LICENSE](LICENSE).
