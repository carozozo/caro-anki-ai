# Caro Anki

Caro Anki (`caro-anki`) is a standalone local flashcard browser with an integrated, collapsible agent panel.
It runs on `127.0.0.1` and ships as the development desktop app `Caro Anki Dev.app`, which carries its
own copy of the official Anki backend. It needs no Anki Desktop, no AnkiConnect, no system Python, and
no separate collection process, and it syncs that collection with AnkiWeb on request.

## Anki collection and AnkiWeb sync

Notes live in a real Anki `collection.anki2`, opened by the official Anki backend that ships inside the
app. `npm run anki:runtime` freezes that backend plus `backend/anki_bridge.py` into
`tmp/anki-runtime/anki-helper/` with PyInstaller, and the desktop build copies the result into
`Caro Anki Dev.app/Contents/Resources/anki-runtime/`. The app passes its location to the backend as
`ANKI_HELPER_PATH`, so the installed app never looks for Anki or Python on the user's machine.

The first collection path defaults to `~/Library/Application Support/Caro Anki/User 1/collection.anki2`, and
`backend/config.js` resolves it, the runtime, and the collection defaults:

- `ANKI_PROFILE_ROOT` — parent directory for Caro-managed collection profiles, and the directory the first
  profile (`User 1`) is created under.
- `ANKI_HELPER_PATH` — an explicit Anki runtime, such as the one in the app bundle.
- `ANKI_BRIDGE_PATH` — the checked-in bridge script, used when no runtime is bundled. Setting it is treated
  as a deliberate override, so a built runtime never silently replaces it.

Every value is optional; without them the bundled runtime is used when it exists, and otherwise the
checked-in bridge runs under `python3`. A missing runtime is reported as `503` with the path it expected,
and the settings dialog names it too.

### Collection profiles

The Anki Settings dialog shows one profile row — the picker with the switch, new-profile, and delete icons — and
below it either the rename field (a profile is selected) or the new-profile field (nothing to select, or the new
icon was clicked). Each managed profile owns one folder under `ANKI_PROFILE_ROOT`, including its
`collection.anki2`, media, and Anki backups. Renaming makes a recovery backup first; creating uses a private
staging folder and only exposes the profile after its collection is valid.

Deleting removes an inactive profile only: the whole folder is copied into
`profile-backups/<profile id>/<timestamp>/` first, and the profile's chat sessions go with it, because they
describe a collection that no longer exists. The active profile is refused with `profile_active`, so switch to
another profile before deleting the one you are leaving; a collection that lives outside `ANKI_PROFILE_ROOT` is
refused with `external_profile`.

Profiles keep these things separate: the collection itself, note-type/duplicate/deck defaults, AnkiWeb account
metadata and Keychain password, and chat sessions with their card versions and exports. Switching reloads the
window after safely closing the old collection. It is refused while a sync, AI turn, or other collection request
is active, so an old workspace cannot write into the newly selected collection. Agent configurations, standing
instructions, skills, and card-profile JSON files remain shared by the local app user.

### AnkiWeb account

Card defaults and the AnkiWeb account are separate dialogs, both for the active collection profile. The
topbar account button carries the current state — a quiet outline while signed out, the accent colour while
signed in — and opens the AnkiWeb dialog, which shows either the sign-in form or the stored account:

- The sign-in form takes the AnkiWeb ID, password, an optional custom sync server, and a sync-media
  preference. **Log in** verifies the credentials with AnkiWeb before anything is stored; the password
  goes to the macOS Keychain (service `com.caro.anki.sync`) and the ID, sync server, and media
  preference go to SQLite. A rejected password leaves the form as typed, and the password is never
  returned to the browser or read from `.env`.
- Once signed in the dialog shows the account and its sync preferences, with a **Log out** action that
  deletes the stored password and clears the ID. The collection and every note stay untouched, and the
  sync preferences are kept for the next sign-in.

The card settings dialog holds only the note type, the duplicate preference, and the Anki runtime state.

The topbar sync button, or `⌘/Ctrl + Y`, runs a sync. AnkiWeb refuses to merge two collections it cannot
reconcile, so a full sync is never chosen automatically: the response reports which directions are
possible and the app asks explicitly, keeping only that side. `FULL_SYNC` offers both directions,
`FULL_DOWNLOAD` offers only downloading AnkiWeb's copy, and `FULL_UPLOAD` only uploading the local one.
A full sync replaces the collection file, so the note list is reloaded afterwards.

The sync button carries the state itself: it turns warn-coloured while a sync is pending, and the
connection pill replaces its "Connected" text with "Unsynced changes" for as long as that lasts (an
in-flight sync or an error message outranks the reminder). This mirrors Anki Desktop's own reminder,
which re-reads the status after every collection change and after every sync rather than on a timer:

- The collection's own stamps answer first. Anki stamps the collection at every write (`mod`) and every
  schema change (`scm`), and remembers the stamp of its last successful sync (`ls`), so unpublished local
  changes never touch the network.
- Only a clean, signed-in collection asks AnkiWeb, through Anki's own `sync_status` call — the app never
  implements the sync protocol itself. Anki caches that answer for five minutes, so the check stays cheap.
- A signed-out account is silent, exactly as in Anki Desktop: with no server to compare against, a pending
  sync is not something the reminder can act on. The account control is what shows the signed-out state,
  and signing in brings the reminder back.
- A failed check keeps the previous state instead of raising a false reminder, so an offline machine or a
  stale password never turns the button warn-coloured.
- Only the server can see changes made elsewhere (a phone, AnkiWeb's web editor), so a collection that is
  clean by its own stamps is re-checked on the next collection change, not while the app sits idle.

- `GET /api/anki/sync-status` — reports `{ required, needsSync }` for the current account and collection.
- `POST /api/anki/sync` `{ "direction": "upload" | "download" }` — syncs; omitting `direction` lets
  AnkiWeb answer with the requirement instead of performing a full sync.
- `POST /api/anki/account/login` `{ username, password, endpoint, media }` — verifies the credentials and
  stores the account.
- `DELETE /api/anki/account` — logs out.

The account routes require JSON and same-origin requests. `GET /api/anki-settings` returns the card
defaults, the account (never the password), and the Anki runtime state.

## anki agent workspace

Quick Search, the note list, and the anki agent share one workspace. Chat opens to the session list;
sending the first message creates a session and switches to its conversation. The composer stays
at the bottom while sessions or messages scroll. History reopens an existing conversation; New
Conversation returns to the session list without creating an empty session. Collapsing Chat preserves
its conversation and input. On narrow screens Chat overlays the browser.

AI can search, create, edit, and delete notes directly. New notes use the collection's current deck
unless the request specifies a deck. Edits preserve unrelated fields and the existing deck. Deleting a note
also removes its generated cards. Discussion and preview requests should not write to the collection.

Anki Agent is optional. Its settings button enables or disables the feature and manages multiple named
DeepSeek configurations. Settings manage the configurations and feature availability; choosing which
configuration a request uses belongs to the Agent workspace. Profile metadata lives in SQLite; each API key
is stored under that profile's ID in macOS Keychain and is never returned to the browser. Agent profiles can
only be configured in the app; `.env` credentials are never used as an Agent fallback. A configuration is
saved only after its required API key has been stored successfully; editing an existing configuration can
leave the API key blank to keep it.

Out of the box the agent handles whatever the request says and nothing more: it will not treat `thickness`
as an instruction to make a card, because that is a convention, not a rule of the tool contract. Conventions
belong to the user. Write them once under `~/.caro-anki/instructions/` and the app feeds them back on every
turn — see [Standing instructions](#standing-instructions) below, and `/instruction` to have the agent draft
one for you, or revise one you already wrote.

Browser and Chat share one selection, but only when it is sent. `⌘ + G` (`Send selected notes to AI chat`)
publishes the current browser selection and shows a removable `Selected N notes` chip above
the composer — the composer itself stays empty, since the IDs travel as `selectionNoteIds` rather than as
typed text. Sending with that selection but no typed request asks the agent to review the selected notes. The next
request sends those IDs so references such as
「這些」/「這兩張」resolve to exactly those notes. The chip keeps that snapshot while you keep browsing,
so selecting other rows does not change it until you send again. Clearing the chip also clears the browser
selection. The assistant still reads every target before writing.

The note list takes selection shortcuts: `⌘A` selects every row in the list while the list panel holds
focus — a click on blank list space focuses it, so an empty selection or a pointer that never touched the
table still selects everything instead of the page text — `Esc` clears the selection,
and `⌘1`–`⌘7` toggle the corresponding Anki flag on every selected note. With nothing selected, `↑`/`↓`
(and the `[`/`]` note buttons) re-enter the list at the row on screen nearest the last selection, or at the
first row on screen for a list that was never selected in, so entering a long list never yanks it to an end
far from where the user is looking (a new search forgets the previous list's position). The two bulk actions open a
centered dialog titled for the action that states how many notes it will change and what the input accepts
— `⌘/Ctrl + D` picks a destination deck and `⌘/Ctrl + U` takes a due time (`1` for tomorrow, or an ascending range like
`1-3`). The dialog reports a failed batch in place so the value can be corrected without reopening it,
and the status bar above the table keeps the last result plus the selected count.

The note editor shows the note's deck as a readout — that toolbar action is the only way to move a note, and
it also sets the deck an unsaved new note is created in.

The note toolbar uses `⌘ + key` on macOS and `Ctrl + key` on Windows/Linux: `[`/`]` move through notes,
`S` searches the selection, `G` sends it to AI, `C` copies it, `Backspace` arms deletion, and `N` starts a note.
Editable controls keep their native shortcuts, and deletion still requires the shortcut or button twice.

The backend runs a bounded JSON command loop with card validation, reads before edits/deletion,
and persisted operation records. The assistant uses returned IDs to refer to actual notes. The note
list refreshes after a request, keeping its search. Each recorded operation lists the affected notes as
term chips (for example `pendulum  artwork  befuddled` under `Create notes · Completed`); clicking a
chip opens that note in the editor. The toolbar's `Send selected notes to AI chat` button (`⌘ + G`) arms the
composer chip with the selection for a follow-up request instead of typing note IDs into the message box.

`POST /api/sessions/:id/chat` accepts `{ "content": "...", "requestId": "unique-client-id",
"selectionNoteIds": [1, 2] }`. `selectionNoteIds` is optional; the server drops non-positive or
duplicate IDs and caps the list at 50.
It requires JSON and same-origin requests. Request IDs are persisted before execution; resending a
completed request returns its stored result. Interrupted requests are never automatically replayed.
The UI retains an unresolved request across reloads in the same tab and can retrieve its result.
Inspect operation history and the collection before issuing another write after an uncertain outcome.

Each session row reveals a delete button on hover. `DELETE /api/sessions/:id` removes one
conversation with its messages, card versions, and export records; it rejects cross-origin requests
and returns `409` while an AI operation is running. `DELETE /api/sessions` still clears every session.

Every destructive control shares one two-click confirm: the first click arms the button in red with a
`Click again to …` label while disarming any other armed control, and a second click on that same
button within three seconds (`timings.confirmArmMs`) runs the action. Clearing every session, deleting
one session, and deleting a note from the list or the editor all use it. The session delete button stays
visible while armed even though it is otherwise revealed only on row hover.

Automated tests use mock AI providers and isolated collections, never the user's normal application data.
The legacy card snapshot/export APIs remain available for existing integrations and stored history.

## Standing instructions

The backend ships one fixed system prompt. It carries the tool contract and the safety rules and nothing
else — no reply language, no card style, no convention about what a bare word means. Those are personal, so
they live with you.

```
~/.caro-anki/instructions/
├── language.md          # reply language and terminology
├── agent-workflow.md    # what counts as a create request, which deck, when to report
└── card-style.md        # field order, wording, examples, phonetics
```

| Rule | Behaviour |
| --- | --- |
| Layout | Flat — files sit directly in the directory, no subfolders |
| Extension | `.md` only; dotfiles and other extensions are ignored |
| Order | Sorted by filename ascending; the order is the order in the prompt |
| Frontmatter | None — the file is the text, verbatim |
| Size | 16000 characters each, then truncated |
| Empty files | Skipped |
| Re-read | Every request, so an edit applies immediately with no restart |

Set `CARO_INSTRUCTIONS_DIR` to use a different folder. If the directory is missing the app creates it, and
the agent simply runs without instructions. A file that cannot be read is skipped and logged to the backend's
stdout; it never blocks a request.

The files are appended to the prompt under `## User instructions`, framed as preferences rather than
permissions: they govern how the agent behaves and what the cards it writes should look like, but they cannot
add a tool, weaken the read-before-write rule, or make an invented field real. To write one, ask the agent —
`/instruction` interviews you and prints the file: a new topic, or the smallest edit to one you already have.
You never have to know what is already in the directory, because the agent reads it on every turn.

Skills are the other half of this: `/skill` authors on-demand procedures — a new one, a revision, a rename, or a
retirement — and `card-audit` reviews notes against the card contract. See [skills/README.md](skills/README.md)
for the comparison and the format.

## Requirements

- Node.js 26 or newer for the built-in `node:sqlite` module.
- Python 3.9 or newer only to *build* the Anki runtime (`npm run anki:runtime`). The built app needs
  neither Python nor Anki Desktop.

## Fresh macOS setup

After downloading or cloning the repository, one command prepares the complete development environment:

```sh
sh scripts/sh/bootstrap-macos-dev.sh
```

The bootstrap installs Homebrew, uses it to install NVM, and uses NVM to install Node.js 26. When Python 3.9+
is unavailable, it also uses Homebrew to install Python 3.13. It creates `.env` without replacing an existing
one, installs npm dependencies, builds the bundled Anki runtime, installs `/Applications/Caro Anki Dev.app`, and
runs the syntax check and automated tests. The Homebrew installer may request the macOS administrator password
on a new Mac.

Run the bootstrap once for a new checkout. For normal rebuilds after that, use `npm run desktop:install-dev`.

## Manual setup

```sh
cp .env.example .env
npm install
npm run anki:runtime
npm run validate
npm start
```

Open <http://127.0.0.1:8788> in a browser. Skip `npm run anki:runtime` only if the `python3` on your PATH
already carries the `anki` package; the checked-in bridge then runs under it.

The server creates the SQLite database at `sqlite/data/anki-ai.sqlite` by default. Conversations, saved
card versions, exports, app settings, and Agent records live there; notes and decks live in the Anki
collection file described above. Both the database path and `tmp/` are ignored by git.

The current conversation endpoint is `POST /api/sessions/:id/chat`. Agent configuration is exposed through
`GET/PUT /api/agent-settings` and `POST/PUT/DELETE /api/agent-profiles`; API responses only expose
`hasApiKey`, never the stored secret. The legacy `/messages` endpoint returns `410`; all Agent requests use
the active in-app profile through `/chat`.

## npm scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the backend server on `127.0.0.1` (port 8788 by default). |
| `npm run dev` | Run the backend with `--watch`, restarting when backend files change. |
| `npm run check` | Syntax-check every JavaScript file under `backend/`, `frontend/`, `sqlite/`, `desktop/`, and `scripts/`. |
| `npm test` | Run `backend/test/*.test.js` with mock providers, isolated databases, and a stub Anki bridge. |
| `npm run validate` | Run both the JavaScript syntax check and automated test suite. |
| `npm run anki:runtime` | Freeze the official Anki backend into `tmp/anki-runtime/anki-helper/` with PyInstaller. |
| `npm run desktop:dev` | Launch the Electron development window against this checkout. |
| `npm run desktop:build-dev` | Build `tmp/Caro Anki Dev.app` referencing this checkout. |
| `npm run desktop:install-dev` | Build and install `/Applications/Caro Anki Dev.app`. |
| `npm run desktop:test` | Run the isolated Electron smoke test and write `tmp/desktop-smoke.png`. |
| `npm run desktop:clean` | Remove the build output, development log, smoke screenshot, and partial Electron downloads from `tmp/`. |

The `scripts/` directory groups executable helpers by language: shell scripts live in `scripts/sh/`, and
Node.js scripts live in `scripts/js/`.

| File | Purpose |
| --- | --- |
| `scripts/sh/bootstrap-macos-dev.sh` | Prepares a fresh macOS checkout: installs supported Node.js and Python versions when needed, creates `.env`, installs the app, then runs `npm run validate`. |
| `scripts/sh/build-anki-runtime.sh` | Builds and smoke-tests the versioned PyInstaller `--onedir` Anki runtime. The entire `tmp/anki-runtime/anki-helper/` directory is the distributable unit. |
| `scripts/sh/install-caro-anki-dev.sh` | Builds the runtime and Electron app, verifies required bundle files, then installs and registers `/Applications/Caro Anki Dev.app`. |
| `scripts/js/check-syntax.js` | Recursively runs `node --check` over JavaScript sources; use `npm run validate` when tests are also required. |
| `scripts/js/install-desktop-dev.js` | Copies Electron into a development `.app`, adds the local entry point and complete Anki runtime directory, then ad-hoc codesigns the bundle. |

The runtime cache is invalidated when the bridge, build script, Anki version, or PyInstaller version changes.
Use `ANKI_RUNTIME_FORCE=1 npm run anki:runtime` to rebuild it explicitly. A new runtime is built and verified
in a staging directory, so a failed build does not remove the last working runtime.

The desktop app workflow is described in full under [macOS development app](#macos-development-app).

## Automated tests

`npm test` runs every `backend/test/*.test.js`. A test that needs the real backend starts it through
`backend/test/server-process.js`, never with `npm start`:

- `startServer(env)` spawns `backend/server.js` on a free port with its own SQLite database in a temporary
  directory, a temporary collection path, an empty `DEEPSEEK_API_KEY`, and `backend/test/fixtures/anki-bridge.js`
  as the Anki bridge. It resolves with `{ port, stop }` once the server says it is listening, so a test sends
  its own requests to `http://127.0.0.1:${port}` (`backend/test/anki-sync.test.js` wraps it with `post`/`get`
  helpers of its own) and `stop()` kills that process and removes its temporary directory. Pass `env` to
  override any of those defaults — including `PORT`, which is how a failing start is exercised.
- The helper drains both of the server's pipes, so a server that dies while starting rejects the promise with
  what it wrote to stdout and stderr instead of leaving the test to wait.
- A fixture under `backend/test/fixtures/` must exit when its stdin ends, which is what happens when the
  server holding it is stopped: a fixture that keeps running keeps `node --test` running with it.
- A test must `stop()` the server and `close()` every client it opened before it finishes.

`npm start` and `npm run dev` are servers: they never return, so running one as a foreground blocking command
looks like a hang for as long as it runs. Use the desktop app or an asynchronous terminal for them.

## Card save API

The legacy `anki-preview`, `anki-add`, and `anki-exports` route names remain compatible with existing clients,
but they now preview and save cards directly into the Anki collection. Manage the note type and
duplicate-card behavior from the settings button in the topbar; changes apply immediately.

1. Save a valid card version and obtain its numeric `id`.
2. Send `POST /api/sessions/:id/anki-preview` with `{ "cardVersionId": 1 }`.
   This revalidates the saved cards and persists an exact note/target snapshot without contacting Anki.
3. Review the returned `export.notes`, then explicitly confirm with
   `POST /api/sessions/:id/anki-add` and `{ "exportId": 1, "confirmed": true }`.
   Use the export ID returned by the preview. Both POST routes require `Content-Type: application/json`.
4. Inspect `export.status`, `noteIds`, and `error`, or retrieve history using
   `GET /api/sessions/:id/anki-exports`. A successful HTTP response does not imply every note was added.

Changing the current card version invalidates an unsubmitted preview. Repeating a completed export returns
its saved result. Only one submission attempt is permitted per card version, including across previews.
Partial failures retain successful note IDs; unexpected storage failures mark the outcome as unknown. A crash may leave
an export pending. Check the collection and history before creating a corrected version for another attempt;
failed or pending exports are never automatically retried.

## In-app Anki browser

The main screen browses and edits existing Anki notes through the backend, without opening Anki.
It edits raw Anki note fields so unrelated fields are preserved. The topbar anki agent button toggles the chat panel.

- `GET /api/anki/decks` — deck and model names.
- `GET /api/anki/notes?query=<anki-search>&select=<columns>&skip=<n>&limit=<n>&includeIds=true` — returns exactly
  the requested note columns and, when requested, the complete ordered note-ID index. Requesting only table columns
  (`term`, `meaning`, `modelName`, `tags`, `createdAt`, `deckName`, `dueAt`, and `flag`) uses lightweight rows;
  requesting `fields`, `sortField`, or `preview` returns detailed notes. The browser keeps that complete index for
  navigation and selection, then loads table pages as they enter the virtualized viewport.
- `GET /api/anki/notes/:id?select=<columns>` — loads exactly the selected fields (always including `id`); omitting
  `select` returns the full note.
- `GET /api/anki/notes/new?select=<columns>` — returns a selected subset of an unsaved, empty note template. The browser only
  creates it with `POST /api/anki/notes` when the editor closes and at least one field contains text.
- `POST /api/anki/notes` with fields, tags, and a deck — creates a completed browser-editor draft.
- `GET /api/anki/notes?query=<anki-search>&skip=<n>&limit=<n>` — retains the enriched paginated response for API
  consumers. An empty `query` searches the whole collection; `limit` defaults to 30 (max 500).
- `PUT /api/anki/notes/:id` with `{ "fields": { "<Anki field>": "<value>" } }` — updates fields.
- `PUT /api/anki/notes/:id/due` with `{ "days": "1" | "1-3" }` — reschedules the note's cards using the same
  day-count/range rules as the batch action; the UI reloads the list afterwards to show the new due time.
- `POST /api/anki/notes/:id/copy` — creates a duplicate in the source note's deck, retaining its fields and tags.
- `POST /api/anki/notes/batch` — changes deck, due date, or flag, or copies selected notes with
  `changeDeck`, `setDueDate`, `setFlag`, or `copy`.
- `DELETE /api/anki/notes/:id` — deletes a note.

Write routes require `Content-Type: application/json` and reject cross-origin requests. Deleting a note
uses the same two-click confirm as the other destructive controls.

Selected-note deck, due-date, flag, copy, and delete actions validate every target before mutating the local
collection. API responses include a `Server-Timing` header; the browser console splits note-list latency into
backend, HTTP/client, DOM render, search, note hydrate, card hydrate, and sort.

## Workspace boundaries

| Directory | Responsibility |
| --- | --- |
| `backend/` | Node.js server, HTTP API, domain logic, providers, the Anki runtime bridge, and backend tests |
| `frontend/` | HTML, CSS, and jQuery UI modules |
| `sqlite/` | SQL migrations, database access, and repositories |
| `scripts/sh/` | macOS bootstrap, Anki runtime build, and desktop installation shell scripts |
| `scripts/js/` | JavaScript syntax validation and Electron app assembly scripts |
| `desktop/` | The Electron development app and the backend lifecycle it owns |

Notes, decks, note types, scheduling, and media belong to each Anki collection file. SQLite holds the
profile-scoped conversations, saved card versions, exports, card defaults, and AnkiWeb account details,
plus app-wide agent configuration and authoring libraries. The browser never receives provider keys,
credentials, or filesystem paths. The server binds to `127.0.0.1` by default.

## macOS development app

`Caro Anki Dev.app` opens this checkout in an Electron window and starts the backend with the
Node.js executable used at build time. It requires this checkout, its `node_modules`, and Node.js 26+.
It is a development entry point, not a portable release or a DMG installer.

```sh
npm install
npx install-electron
npm run desktop:dev
npm run desktop:build-dev
```

`npm run desktop:build-dev` writes `tmp/Caro Anki Dev.app`; copy it into `/Applications`, then open
**Caro Anki Dev** from Spotlight. Both that command and `npm run desktop:install-dev` replace a previous build
output without prompting. The bundle identifier defaults to `com.caro.anki.dev`; set `CF_BUNDLE_ID` to
override it for an isolated development build.

To build and install in one step, run `sh scripts/sh/install-caro-anki-dev.sh` or `npm run desktop:install-dev`.
The script builds the Anki runtime, installs dependencies, prepares Electron, verifies that the bundle
contains the Electron binary, the app entry point, and the Anki runtime, replaces
`/Applications/Caro Anki Dev.app`, registers it with Spotlight, and deletes the temporary build bundle.
Close an existing app before replacing it. With the app closed, `npm run desktop:clean` clears any build
output, development log, or partial Electron download left in `tmp/`.

The installed bundle loads `desktop/main.js` directly from this checkout, so source changes only need an
app restart. Rebuild the entry point when the checkout or Node.js moves, or when Electron changes.
The development launcher passes `CARO_APP_VARIANT=dev` to the backend, which renders the page title as
`Caro Anki Dev`; standalone and future production launches default to `Caro Anki`.

The app uses the existing `.env`, application database, and collection settings, and owns the backend lifecycle: it
starts `backend/server.js` on launch and stops it on quit. Closing the window quits the development app.
Other manually started servers on the configured port must be stopped first.

Earlier versions started the backend from a per-user `launchd` agent instead. That login service is no
longer included, and the app does not stop or restore it. Remove a leftover agent once before using the
app; otherwise it keeps `backend/server.js` running, the app cannot claim the port, and it exits with an
error dialog:

```sh
launchctl bootout "gui/$(id -u)/com.caro.anki-ai"
rm -f "$HOME/Library/LaunchAgents/com.caro.anki-ai.plist"
```

- Changes under `frontend/` reload the window after a short debounce.
- Changes under `backend/`, or JavaScript/SQL under `sqlite/`, restart the backend and reload the window.
- Changes to `.env` or `desktop/` require quitting and reopening the app.
- Reloading can discard unsaved inputs; restarting can interrupt an AI/Anki operation. Save code when idle.
  Interrupted operations are not replayed automatically.
- Backend logs: `tmp/desktop-dev.log`. Use the View menu to open developer tools.

For isolated development checks, set a separate `PORT` and `SQLITE_PATH` before launching.

Run `npm run desktop:test` for an isolated Electron smoke test of frontend reload and backend restart.
It uses a temporary standalone database and never calls a real AI provider or edits the normal application
data. The screenshot is saved to `tmp/desktop-smoke.png`.
