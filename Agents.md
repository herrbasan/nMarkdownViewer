# nMarkdownViewer — Agent Briefing

## Goal

Desktop Markdown viewer/editor with integrated text-to-speech.

- **View** `.md` files rendered via NUI `nui-markdown`
- **Edit** WYSIWYG via NUI `nui-rich-text`, saved back as Markdown
- **Listen** to documents via nSpeech TTS over the LAN
- **OS integration** via Electron shell (built last): double-click a `.md` file opens the viewer

## Current Phase

**Browser-first development (M1 done).** Electron does not exist yet and must
not be created before M5 — see [docs/nMarkdownViewer_SPEC.md](docs/nMarkdownViewer_SPEC.md)
for the full spec, milestone plan, and decision log. The spec doubles as the
development plan; keep it current as decisions are made.

## Run

```
node scripts/serve.js     →  http://127.0.0.1:5581/
```

Chrome/Edge only (File System Access API). nSpeech endpoint is configured in
[config.json](config.json) (`nspeech.baseUrl`); if unreachable, the app runs
with TTS disabled and says so in the status bar.

## Hard Rules

1. **Vanilla JS, zero runtime dependencies.** No TypeScript, no frameworks, no
   build step. Dev-deps (Electron, forge) arrive with M5 and stay dev-only.
2. **Fail fast.** No defensive coding, no silent fallbacks, no swallowed
   `try/catch`. External boundaries (nSpeech, FS, dialog cancel) tolerate
   variance but always leave a visible trace.
3. **Markdown source is the single source of truth.** Rendering is derived;
   the document model is text, never DOM.
4. **All app logic in the stage** ([app/js/app.js](app/js/app.js)). The future
   Electron main process is a thin shell (window, file association, argv).
5. **NUI conventions apply** — the submodule docs are authoritative:
   - Cheatsheet: [app/modules/nui_wc2/LLM-CHEATSHEET.md](app/modules/nui_wc2/LLM-CHEATSHEET.md) (read before touching HTML/CSS)
   - Components: [app/modules/nui_wc2/documentation/components/](app/modules/nui_wc2/documentation/components/)
   - Key rules: every `nui-*` wraps a native element; never style `nui-*`
     components; addons need JS import **and** CSS link; use `data-action`
     for declarative wiring.
6. **Do not edit inside `app/modules/nui_wc2`** — it's a submodule. NUI bugs
   get an issue in `herrbasan/nui_wc2`, not a local patch.

## Layout

```
app/
  index.html            shell (nui-app: toolbar, file-tree sidebar, content, config pane)
  css/main.css          layout only — never nui-* component styling
  js/app.js             stage: all application logic
  js/tts.js             TTS config pane + playback controller
  js/lib/nspeech-client.js   vendored nSpeech SDK (SpeechPlayer) — from LLM-Gateway-Chat lib/tts
  js/md-serializer.js   HTML → Markdown (ours, highest-risk module)
  modules/nui_wc2/      NUI submodule (read-only; upstream work on branches)
  modules/electron_helper/   Electron IPC helper submodule (M5)
config.json             nSpeech endpoint, voice, chunk size
docs/nMarkdownViewer_SPEC.md   spec + dev plan (authoritative)
scripts/serve.js        zero-dep static dev server
```

## Known Risk Areas

- **md-serializer round-trip fidelity** — `htmlToMarkdown(markdownToHtml(md))`
  must be stable for the NUI markdown subset. M2 adds a fixture corpus.
- **nui markdownToHtml XSS caveat** (no URL scheme validation) — fine for local
  files, revisit before ever rendering untrusted content.
- **nSpeech port/CORS** — see Open Questions in the spec.

## Debugging Gotchas (learned the hard way)

- **`SyntaxError: Unexpected token ','` (bare, no stack) = a *parse* error in a JS file, NOT an Electron/preload/contextIsolation issue.** Don't blame the shell or the `electron_helper` submodule. Find the offending file:line.
- **Reproduce in the browser, not Electron.** `node scripts/serve.js` → open `http://127.0.0.1:5581/` (Chrome). Read the exact location via CDP `Runtime.exceptionThrown` (`url`, `lineNumber`, `columnNumber`) — Playwright's `pageerror` gives the message but often no stack for parse errors. The Electron renderer parses the module graph identically to the browser, so if it breaks in Electron it breaks here too.
- **`node --check` is NOT the oracle.** It checks CJS script syntax; it does not reliably reproduce the ESM-module parse the browser uses, so it can pass while the page still fails to load. The browser/Electron load is the real oracle.
- **A multi-region edit to `app.js` can silently corrupt a *different* region** — a residual fragment glued into a function you didn't intend to touch (e.g. `=> {, .dirname(filePath);` on the `os-open-file` handler). After any edit, re-read the entire enclosing function, not just the span you think you changed.
- **`app.js` is the stage; Electron main is a thin shell.** A startup failure is far more likely a typo in `app/js/app.js` than in `app/js/main.js` or the `electron_helper` submodule.
- 2026-09-09 incident: stray `, .dirname(filePath);` glued onto a `=> {` at `app.js:147` broke startup with the above error. Root cause was a single edit fragment, not the framework.

## File Association Pattern (M5, for the next major release)

Proper Windows file associations follow the SoundApp pattern
(`D:\Work\_GIT\SoundApp\js\registry.js`), driven by the user's own
**windows-native-registry** module (`github.com/herrbasan/windows-native-registry`,
v3.2.2, native `.node` addon — works via GitHub release binaries, repo currently
private, to be made public before we depend on it):

1. **Per-filetype ProgID** under `HKCU\Software\Classes\<progid>`:
   description, `DefaultIcon` (per-extension `.ico`), `shell\open\command` =
   `"<exe>" "%1"`, plus `OpenWithProgids` entries on each extension.
2. **Capabilities key** `HKCU\Software\<App>\Capabilities` with
   `ApplicationName`, `ApplicationDescription`, and a `FileAssociations`
   subkey mapping every extension → its ProgID.
3. **RegisteredApplications**: `HKCU\Software\RegisteredApplications`
   `<App>` → capabilities path. This makes the app appear in Windows'
   **Default Programs** UI (openable via
   `control /name Microsoft.DefaultPrograms /page pageDefaultProgram`).
4. Registration is an explicit settings action (register/unregister),
   all HKCU — per-user, no admin, matches Squirrel's install scope.

Current state: `app/js/main.js` has a minimal zero-dep version (plain `reg add`
for `.md`/`.markdown` → ProgID → command, no icons/Capabilities yet). Upgrade
to the full pattern with `windows-native-registry` once the repo is public.
