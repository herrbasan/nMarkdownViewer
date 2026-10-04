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
  js/prefs.js           persistent prefs (Electron: userData/prefs.json; browser: localStorage)
  js/lib/nspeech-client.js   vendored nSpeech SDK (SpeechPlayer) — from LLM-Gateway-Chat lib/tts
  js/md-serializer.js   HTML → Markdown (ours, highest-risk module)
  modules/nui_wc2/      NUI submodule (read-only; upstream work on branches)
  modules/electron_helper/   Electron IPC helper submodule (M5)
config.json             nSpeech endpoint, voice, chunk size
docs/nMarkdownViewer_SPEC.md   spec + dev plan (authoritative)
scripts/serve.js        zero-dep static dev server
scripts/create-release.ps1   GitHub release publisher (gh CLI): build + release with
                             RELEASES/nupkg/setup assets the updater consumes
```

## Auto-Update (SoundApp pattern)

Packaged builds check GitHub releases (`herrbasan/nMarkdownViewer`) on startup
(~1.5 s in, silent; splash window only when a newer tag exists). Machinery lives
in the `electron_helper` submodule (`update.js`): compares tag semver against
`app.getVersion()`, downloads `RELEASES` + `*-full.nupkg` from the release
assets to temp, then feeds that folder to Squirrel's `autoUpdater`.
Manual check: config pane → Updates (Electron-only section). Releases are
published with `scripts/create-release.ps1 -Notes "..."` (requires clean,
pushed `master`; refuses if the tag exists).

## Known Risk Areas

- **md-serializer round-trip fidelity** — `htmlToMarkdown(markdownToHtml(md))`
  must be stable for the NUI markdown subset. M2 adds a fixture corpus.
- **nui markdownToHtml XSS caveat** (no URL scheme validation) — fine for local
  files, revisit before ever rendering untrusted content.
- **nSpeech port/CORS** — see Open Questions in the spec.

## File Types — the display table

`app/js/file-types.js` is the single extension → kind table. Everything that
can open a file consults it: the tree, drop, the OS file handoff, the open
dialog and link routing. A file reached five different ways renders
identically because there is only one answer to ask.

| kind | extensions | chrome |
|------|-----------|--------|
| `markdown` | `.md` `.markdown` | `nui-markdown`, the WYSIWYG editor stays available |
| `image` | png jpg gif webp avif bmp ico svg | fills the pane, `object-fit: contain` |
| `video` | mp4 webm ogv mov m4v mkv | fills the pane, `object-fit: contain` |
| `audio` | mp3 wav ogg oga flac m4a aac opus | card at 40rem — no picture, so width would be dead space |
| `text` | txt log json **jsonl** ndjson js ts css php py sh sql yaml … | `nui-code-editor`, read-only, full width |
| `html` | html htm xhtml xml | **sandboxed iframe**, full content width |
| `docx` | docx | unpacked and converted, reads like a document |
| `pdf` | pdf | rendered in-page by **pdf.js** (vendored) |
| `unsupported` | everything else, incl. legacy `.doc` | *shown*, with an "Open in default app" button |
| — | (no entry) | a link, which still goes to the OS handler |

- **Syntax highlighting has two sources and one vocabulary.** NUI's addon
  owns five dialects (html/xml, css, js, ts, json); `app/js/highlight.js` adds
  php, python, shell, powershell, sql, c, cpp, java, csharp, go, rust, ruby,
  yaml, ini and diff. Both emit the same `hl-*` classes, so one stylesheet
  covers them. `NUI_LANGS` decides which one runs — a supported language is
  never handed to the app highlighter, so the two cannot drift.
- **`.jsonl` is highlighted as json.** A JSON Lines file is not valid JSON as
  a whole, but every value is and the token rules are per-value.
- **The text view owns its scrolling.** `nui-code-editor` already scrolls
  internally (`.nui-code-editor-wrap` is `overflow: auto`) but *only* when it
  has a definite height — otherwise its `height: 100%` resolves to auto, the
  wrap never scrolls, and the PAGE does. Boxed to the pane, a long line is
  reachable sideways at any point in the file.
- **`.docx` is read as bytes and converted** (`app/js/docx.js`): the ZIP
  central directory is walked, `word/document.xml` is inflated, and the
  WordprocessingML becomes real DOM nodes via `textContent` — never
  `innerHTML` over untrusted XML. Headings, bold/italic/underline, bullets
  and breaks render; tables and images do not. Legacy `.doc` is a binary OLE2
  compound file with no honest in-process reader, so it goes to the OS —
  which is Word, the right answer anyway.
- **A file with no viewer is shown, not refused.** The user picked it
  deliberately — dropped it, double-clicked it, clicked it in the tree — and a
  status line is not an answer. The view names it and offers the one action
  that still works. The button needs both the Electron shell *and* a real
  path; a browser handle, or a file from the open dialog, has neither, so it
  is omitted rather than shown broken.
- **Image, video and text ask for `breakout`.** That is the theme's own way to
  let a child of `nui-page` span the full content width instead of being
  letterboxed into the reading measure.
- **`nui-media-player` has no intrinsic height and ships `object-fit: cover`.**
  Two things follow. The card is a grid (`minmax(0, 1fr) auto`) so the player
  stretches to the pane as a grid item — no styling of the component needed.
  And a bare `1fr` is *not* enough: it floors the row at its content's
  min-content size, which for a `<video>` is its intrinsic height at full
  width, so a tall video overflows anyway. `cover` would also crop it, so the
  native element gets `object-fit: contain`.
- **Binary kinds are never read as text.** A JPEG decoded as UTF-8 is
  corruption and a large video read into the renderer is the slow path. The
  adapters expose `assetUrl(path, handle)`: Electron builds a `raum:///` URL
  the helper's protocol serves from disk, the browser mints an object URL from
  the handle and revokes it when the document changes.
- **HTML runs in a sandboxed iframe, never in our document.** This window has
  `nodeIntegration: true`, so injecting a `.html` file into the page would
  hand any script on disk full Node access. `sandbox="allow-scripts"` without
  `allow-same-origin` gives real rendering and an opaque origin — the parent
  cannot even read `contentDocument` back.
- **`nui-code-editor` is contenteditable and has no read-only switch.** Its
  `value` setter writes into DOM that `connectedCallback` builds, so the value
  can only be assigned once the element is *connected*. It is also set
  `contenteditable="false"` after mount: a file opened for viewing must not
  invite edits that go nowhere.
- The highlighter knows five languages (html/xml, css, js, ts, json). Anything
  else is escaped and left plain rather than mis-coloured.
- **PDF is rendered by pdf.js, and it is pinned to 4.10.38.** Chromium's own
  viewer is gated on `webPreferences.plugins` (default **false**), and even with
  it enabled Electron 41's viewer bundle fails to start —
  `sandboxed_renderer.bundle.js script failed to run` / `object null is not
  iterable` — so `<embed>`, `<iframe>`, `<object>` and `<webview>` were each
  measured and none of them paint. pdf.js is a **renderer**, not a plugin,
  which is the only reason it works. It is the app's one vendored third-party
  dependency (`app/modules/pdfjs/`, Apache-2.0, ~3.6 MB, loaded on demand).
- **Do not upgrade pdf.js to 6.x against Electron 41.** The 6 series calls
  `Math.sumPrecise`, an ES2025 built-in V8 here does not have. The call site is
  inside the WORKER, which has its own global scope, so a shim in the app
  cannot reach it — the version itself has to be compatible. 4.x uses the
  older `render({ canvasContext, viewport })`; the `canvas` key is 5.x+ and
  sends 4.x down a Node-only path ("canvas is not defined").
- **A PDF is read as bytes, never as a URL.** `fetch()` over `raum://` is
  CORS-blocked from a `file://` origin, so handing pdf.js a URL fails for a
  reason that looks like a corrupt file.
- **The viewer needs the scroller to exist before it measures fit-width.**
  Page boxes are created first, then the scale is computed: measuring a scroller
  that has no children yet produced a 222% "fit" on an A5 page. (222% is
  correct once the boxes exist — the page is 397x595pt, not A4.)
- **A pdf.js view must be pointed at its own host, never at the page.** The
  view REWRITES its host's contents; handing it `el.page` wipes the page and
  leaves no `#viewer` for the next `renderView()` to remove, so the PDF chrome
  survives into the following document. It looked correct and was not.
- **The text layer is not decoration.** Each page is a canvas with a
  transparent positioned text layer over it; without it the page is a picture —
  nothing selectable, searchable or copyable. The page box is set explicitly on
  mount, because deriving it from page geometry once reported page 42 of 84 on
  a freshly opened document.
- **The OS handoff takes any file, not just `.md`.** `fileArgFrom(argv)` picks
  the first argument that is an absolute path to an existing *file*; matching
  a `.md` extension instead would drop every image and video the user
  double-clicks and silently fall through to the startup folder. Whether the
  viewer can display it stays the stage's question.

## Link Handling

`nui-markdown` emits bare `<a href>` (no `target`), so `app.js` is the only
routing point. One delegated `click`/`pointerover` pair on `#page` survives
every document re-render into the viewer.

| href | destination |
|------|-------------|
| `http`/`https`/`mailto` | `shell.openExternal` — the **system** browser |
| local, displayable by us | a **new** nMarkdownViewer window |
| any other local file | `shell.openPath` (OS handler for that type) |
| `#fragment` | left to the browser (in-document) |

"Displayable" is `isDisplayable()` from `file-types.js` — the same table the
viewer itself uses, so a linked `.png` opens the way a dropped `.png` does.

- **The OS is a boundary.** `shell.openPath` signals failure by *resolving* to
  an error string, so `open-local` throws on it; the stage catches and reports
  in the status bar. Never let a rejected invoke vanish.
- **The linked document travels in `?file=`.** `env` is a process-global, so a
  second window reading `env.filePath` would get the *first* window's document.
  The helper's `browserWindow()` loads via `loadFile()`, which cannot carry a
  query — hence `loadURL` with a `pathToFileURL` href.
- **New windows do not call `trackWindowState`** — one `window-state.json`
  belongs to the main window; a second writer fights it on every move.
- **The close button closes a window, it does not quit the app.** It used to
  call `electron_helper.app.exit()`, which is only equivalent when one window
  exists; with linked documents open it took every window down with it. The
  quit is Electron's business — it ends the process when the last window goes.
- **`mainWin` is not "the window".** Linked windows outlive it, so the OS
  file-handoff resolves its target through `liveWindow()` and `mainWin` is
  nulled on `closed` — a destroyed BrowserWindow throws when asked for its
  state.
- **`installNavigationGuards` (main.js) is the backstop.** Anything the stage
  misses (ctrl/middle-click, raw HTML in a document) would otherwise navigate
  the window off `app/index.html` and leave a frame with no way back. Web URLs
  are handed to the OS browser; everything else is refused.
- Browser shell: web links open a tab (`window.open`); local links report that
  no path is available — File System Access handles carry no path. Wiring the
  listeners unconditionally is deliberate: an unrouted anchor navigates the
  window to the href, which in the browser means the app is simply gone.
- Status bar shows the hovered destination in a second slot (`#hover-url`),
  resolved to an absolute path so it matches what the click will do.

## Debugging Gotchas (learned the hard way)

- **`SyntaxError: Unexpected token ','` (bare, no stack) = a *parse* error in a JS file, NOT an Electron/preload/contextIsolation issue.** Don't blame the shell or the `electron_helper` submodule. Find the offending file:line.
- **Reproduce in the browser, not Electron.** `node scripts/serve.js` → open `http://127.0.0.1:5581/` (Chrome). Read the exact location via CDP `Runtime.exceptionThrown` (`url`, `lineNumber`, `columnNumber`) — Playwright's `pageerror` gives the message but often no stack for parse errors. The Electron renderer parses the module graph identically to the browser, so if it breaks in Electron it breaks here too.
- **`node --check` is NOT the oracle.** It checks CJS script syntax; it does not reliably reproduce the ESM-module parse the browser uses, so it can pass while the page still fails to load. The browser/Electron load is the real oracle.
- **A multi-region edit to `app.js` can silently corrupt a *different* region** — a residual fragment glued into a function you didn't intend to touch (e.g. `=> {, .dirname(filePath);` on the `os-open-file` handler). After any edit, re-read the entire enclosing function, not just the span you think you changed.
- **`app.js` is the stage; Electron main is a thin shell.** A startup failure is far more likely a typo in `app/js/app.js` than in `app/js/main.js` or the `electron_helper` submodule.
- 2026-09-09 incident: stray `, .dirname(filePath);` glued onto a `=> {` at `app.js:147` broke startup with the above error. Root cause was a single edit fragment, not the framework.
- **A 0-byte `prefs.json` is an *interrupted write*, not a corrupt-settings problem.** A bare `fs.writeFile` truncates the target to zero bytes *before* writing, so a quit/crash mid-write — including the `pagehide` flush racing app exit — leaves an empty file. `boot()` calls `prefs.init()` **before** `appWindow(...)`, so `JSON.parse('')` throwing aborts boot right there: the raw `nui-app` shell renders with **no titlebar/statusbar and no listeners** (TTS pane dead, no file opens). Fixed 2026-09-13: `app/js/prefs.js` writes a `.tmp` sibling then renames over the target, serialized through a promise chain — the target is never opened for writing, so it cannot be truncated. Reset by deleting `%APPDATA%\nmarkdownviewer\prefs.json`.
- 2026-09-13 incident: that 0-byte `prefs.json` broke startup exactly as above; the user's first instinct — "a destroyed config stopped initialization partway" — was correct.
- **`appWindow()` wipes `document.body`.** With the default target it runs `document.body.innerHTML = ''`, so any static markup that is a direct child of `<body>` (e.g. a `<nui-dropzone>` overlay) is silently destroyed at boot — the element simply never exists, no error. Create such elements in JS *after* the `appWindow(...)` call; core NUI components self-upgrade on dynamic insertion. (2026-09-20, full-window drag & drop.)
- **Drag & drop in Electron: `File.path` is gone** (removed in modern Electron). Use `webUtils.getPathForFile(file)` — exposed on the `nmdv_node` bridge in [app/index.html](app/index.html). Dropped folders arrive as `File` entries too; `fsp.stat` decides file vs. directory.
- **`fetch()` over `raum://` is CORS-blocked** from a `file://` origin. Media elements are fine (they load via `src`, not `fetch`), but don't reach for `fetch` to read an asset back — read the file with `nfs` instead.
- **A custom element's `value` setter can run before its DOM exists.** `nui-code-editor` builds its children in `connectedCallback`; assigning `.value` first throws `Cannot set properties of undefined (setting 'innerHTML')` at `renderBlock`. Append, *then* assign.

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
