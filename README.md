# nMarkdownViewer

A desktop Markdown viewer and editor with text-to-speech.

- Opens and renders `.md` files (headings, tables, code blocks, frontmatter)
- WYSIWYG editing that saves back to plain Markdown
- Reads documents aloud using a local-network nSpeech TTS server
- Double-click a `.md` file to open it (Electron shell, coming in M5)

Built with [NUI web components](https://github.com/herrbasan/nui_wc2) and the
[electron_blank](https://github.com/herrbasan/electron_blank) boilerplate.

## Run (development, browser)

```
git clone --recursive …
node scripts/serve.js
```

Open http://127.0.0.1:5581/ in Chrome or Edge. The TTS server address is set in
`config.json`.

## Status

Early development — see `docs/nMarkdownViewer_SPEC.md` for the plan and
`Agents.md` for the technical briefing.

## License

MIT
