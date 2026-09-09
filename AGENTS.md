# Caro Anki development guide

## Architecture

| Area | Responsibility |
| --- | --- |
| `backend/` | HTTP routes, domain logic, AI providers, Anki bridge, and backend tests |
| `frontend/` | Static HTML, CSS, and jQuery controllers |
| `sqlite/` | Migrations, repositories, and app data |
| `desktop/` | Electron development app and backend lifecycle |
| `scripts/` | Bootstrap, runtime build, desktop assembly, and checks |

The app is local-first: bind to `127.0.0.1` by default. The browser must never receive API keys,
AnkiWeb credentials, or filesystem paths.

Notes, decks, note types, scheduling, and media belong to Anki's `collection.anki2`. SQLite stores
app data such as conversations, settings, card versions, exports, and profile metadata. Route all
collection access through `backend/anki-local.js` and `backend/anki_bridge.py`; do not introduce a
second collection model.

## Runtime and safety

- Use CommonJS and support Node.js 26 or later.
- Keep provider calls and collection writes behind explicit backend routes.
- Store Agent and AnkiWeb secrets in the macOS Keychain. Never use `.env` credentials as an Agent
  fallback or expose a stored secret in an API response.
- Tests use mock providers, an isolated SQLite database and the fixture Anki bridge. They must not
  call a real provider, AnkiWeb, or the user's collection.
- Bound every external wait. A failed or interrupted write is never retried automatically; report the
  observed result and inspect persisted operation history before another write.

## File organization

- **Important rule:** Keep files at 900 lines or fewer. Before a change would exceed that limit, split the
  file into focused, cohesive modules. Prioritize splitting existing oversized files when modifying their area.
- Keep API route groups in `backend/routes/` as dependency-injected factories. `backend/server.js` composes
  services, owns the top-level error boundary, serves static files, and shuts down.

## Anki and Agent changes

- Preserve the collection's own note-type field names and values. Do not add fixed `Term`, `Meaning`,
  `front`, or `back` assumptions to routes or UI code.
- Resolve and validate every target before a batch mutation. The Agent reads a note before updating or
  deleting it, and writes only for an explicit create, update, or delete request.
- Keep the Agent's tool names in `TOOL_NAMES`; retained aliases in `LEGACY_TOOL_NAMES` protect stored
  conversation history.
- Keep durable request and operation records. A disconnected stream stops delivery, not the operation.
- Agent memory is compact, agent-maintained Markdown in `CARO_MEMORIES_DIR`. It may retain durable preferences,
  local details, and lessons, but never raw note content, secrets, untrusted note instructions, or write authority.
  Each entry uses its Agent configuration's default language, unless the user explicitly asks for another one.
- Each Agent configuration stores a supported default language. Include it in the system prompt for chat replies and
  Agent-authored instructions, skills, and memories; a direct user language request takes precedence.
- The browser owns selection through `anki/note-selection.js`; `anki-browser.js` is the sole writer of
  selected IDs and selection focus.

## User-authored libraries

- Standing instructions are flat Markdown files in `CARO_INSTRUCTIONS_DIR`
  (`~/.caro-anki/instructions` by default). They are preferences, not extra permissions, and are read
  only by `InstructionLibrary`.
- Agent memories are flat Markdown files in `CARO_MEMORIES_DIR` (`~/.caro-anki/memories` by default), managed
  through `AgentMemory` and editable in Agent Settings.
- Skills live in `CARO_SKILLS_DIR` (`~/.caro-anki/skills` by default). `SkillLibrary` is the only
  parser and writer. Bundled seeds copy once and must never overwrite a user's copy.
- A proposal validates but does not write. `apply_instructions`, `apply_skills`, and
  `apply_card_profile` are the only corresponding write operations.
- Card profiles are per-note-type files in `CARO_card-profiles_DIR`; use the profile library rather
  than duplicating card contracts in a controller or route.

## Frontend conventions

- `frontend/scripts/app.js` wires dependencies and starts the page. Put feature behavior in a focused
  controller; keep pure, testable state and formatting logic separate.
- Browser modules use the project's UMD pattern and explicit dependency injection. Do not reach into
  `window` for dependencies that `app.js` can provide.
- Build controls from `CaroUI` in `frontend/scripts/core/ui-kit.js`. Use its status helpers, escaping,
  count formatting, entity picker, dialogs, and two-step destructive confirmation rather than local
  variants.
- Prefer icon-only buttons for familiar Caro Anki actions. Keep a visible text label only when the action needs
  specific explanation, such as a named navigation destination, an irreversible sync choice, or a consequential
  form submission. Use `CaroUI.icons.iconButton` for generated icon buttons where possible. Every icon-only button
  needs an action-specific `aria-label` and `title`; its decorative SVG must be `aria-hidden="true"` and
  `focusable="false"`. Preserve `aria-pressed`, `aria-expanded`, or other relevant state on toggles.
- Keep dialog markup as `.dialog > .dialog-body > (.dialog-head + .dialog-content)`. The header and
  Settings tabs stay fixed; content scrolls in the dedicated content or panel area.
- Use `setSystemMessage` and shared semantic status styles for feedback. Format displayed counts with
  `CaroUI.text.formatCount`.

## Verification

- Run `npm run check` after JavaScript changes. Run `npm test` for backend, SQLite, or behavior changes;
  it starts loopback servers through `backend/test/server-process.js`.
- For UI changes, verify the affected empty, loading, error, and narrow-window states. Use focused
  Electron coverage when it best represents the changed interaction, and state its scope accurately.
- `desktop/` owns the Electron development lifecycle. Keep Node integration disabled, context isolation
  and sandboxing enabled, and never bundle secrets.
