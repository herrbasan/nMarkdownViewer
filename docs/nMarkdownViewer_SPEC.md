# nMarkdownViewer — Spec & Development Plan

## Vision

A desktop Markdown viewer/editor: double-click a `.md` file → it opens rendered,
switchable between faithful rendering (NUI `nui-markdown`) and WYSIWYG editing
(NUI `nui-rich-text`), with one-click text-to-speech of the document via a
LAN-hosted nSpeech instance.

## Architecture

```
Browser phase (now)                    Electron phase (M5)
─────────────────────                  ─────────────────────
scripts/serve.js (static)              electron main (thin bootstrap)
  └─ app/index.html                      └─ same app/index.html
       └─ app/js/app.js (stage)               └─ same stage.js
            │ window.electron_helper?            │ window.electron_helper ✓
            ├─ no  → File System Access API      ├─ argv file path, file assoc,
            │        (open/save in browser)      │  native read/write via helper
            └─ nSpeech over LAN (HTTP)           └─ nSpeech over LAN (unchanged)

Both phases share the same chrome: nui-app-window (appWindow factory)
provides title bar + status bar in every mode; inside it, the nui-app
shell provides header (toolbar), left sidebar (nui-file-tree), and the
content column. The chrome status bar is the single place for status
text and TTS transport — no nui-app-footer.
```

Principles (inherited from Prime Directive):

- **Vanilla JS, zero runtime dependencies.** No TypeScript, no build step.
  Dev-time deps only: Electron + electron-forge (M5), nothing else.
- **Fail fast.** Internal invariants throw. External boundaries (nSpeech, file
  system, user-cancelled dialogs) tolerate variance but leave a visible trace
  in the status bar.
- **The stage owns all logic.** The Electron main process is a shell: window,
  file association, argv handoff. Everything else lives in `app/js/`.
- **Markdown source is the single source of truth.** Rendering is derived;
  editing is a round-trip `md → HTML → md`. The document model is the text,
  never the DOM.

## Components & Integration Points

### NUI (`app/modules/nui_wc2`, git submodule)

| Piece | Role | Notes |
|---|---|---|
| `NUI/nui.js` | core | side-effect import; registers `window.nui`, all core components incl. `nui-markdown` |
| `nui-markdown` | viewer | core component. Renders once on connect (`_processed` guard) — **swap in a fresh element per render**, never mutate a connected one |
| `nui.util.markdownToHtml` | md → HTML | used for edit-mode entry and plaintext extraction |
| `nui.util.parseFrontmatter` | YAML block | `{ raw, data, content }`; `raw` includes the `---` fences and is re-prepended verbatim on save |
| `nui-rich-text` | editor | **addon**: JS import + CSS link both required. HTML contenteditable; `value` getter/setter is HTML. Auto-converts pasted Markdown to HTML |

### nSpeech (LAN service)

- Base URL from `config.json` → `nspeech.baseUrl` (default `http://192.168.0.100:2233`).
- `GET /health` at boot: unreachable → TTS controls disabled + loud status (tolerated boundary).
- `GET /voices` populates the voice selector.
- `GET /tts?text=…&voice_name=…&output_format=mp3` streams audio — used directly
  as `<audio>` element `src`. No SDK, no proxy.
- Playback pipeline: `markdownToText(md)` → sentence-aware chunking
  (`maxChunkChars`, default 800) → sequential `<audio>` playback, one chunk per
  request, stop = teardown of the audio element.

### nui-file-tree (new addon, developed in nui_wc2)

The sidebar file explorer is a **new reusable NUI addon**, built in the
nui_wc2 repo (branch `feature/file-tree`, commit 5c1d392) and consumed
here through the submodule. It is filesystem-agnostic: the host passes a
`readdir(path) → Promise<entries>` provider, the component owns lazy
expansion, ARIA-treeview keyboard navigation, selection, filtering, and
sorting. Static trees work via `loadData()` without a provider.

- Docs: `app/modules/nui_wc2/documentation/addons/file-tree.md`
- Demo: Playground → Addons → File Tree (servable via `scripts/serve.js`:
  `/app/modules/nui_wc2/Playground/index.html#page=addons/file-tree`)
- Browser adapter: `showDirectoryPicker` + async iteration (Chromium)
- Electron adapter (M5): native `fs.readdir` via `electron_helper`
- Our filter: none by default (show everything); `.md`-only available via
  the generic filter API

**Browser-phase constraint:** a file opened via `showOpenFilePicker`
does not expose its parent directory (platform security design). The
tree root therefore needs one explicit folder pick in the browser phase.
Double-click → tree rooted at the file's folder only becomes automatic
with the Electron shell.

### Editor round-trip (the risk area)

`nui-rich-text` edits **HTML**, not Markdown. Loading is trivial
(`markdownToHtml`, or the editor's own `markdown` setter). Saving needs
HTML→Markdown. **NUI ships an experimental one**: the editor's `markdown`
getter (`_htmlToMarkdown`, demo page flags the component as experimental).
`app/js/md-serializer.js` is our more thorough implementation (escaping,
nested lists, tables, blockquotes). **M3 decides** which one survives,
based on the M2 fixture corpus: `htmlToMarkdown(markdownToHtml(md))`
must be semantically stable for the NUI markdown subset: headings,
bold/italic/strike, underline (`<u>` kept as HTML — no Markdown
equivalent), lists (nested, ordered/unordered, loose/tight), blockquotes,
fenced + inline code, tables, links, images, hr, br.

YAML frontmatter never enters the editor: it is split off with
`parseFrontmatter`, held as raw text, and re-prepended verbatim on apply.

### File access

- **Browser phase:** File System Access API (`showOpenFilePicker`,
  `createWritable`, drag & drop via `getAsFileSystemHandle`). Chromium-only —
  acceptable, Electron is Chromium too. API missing → fail loud.
- **Electron phase (M5):** main process receives the file path (file
  association / argv), passes it to the stage via `electron_helper.global.env`;
  stage reads/writes through `electron_helper.tools`. The File System Access
  path stays as fallback.

## Security Notes

- `nui.util.markdownToHtml` has a known XSS caveat (double-quote not escaped,
  no URL scheme validation — workshop memory #812). Documents viewed are local
  user files; acceptable for single-user desktop use, but do not render
  untrusted remote Markdown without revisiting this.
- Dev server (`scripts/serve.js`) is localhost-only, read-only, with path
  traversal guard. It is not part of the shipped app.

## Milestones

- [x] **M1 — Scaffold.** Git repo, nui_wc2 submodule, serve script, config,
  index.html + app shell (open/view/edit/save/listen vertical slice), this
  spec, Agents.md.
- [x] **M1.5 — nui-file-tree component.** New NUI addon (branch
  `feature/file-tree` in nui_wc2): provider-based lazy tree, ARIA treeview,
  filter/sort, Playground demo, verified in browser. Pending: push to
  herrbasan/nui_wc2 (user decision).
- [x] **M2 — App shell rebuild.** nui-app-window chrome (title + status bar)
  wrapping nui-app (header toolbar, nui-file-tree sidebar, content column).
  Right-sidebar overlay **config pane** for TTS (engine incl. cloud providers,
  voice/speed/clean/stitch, prefs in localStorage) following the
  LLM-Gateway-Chat pattern. TTS retargeted to nSpeech v3 API with vendored
  `SpeechPlayer` (MSE progressive playback). **Docked audio player** at the
  bottom of the content area (chat's TtsPlayerHost): timeline scrubbing,
  buffered-lane display while generating, download of the generated MP3
  (named after the document).
- [ ] **M2.5 — Round-trip fixtures.** Test corpus covering the full syntax
  subset, frontmatter handling verified, XSS caveat decision, built-in
  `editor.markdown` vs. our md-serializer bake-off.
- [ ] **M3 — Editor.** md-serializer correctness against the fixture corpus,
  dirty-state UX, save-as, keyboard shortcuts (Ctrl+S, Ctrl+E).
- [ ] **M4 — TTS polish.** Chunk progress details in status bar (SpeechPlayer
  already streams + pauses), listen-from-position, engine-switch messaging.
  RESOLVED 2026-09-07: the `worker_error` 500s were **client-side** — nSpeech
  engines require an explicit voice; there is no working `default`. The pane
  now auto-selects the first real voice (chat-controller pattern) and refuses
  to send without one. Known server data issue: the `AllanF5` voice entry is
  listed but 404s on synthesis (stale cache on Badkid).
- [ ] **M5 — Electron shell.** electron_blank-derived main process,
  `electron_helper` submodule, file association (double-click `.md`), argv
  handoff, native read/write, window state. Package with electron-forge.
- [ ] **M6 — Polish.** Recent files, theme toggle, remember window geometry,
  installer/release pipeline (electron_blank `scripts/` pattern).

## Open Questions

1. **nSpeech API version**: the live instance (Badkid:2233) runs the
   **v3.0.0 branch** (Node rewrite, f5tts engine) — routes differ from the
   GitHub `main` docs (`/health`, `/engine` exist; `/voices`, `/tts` 404).
   TTS integration must target `documentation/API_REFERENCE.md` on branch
   `v3.0.0` (includes an official JS client, `lib/nspeech-client`).
   CORS works (the 404 responses were readable cross-origin).
2. **Underline in round-trip**: `<u>` is kept as raw HTML inside Markdown.
   `markdownToHtml` passes inline HTML through — verify it survives the
   round-trip unescaped.
3. **Edit from click position** (listen from paragraph X): deferred; needs
   block-level source mapping. Candidate for M6.

## Decision Log

| Date | Decision | Why |
|---|---|---|
| 2026-09-07 | Browser-first, Electron last | Per user: debug in browser; Electron is only an OS-integration shell |
| 2026-09-07 | File System Access API for browser phase | Zero-dep, native, Chromium-only (matches Electron later); no server-side write endpoint needed |
| 2026-09-07 | Fresh `nui-markdown` element per render | Component renders once on connect (`_processed` guard); replacing the node is the public-API-safe re-render |
| 2026-09-07 | Frontmatter excluded from rich-text editing | YAML in a WYSIWYG editor is noise; preserved verbatim via `parseFrontmatter().raw` |
| 2026-09-07 | Own HTML→MD serializer | NUI has md→HTML but no inverse; required for saving. Highest-risk module, gets fixture corpus in M2 |
| 2026-09-07 | Markdown text is source of truth, never the DOM | Round-trip model keeps rendering derived and editing auditable |
| 2026-09-07 | File explorer = new `nui-file-tree` addon in nui_wc2 | `nui-link-list` is href-navigation, not a filesystem tree — forcing it would fight the component. Provider design keeps it FS-agnostic and reusable |
| 2026-09-07 | `nui-file-tree` defaults to showing everything | Generic component first; `.md`-only is a host-side filter call |
| 2026-09-07 | nui-app-window chrome in BOTH phases | Same title bar + status bar in browser and Electron; status bar owns status text + TTS transport — no `nui-app-footer` |
| 2026-09-07 | nui-app shell inside the chrome content | Header = toolbar, left sidebar = file tree, content = reading column — the nui-boilerplate layout, no custom layout CSS |
| 2026-09-07 | TTS config in right-sidebar overlay pane | Reader chrome stays clean; pane opens on demand (gear). Pattern taken from LLM-Gateway-Chat's Configuration sidebar |
| 2026-09-07 | Vendored `nspeech-client.js` (SpeechPlayer) over hand-rolled fetch | MSE progressive playback + pause/resume independent of download is solved, production-tested code from the user's own chat project — internalize, don't reinvent |
| 2026-09-07 | Config pane lists local engines only (nspeech sentinel + resident gpu:false) | Cloud engines are paid API calls — excluded from a local document viewer unless explicitly requested. Engine switching stays in the nSpeech dashboard |
| 2026-09-07 | nSpeech v3 server-side `clean` + auto-chunking replaces client-side text extraction/chunking | Server is authoritative (regex clean, transparent long-form stitching) — less client code, single source of cleaning rules |
| 2026-09-07 | Docked TtsPlayerHost (vendored from chat) as THE audio transport | One player chrome for scrub + download; status bar stays text-only. Controller interface = SpeechPlayer subset, no adapter needed |
| 2026-09-07 | Cloud engines listed in the pane (user decision) | Selecting a cloud engine + Listen is the user's explicit paid action — same model as the chat |
