# nMarkdownViewer

A desktop Markdown viewer and editor with text-to-speech.

- Opens and renders `.md` files (headings, tables, code blocks, frontmatter)
- Structure-aware editing (sections, blocks, columns, frontmatter) that saves
  back to plain Markdown — nothing is stored unless you press Save
- Images, audio and video referenced by documents resolve from disk (paths
  beside the document, or absolute — picked from anywhere)
- Reads documents aloud using a local-network nSpeech TTS server
- Double-click a `.md` (or any supported file) to open it — Electron shell with
  file association and auto-update

Built with [NUI web components](https://github.com/herrbasan/nui_wc2) and the
[electron_blank](https://github.com/herrbasan/electron_blank) boilerplate.

## Run (development, browser)

```
git clone --recursive …
node scripts/serve.js
```

Open http://127.0.0.1:5581/ in Chrome or Edge. The TTS server address is set in
`config.json`.

## Install

Grab the setup from the
[latest release](https://github.com/herrbasan/nMarkdownViewer/releases/latest)
or install via the in-app updater (config pane → Updates). The app checks
GitHub releases on startup and offers the newer version automatically.

## Status

v0.4.0 — the blocks editor is live in both shells. Known rough edges (the
media library is a demo, some icon paths render alt text) are being test
driven; see `docs/nMarkdownViewer_SPEC.md` for the plan and `Agents.md` for
the technical briefing.

## License

MIT
