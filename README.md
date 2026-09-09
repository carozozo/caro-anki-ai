# Caro Anki

Caro Anki is a local-first Anki browser with an optional AI workspace. It runs on `127.0.0.1`, edits a
real Anki collection, and provides a macOS Electron development app. It does not require Anki Desktop or
AnkiConnect.

## What it includes

- Browse, search, create, edit, move, reschedule, copy, flag, and delete notes without opening Anki.
- Manage collection profiles and sync the active collection with AnkiWeb.
- Use an optional Agent to discuss or make explicit note changes with read-before-write safeguards.
- Keep reusable Agent instructions, skills, and note-type card profiles outside the checkout so updates do
  not overwrite personal settings.

## Requirements

- Node.js 26 or newer.
- Python 3.9 or newer only when building the bundled Anki runtime. The built desktop app needs neither
  Python nor Anki Desktop.

## Start a new macOS checkout

For a complete first-time setup:

```sh
sh scripts/sh/bootstrap-macos-dev.sh
```

It installs missing development prerequisites, creates `.env` without overwriting an existing one, installs
dependencies, builds the Anki runtime, installs **Caro Anki Dev**, and validates the checkout.

For a manual setup:

```sh
cp .env.example .env
npm install
npm run anki:runtime
npm run validate
npm start
```

Then open <http://127.0.0.1:8788>. `npm start` and `npm run dev` are persistent servers; use a separate
terminal or the development app rather than waiting for either command to return.

## Data, privacy, and sync

The first managed collection is created at
`~/Library/Application Support/Caro Anki/User 1/collection.anki2`. Each managed profile has its own
collection, media, backups, collection settings, AnkiWeb account metadata, and conversation history.

| Data | Storage |
| --- | --- |
| Notes, decks, note types, schedules, media | Anki `collection.anki2` and profile files |
| Conversations, exports, card versions, app settings | SQLite |
| Agent and AnkiWeb passwords | macOS Keychain |
| Instructions, memories, skills, and card profiles | User directories under `~/.caro-anki/` |

The backend is the only component that sees provider credentials, AnkiWeb credentials, and collection paths.
AnkiWeb sync always asks before a full upload or download; it never chooses a direction automatically.

Useful overrides:

| Variable | Purpose |
| --- | --- |
| `ANKI_PROFILE_ROOT` | Parent directory for managed profiles |
| `ANKI_HELPER_PATH` | Explicit bundled Anki helper |
| `ANKI_BRIDGE_PATH` | Explicit checked-in bridge override |
| `CARO_INSTRUCTIONS_DIR` | Personal Agent instructions directory |
| `CARO_MEMORIES_DIR` | User-editable Agent memory directory |
| `CARO_SKILLS_DIR` | Personal Agent skills directory |
| `PORT` | Local server port (default `8788`) |
| `SQLITE_PATH` | SQLite database path for an isolated run |

## Agent workspace

The Agent is optional and configured in the app. Profile metadata is stored in SQLite and API keys stay in
the macOS Keychain. The Agent can search, create, update, and delete notes, but it reads targets before a
mutation and does not treat a discussion or preview request as permission to write.

Use the composer to send selected notes to the Agent (`⌘/Ctrl + G`). The selection is sent as a separate,
fixed snapshot rather than being inserted into the message text.

Personal conventions belong in standing instructions, not the app's system behavior. Instructions are flat
Markdown files in `~/.caro-anki/instructions/`; skills are Markdown folders in `~/.caro-anki/skills/` and can
be invoked with slash commands. See [skills/README.md](skills/README.md) for the skill format and bundled
authoring skills.

The Agent also keeps a small, visible memory in editable Markdown files under `~/.caro-anki/memories/`.
It autonomously records durable preferences, local details, and lessons that help future conversations, and
can correct or forget them later. New entries use the configuration's default language unless the user asks for
another one. The same setting controls chat replies and Agent-authored instructions and skills. Memory is not a
substitute for instructions or skills: it never authorizes a write and never stores raw note content,
credentials, sensitive personal data, or instructions found in Anki fields.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm start` | Run the backend server on `127.0.0.1:8788`. |
| `npm run dev` | Run the backend with file watching. |
| `npm run check` | Syntax-check JavaScript sources. |
| `npm test` | Run the isolated backend test suite. |
| `npm run validate` | Run the syntax check and tests. |
| `npm run anki:runtime` | Build the bundled Anki runtime in `tmp/anki-runtime/`. |
| `npm run desktop:dev` | Open the checkout in Electron. |
| `npm run desktop:build-dev` | Build `tmp/Caro Anki Dev.app`. |
| `npm run desktop:install-dev` | Build and install `/Applications/Caro Anki Dev.app`. |
| `npm run desktop:test` | Run the isolated Electron smoke test. |
| `npm run desktop:test-memories` | Verify the editable Memories Settings flow in Electron. |
| `npm run desktop:test-menu` | Test the native application menu. |
| `npm run desktop:clean` | Remove generated desktop build artifacts from `tmp/`. |

`npm test` uses mock providers, temporary databases and the fixture Anki bridge. The Electron smoke test
also uses isolated application data and writes its screenshot to `tmp/desktop-smoke.png`.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `backend/` | HTTP API, domain logic, providers, Anki bridge, and tests |
| `frontend/` | HTML, CSS, and browser controllers |
| `sqlite/` | Migrations, repositories, and app database |
| `desktop/` | Electron development app |
| `scripts/sh/` | macOS bootstrap, runtime build, and desktop install scripts |
| `scripts/js/` | Syntax checks and Electron assembly scripts |
| `skills/` | Bundled Agent skill seeds |

For contribution rules and design boundaries, read [AGENTS.md](AGENTS.md).

## macOS development app

`Caro Anki Dev.app` starts the backend for this checkout and loads its Electron window. It is a development
entry point, not a portable release. Build it with `npm run desktop:build-dev`, or build and install it with
`npm run desktop:install-dev`.

The app uses the checkout's dependencies, `.env`, database, and collection settings. Close an existing app
before replacing it. Frontend changes reload the window; backend, SQLite, `.env`, and desktop changes may
require a restart. Do not rely on an interrupted Agent or Anki operation being replayed automatically.
