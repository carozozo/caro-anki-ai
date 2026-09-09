# caro-anki-ai Development Rules

## Architecture

This is a localhost-only standalone flashcard browser with an integrated Anki-compatible agent panel.

- `backend/` owns the HTTP server, API routes, domain contracts, AI providers, the Anki runtime bridge, and
  backend tests.
- `frontend/` owns static HTML, CSS, and jQuery UI modules.
- `sqlite/` owns SQL migrations, database access, repositories, and runtime database files.
- `scripts/sh/` owns shell-based setup, runtime build, and installation; `scripts/js/` owns Node.js build and
  verification helpers.
- Root files own package scripts, environment examples, and project documentation.

Keep these boundaries intact. The frontend must never receive API keys or AnkiConnect credentials.

## Runtime

- Use CommonJS modules in Node.js.
- Target Node.js 26 or newer and use `node:sqlite` unless the project explicitly changes its runtime baseline.
- Bind the server to `127.0.0.1` by default.
- Keep AI calls and collection writes behind explicit backend routes.
- Do not call a real AI provider, contact AnkiWeb, or modify the normal application database or collection in
  automated tests. Anki tests talk to `backend/test/fixtures/anki-bridge.js` and isolate the Keychain service.

## Codex execution

- `npm run check` is sandbox-safe. `npm test` (and therefore `npm run validate`) starts real loopback HTTP servers
  through `backend/test/server-process.js`; if the sandbox cannot bind `127.0.0.1`, run the full suite from its
  first invocation with the narrowest approved local-port or sandbox escalation.
- Do not first run the full suite in a restricted sandbox or report an expected loopback-bind denial as a regression.
  Keep `127.0.0.1` and the existing port strategy; changing either does not cross the permission boundary.
- Local visual verification with `npm start` or `npm run dev` also needs the narrowest approved local-port permission.
  Run it asynchronously as required below; if permission is unavailable, report that verification as not run.

## AI workspace

- Browser and collapsible Chat share one screen. Chat initially shows sessions; first send creates a conversation.
- Only Send-to-AI (`#ankiSelectedAi`, `⌘ + G`) publishes browser selection: it emits `anki-selection-change` and
  arms a chip with normalized, capped-50 `selectionNoteIds` for `AnkiAgent.respond` read-before-write context.
  Never put IDs in the textarea or send other data; later clicks cannot retarget the snapshot, and
  `anki-clear-selection` clears both browser selection and chip.
- Keep the composer outside the scrollable session/conversation panels.
- `anki-agent.js` owns the bounded native function-calling loop; `agent-chat.js` owns durable request IDs and
  conversations. Use DeepSeek tool mode for agent turns; never reintroduce a hand-written JSON action envelope.
- AI creates default to the collection's current deck unless explicitly targeted elsewhere. Read notes before
  edits or deletion.
- Persist tool attempts/results, never automatically replay interrupted writes, and refresh browser results after
  operations.
- `AgentChat.send` refusals are 409s with `not_started` (reserve busy before the first `await`, release in
  `finally`), `run_pending` (a write may have landed), or `request_reused`. Preserve codes through stream errors
  and `sendError`; retain an armed request only for `run_pending`, and bind resends to its stored session.
- `stream: true` uses lazy-header NDJSON events: `effort`, `phase`, `answer`, `tool`, `result`, and `error`.
  Pre-first-event failures remain normal JSON with their true status, and disconnecting stops delivery, not a run.
  `collapseToolSteps` and the live strip render identical pending/terminal rows and `created_at` durations;
  `answer` is `{ delta, reset }`, resets before retry, clears on each phase, and never persists a tool preamble.
- The provider's SSE reader rebuilds the non-streaming completion shape. Concatenate fragmented
  `delta.function.name` like `delta.function.arguments`; never assign it.
- Keep legacy snapshot/export APIs compatible; Chat uses `/api/sessions/:id/chat`.
- `frontend/scripts/chat/markdown.js` (`CaroMarkdown`) is the sole live/history renderer for assistant answers: escape first,
  allow only `http`/`https`/`mailto`/`#` links, and never use `escapeHtml` alone or a second markdown path. User
  messages stay plain; re-render the whole buffered stream on the markdown frame budget so live/final markup matches.
- Anki Agent is optional at runtime. Store multi-profile metadata in SQLite and API keys in macOS Keychain;
  never return keys to the frontend and never use `.env` credentials as an Agent fallback.
- Reasoning effort is per request. `auto` classifies once with the profile model (thinking off) as `none|low|high`,
  falls back to profile effort, emits `effort`, and never fails the turn. Do not expose `max`; resolve `auto` with
  `apiEffort()` before provider calls.
- Never send `max_tokens`: it jointly limits thinking and answer, can produce empty `length` replies, and is absent
  from all DeepSeek requests; use the provider's per-mode defaults.
- Store user-managed note type, duplicate, and deck-list defaults in the singleton `anki_settings` SQLite row and
  apply changes without restarting the backend.
- Which decks the browser lists is the user's choice, never a name filter in the code: `visibleDecks` on that row is
  a whitelist (`backend/anki-settings.js` validates it, `Repository` stores it as JSON) whose empty value means every
  deck, and only the quick-search DECKS group reads it. The note editor and the batch deck pickers stay unfiltered —
  hiding a deck must never change which deck a note appears to be in, or where a note can be moved. Never reintroduce
  a hardcoded exclude (a `-` prefix, a `Default` name) — the card-defaults panel has the `All decks` / `Selected
  decks only` choice for it.
- Notes, decks, note types, scheduling, and media live in an Anki `collection.anki2` owned by the bundled Anki
  runtime, never in SQLite. SQLite holds only conversations, card versions, exports, app settings, and the AnkiWeb
  account. `backend/anki-local.js` is the only bridge to that collection; `backend/anki_bridge.py` runs inside the
  bundled runtime and owns every Anki API call. Do not reintroduce the deleted `local-collection.js` or its
  `collection_*` tables (dropped by `012_remove_simplified_collection.sql`) — they cannot take part in AnkiWeb sync.
- `npm run anki:runtime` freezes `anki_bridge.py` and official Anki into `tmp/anki-runtime/`; desktop builds bundle it,
  while development prefers the checkout helper and rebuilds it after bridge changes. Explicit `ANKI_HELPER_PATH` or
  `ANKI_BRIDGE_PATH` always wins; a missing runtime returns 503 with path.
- AnkiWeb credentials are configured in the app only. The password lives in the macOS Keychain (`com.caro.anki.sync`)
  and the ID, sync server, and media preference in SQLite; the password never reaches the frontend and `.env` is
  never an account fallback. Never choose a full-sync direction for the user: AnkiWeb reports which directions are
  possible and the UI asks before replacing either collection.
- Derive a sync's outcome from the collection stamps, never from the code AnkiWeb answers with: a merge that really
  moved data reports `NO_CHANGES` exactly like a no-op. `AnkiAccount.sync` therefore returns `merged`
  (`syncPerformed`) alongside the raw response and keeps the stamps server-side; the UI reports the merge, reloads
  the browser on `merged || fullSync`, and reserves `required` for the cases that need a user decision.
- A successful normal sync shows no outcome text. `runAnkiSync` opens non-dismissible `#ankiSyncProgressDialog` only
  for `needsSync` or accepted bridge progress, retains it until the result, and applies configured linger/fade.
  Report a merge only there via `syncOutcomeText`; the status pill keeps connection/pending state while the button
  spins. Poll at bridge 0.2s cadence. Only `full_sync` has a determinate byte bar; indeterminate progress uses a sweep.
- Resolve and validate every selected-note target before a batch mutation.
- List searches return lightweight summaries; load full note fields only when the editor or an operation needs them.
- Every Anki collection read takes a `select` naming the fields it answers with, validated in `backend/anki-browser.js`
  against that endpoint's own column set: an unknown name is a 400 listing what it allows, omitting it returns the
  full shape, and the identifying field (`id`, `noteId`, `name`) is always returned because it is what the caller
  asks for the item with and what the agent's read-before-write ledger is keyed on. The frontend adapts without it.
- Keep the ordered note-ID index complete for selection and keyboard navigation. Load lightweight summary rows in
  pages as they enter the viewport, and virtualize the DOM to visible rows.
- Render UI status text through `setSystemMessage` and the shared `system-message` semantic colors; keep each status
  element rendered when empty so it reserves one line, and do not add component-specific status colors. A `pending`
  sentence is held back by `config.timings.pendingDelayMs` and shown only if the work outlasts it, so a fast write
  reports its result alone instead of flickering "Saving…" — never announce a wait from the caller instead. A line
  that describes something lasting states it as its baseline instead: the browser's status says only how many notes
  the query matched, written for keeps with `{ keep: true }`, and every transient sentence hands the line back to it
  through `onClear` — never let a lasting fact be a message that expires, and never park diagnostics (work-in-flight
  counts, the query echo, timings) in that line; they belong in the console.
- Every displayed count is grouped through `CaroUI.text.formatCount` (`30000` -> `30,000`), in the app's own locale:
  the note-list total, the selection readout, the batch and delete sentences, the chat's selected-note chip and the
  preview position. Never format a number with a second path or print a raw one.
- Keep application identity explicit: desktop development launches pass `CARO_APP_VARIANT=dev`; the backend maps
  supported variants to trusted titles and renders `frontend/index.html` without exposing arbitrary HTML input.

## Skills

Skills are Markdown instructions the user (or the agent) can load on demand. `backend/skill-library.js` owns the
whole format — frontmatter (`name`, `description`, `argument-hint`, `user-invocable`, `disable-model-invocation`),
`references/` files, name resolution and the error list — and is the only module that parses or writes it.

- The library lives outside the checkout (`config.skillsDir`, `CARO_SKILLS_DIR`, default `~/.caro-anki/skills`) so an
  edit survives a rebuild, and the seeds in `skills/` are copied there exactly once, guarded by a `.caro-seeded`
  marker: never re-seed over a user's copy.
- The agent reaches skills through the `load_skill` tool in `backend/anki-agent.js`; the frontend never reads files or
  re-implements frontmatter — it lists and edits through the dedicated library routes in `server.js`.
- Settings includes an Instructions / Skills tab. It edits instruction bodies and skill bodies only; the backend
  preserves skill frontmatter and both libraries keep version backups for every save.
- Tool names are `search_notes`, `read_note`, `create_notes`, `update_note`, `delete_note`, `list_decks`,
  `read_card_profile`, `propose_card_profile`, `apply_card_profile`, `load_skill`, `propose_instructions`,
  `apply_instructions`, `propose_skills`, and
  `apply_skills`. They come from the `TOOL_NAMES` constant and every schema, prompt line, dispatch branch, action
  list, and step label reads them from there — never reintroduce a bare
  name literal. A name is verb-first and carries its object, so a new capability gets a new name instead of
  overloading `search`. Every rename keeps a pair in `LEGACY_TOOL_NAMES` (backend, for read-before-write credit in
  stored history) and `LEGACY_NAMES` (`frontend/scripts/chat/chat-stream.js`, for step labels), because a persisted conversation
  is never migrated.
- A proposal never writes: `propose_instructions`, `propose_skills` and `propose_card_profile` are deliberately
  absent from
  `ACTIONS`/`WRITE_ACTIONS`, so a turn that only proposes can never be recorded as an unknown write. They validate
  with the loader's own rules and announce the result as `{ proposed, written: false }` — a refusal is answered with
  the library's sentence and an instruction to correct it, never thrown — and a reply must never describe a proposal
  as written. Its paired `apply_instructions` / `apply_skills` / `apply_card_profile` is what writes, and all three
  are in `WRITE_ACTIONS`
  because a failure there may have landed files. An apply is announced only from what the tool answered, it refuses
  rather than throws (an empty call answers too), and a refusal part-way through reports what already landed with the
  sentence that says those changes are written and must not be applied again.
- A card profile is a FILE per note type (`config.cardProfilesDir`, default `~/.caro-anki/card-profiles`), written by
  `CardProfileLibrary` (`backend/card-profile-library.js`), whose `check`/`checkEdit` are the read halves of
  `save`/`edit` — so a proposal runs `checkProfile` for its sentences plus a real `compileProfile` as proof, and an
  apply cannot refuse what a proposal showed. An edit names one field and the keys to set, unset or store instead of
  restating the file, because most of a profile is reference data a model would as likely corrupt as improve; a
  rename is how a renamed note type keeps its profile, so it moves the file and rewrites the `noteType` key together.
  Every replaced, renamed or retired file is kept under `versions/`, and the chat route re-scans the directory per
  turn so a profile that stops compiling is reported.
- A skill is a FOLDER, so `SkillLibrary.check`/`save` take a name plus the whole file list (`SKILL.md` first, then
  `references/<name>.md`) and one save writes them together: a folder that arrives one file at a time is briefly a
  body naming a reference it does not have. A file the list omits is left untouched, and a replaced file is backed
  up under `versions/` beside itself (`VERSION_KEEP = 10`), the same two-level shape the instruction library uses.
  `checkRename`/`rename` and `checkRemove`/`remove` are the other two things a folder can be asked to do, and both
  mirror the instruction library's `op`: a rename versions the whole folder, moves it, and rewrites the one
  frontmatter line that ties a body to its folder (never a rewrite, and refused when the target exists, so merging
  two skills is a write plus a removal), while a removal versions the whole folder before deleting it. `save`,
  `rename`, and `remove` are the only writers; `propose_skills`/`apply_skills` carry all three in one call as
  `files`, `renames: [{ name, to }]`, `removals: [name]`, exactly like `INSTRUCTION_CHANGE_SCHEMA`.
  Settings uses the dedicated `GET`/`POST`/`PUT`/`DELETE` library routes: it sends instruction content or a skill
  body, the server preserves an existing skill's frontmatter, and creates new frontmatter from its name and
  description. The agent's apply tools are another writer over the same libraries.
- The bar under a reply is a read-only proposal preview: `frontend/scripts/chat/chat-stream.js` `proposedPreviews()` emits
  `{ kind, op, name, ... , files }` entries keyed `proposalKey(kind, op, name)` (a corrected restatement wins).
  Card-profile entries retain their capped inline `.operation-save-preview`. An instruction or skill **write**
  renders a Preview button plus an inert `<template>`; `app.js` clones that escaped template into
  `#agentProposalPreviewDialog` through the shared dialog factory, so long files are read in a modal without
  enlarging the conversation or placing multiline text in a `data-*` attribute. Rename and removal entries have
  no body and remain concise text. Preview only reads: the user still answers the agent in words, the agent calls
  apply itself, and neither the frontend nor a route holds a later-write payload. A reply never repeats a proposed
  body: `INLINE_PROPOSAL_IS_THE_DRAFT` serves card profiles and `FILE_PREVIEW_IS_THE_DRAFT` tells instruction/skill
  agents to ask the user to click Preview. The bundled authoring seeds carry the same rule.
- `frontend/scripts/chat/skill-menu.js` owns the composer's slash-command logic and stays pure (UMD, unit-tested like
  `note-list-state.js`): a command only counts at the start of the message, whitespace ends it, and accepting a
  suggestion rewrites the command plus its separator. `app.js` only wires it to `#composerSkills`; never put the
  matching or rewriting rules in the event handlers.
- The composer format is the message's own leading command: once `/name` resolves against the installed library,
  the pinned skill rides inside the message box as the note editor's own tag chip — one `chipButton()` builder
  shared with the tag chips, inside `#composerSkillControl`, with that skill's `argument-hint` as the textarea's
  placeholder — while the textarea keeps the command plus the argument. The message travels unchanged as `content`,
  so the backend reads the skill straight off the request — `SkillLibrary.pinned()` (via `commandName`) is that
  single parse point, and
  `AnkiAgent.respond` preloads the pinned body instead of waiting for the model to load it. Keep `skill-menu.js`
  `skillCommand` / `pinnedSkill` / `clearSkill` in step with it: an unmatched command stays ordinary prose, and
  `AnkiAgent` must never be handed a second, structured skill field.
- The menu offers only skills with `user-invocable !== false` — a model-only skill stays reachable by the agent. Its
  step labels live in `frontend/scripts/chat/chat-stream.js` with every other tool.
- The seeds that author for this app are self-hosting: `instruction` writes a file
  under `~/.caro-anki/instructions/` with `apply_instructions` (and renames or retires one in the same call), and
  `skill` writes, renames, or retires a whole skill folder with `apply_skills`. They interview the user, show the
  draft, and then check it with the matching `propose_*` call — which writes nothing — so the deliverable is what
  the apply answered, never a printed file for the user to paste and never a claim that one was written. A request
  that already names the change is a go-ahead of its own. A seed's own reference files are named in its body, and a
  newly bundled seed must be copied into the live library by hand (seeding is bootstrap-once).

## Standing instructions

The user's own conventions are not in the code. `backend/anki-agent.js` `PROMPT` is the factory setting: the tool
contract and the safety rules, and no reply language, card style, or convention about what a bare word means.
Everything personal lives in `~/.caro-anki/instructions/`, injected on every turn.

- `backend/instruction-library.js` is the only module that reads that directory and the only place its format is
  defined: flat, `.md` only, dotfiles and directories skipped, filename ascending, no frontmatter, 16000 characters
  each then `\n\n…(truncated)`, empty files skipped, re-read on every `refresh()`. Keep it that way — the frontend
  never reads these files and no route lists them.
- `AnkiAgent.respond` refreshes the library and appends its `prompt()` as a system message after the factory prompt
  and before the skill catalogue. It is a preference layer, not a permission layer: the wrapper must keep saying the
  files cannot add a tool, relax the tool contract, or excuse writing to a note that was not read first.
- A file that cannot be read is skipped and reported once through `reportInstructionFailures()` in `backend/server.js`,
  which logs only when the failure set changes. Nothing about a bad instruction file may fail a request.
- `config.instructionsDir` (`CARO_INSTRUCTIONS_DIR`, default `~/.caro-anki/instructions`) has **no** seed directory
  and **no** marker, unlike `skills/`: the factory setting is already the agent's own prompt, so there is nothing to
  bootstrap. Do not add a seeded default — an instruction the user did not write would silently change their cards.
- `instruction` is the supported way to author or revise these files. It is one command on purpose: the whole
  directory is already in the agent's prompt, so the agent decides whether a request extends an existing topic or
  needs a new one, and the user never has to know which files exist — never split it back into a create/update
  pair, and never ask the user to list or paste their files. A change to the format belongs in
  `instruction/references/format.md` and its tests, in the same change.

## Persisted page view

A reload lands on the view that was left: the query (re-run against the collection), the sort, the selection, the
scroll position, the open note editor, the open conversation, and the quick-search groups' fold state.

- `frontend/scripts/core/browser-state.js` (global `BrowserState`) owns that record — its shape, validation, and storage. It
  stays pure and UMD like `note-list-state.js`: `normalize` replaces every field it cannot trust, `read` swallows a
  corrupt record, and `write(storage, key, patch)` **merges a patch over the stored record** so independent writers
  (the chat's session id, the note list's own state) never clobber each other. `localStorage` is touched only
  through `readBrowserView` / `writeBrowserView` in `app.js`.
- The record is written through one funnel: `app.js` `renderSelectedCount()` is where selection, active note, and
  editor changes already met, so `persistView()` is debounced from there and from the list's scroll frame;
  `flushView()` writes immediately on `pagehide`. `viewReady` gates every write until `restoreBrowserView()` has
  applied the stored state, so a boot can never overwrite the record it is restoring.
- The chat's session id is the exception: its writer is `renderChatMode()`, and the boot's own `showSessions()`
  patches it with `null`, so the id to reopen is captured once (`openedSessionId`) before anything renders and
  applied by `checkHealth()` after the session list has loaded. A stored session that no longer exists falls back
  to the list.
- Quick-search groups fold independently and all start expanded: `collapsedGroups` is a set of the folded labels,
  and an empty set means every group open. Never reintroduce a single active group that collapsing another folds.

## Frontend modules

`frontend/scripts/app.js` is the page's wiring only: it builds the shared clients, hands each controller its dependencies,
and runs the boot sequence. Every feature lives in its own file, loaded before it in `frontend/index.html`.

- Each file is UMD — `((root, factory) => { const api = factory(); if (typeof module === 'object' &&
  module.exports) module.exports = api; else root.Caro<Name> = api; })(globalThis, () => { … })` — so
  `backend/test` can require the pure ones under Node.
- A controller exports `create<Name>({ …deps })` and destructures that one injected object: it never reaches for a
  dependency off `window`, and `app.js` destructures its returned surface.
- Controllers own their DOM: `core/api-client.js` (`request`/`streamChatRequest`, both deadline-armed),
  `anki/sync-controller.js`, `chat/chat-controller.js`, `settings/settings-dialogs.js`, `anki/anki-browser.js`.
  Pure, unit-tested logic stays separate: `anki/note-list-state.js`, `anki/note-selection.js`,
  `core/browser-state.js`, `anki/note-shortcuts.js`, `chat/skill-menu.js`, `chat/chat-stream.js`,
  `chat/markdown.js`.
- The note selection has one decision and one writer: `anki/note-selection.js` resolves every gesture — click,
  modifier click, arrow step, select-all, clear, and the landing the preview or the editor asks for — into the one
  `{ ids, anchorId, focusId }` shape (`landing` adds `changed`/`editorId` because an open editor is what the
  landing moves), and `anki-browser.js` `applySelection` is the only place that writes it and repaints. Because the
  list, the preview, and the editor all ask for the same landing, they cannot disagree; never mutate
  `selectedIds` or `selectionAnchorId` directly.

## UI kit

Every interactive control comes from `frontend/scripts/core/ui-kit.js` (global `CaroUI`, loaded before the app)
and the base styles in the "UI KIT" section of `frontend/styles/app.css`. Build new controls from these families instead of
adding another bespoke one; a controller must only wire them to this page.

| Family | Kit API | Base class |
| --- | --- | --- |
| Icons | `icons.icon()` / `iconButton()` | `.icon`, `.button-icon`, `.button-with-icon`, `.icon-button` |
| Fields | `fields.autoGrow` / `fields.setTextareaValue` / `fields.optionsHtml` / `fields.renderEntityPicker` / `fields.pickerRow` | `.field` + `.field-lg \| -md \| -sm \| -bare \| -select` |
| Status text | `status.set($element, text, kind)` | `.system-message.is-pending \| -ok \| -warn \| -error` |
| Dialogs | `dialogs.create({ selector, onOpen, onClose })` | `.dialog` + `.dialog-sm \| -md \| -lg` |
| Destructive confirm | `confirm.armed(onConfirm)` | `.button-danger` (armed state) |
| Text helpers | `text.escapeHtml` / `escapeAttr` / `plainText` / `formatDateTime` | — |

- Never add another way to do one of these: no second icon sprite entry (add a `<symbol>` to the sprite),
  no per-dialog Escape/backdrop handling (see Dialogs), no hand-rolled two-step delete (see Destructive
  actions), and no `console`-style escaping helpers in `app.js`.
- Icon buttons are square targets sized by `--icon-button-size` / `--icon-button-glyph`: 38px for a toolbar
  action (`.button.button-icon` plus a `.button-quiet`/`-dark`/`-warn` colour), 26px for a bare `.icon-button`, and
  `-xs`/`-sm` for 20px/24px chips and field toggles. Use `.button-with-icon` when an action needs both an icon
  and a visible label because the icon alone would be ambiguous.
- A button DEFAULTS to the shared icon button: `icons.iconButton()` — or the same `.button.button-icon` /
  `.icon-button` markup in `frontend/index.html`, matching its neighbours in that dialog — carrying its words in
  `aria-label` and `title`. A plain labelled text button is the exception, kept only for an operation whose meaning
  genuinely needs the words to be understood; never choose one because writing markup is easier. This holds for a
  dialog footer too: `Save` is the shared check icon, and a dismissal is the same close icon as the head's.
- Fields share one skeleton class: `class="field field-md"`. Size variants only add padding/font; a context
  rule adds the rest. Selects render their options through `optionsHtml(items, { value, label })` and the
  caller picks the value with `.val(...)` — never write `<option>` markup or a `selected` attribute inline.
- The Anki field readers (`noteTerm`, `noteMeaning`, `termFromFields`, `meaningFromFields`) live in the kit and
  accept both field shapes (AnkiConnect's `{name: {value}}` object and the browser's `[{name, value}]` array).

## Destructive actions

Every destructive control — delete/clear/remove of sessions, messages, notes, decks, or any data loss —
MUST go through the shared two-step confirm helper `CaroUI.confirm.armed()` (`armedConfirm` in `app.js`).

- First click arms: adds `button-danger` plus a "click again" `aria-label`/`title`, and starts the
  `config.timings.confirmArmMs` auto-disarm timer. Only the same button's second click runs the action.
- Wire it as `const xConfirm = armedConfirm(async $button => { … });` then
  `$button.on('click', event => { if (state.busy || state.pending) return; xConfirm.handle(event, '<arm label>'); })`.
- Never execute a destructive operation on the first click, and never add a `confirm()`-style or
  immediately-firing delete handler. Restore the button's original label/title via the helper (do not
  reinvent the arming logic). Keep `confirm.armed` the single source of truth for this behavior.

## Dialogs

Every modal — now and in the future — is a native `<dialog>` opened and closed through `CaroUI.dialogs.create()`
(`createDialog({ selector, onOpen, onClose })` in `app.js`). It is the single source of truth for dialog
lifecycle, so no dialog may hand-roll dismissal.

- Create it once and keep the handle: `const batchDialog = createDialog({ selector: '#ankiBatchDialog',
  onClose: resetBatchDialog })`; use `dialog.open()` / `dialog.close()` / `dialog.isOpen()` — never call
  `showModal()` or `element.close()` directly. `open()` is idempotent, so calling it on an open dialog is safe.
- `dismissible: false` is for the one modal the user must not close (the sync transfer window, which holds a
  collection that is mid-replacement): the factory still owns Escape, the backdrop and `[data-dialog-close]`,
  it simply refuses to act on them, and the code that opened it is the only thing that closes it. Never gate a
  modal any other way.
- `onOpen` runs before `showModal()` (fill the dialog's content there); `onClose` is the reset hook and runs
  on the native `close` event AND when `close()` is called on a dialog that is not open. Use it to drop
  dialog-scoped state such as `batchMode` and to hide inline errors.
- The factory owns every way out: Escape (one document CAPTURE listener registered before all page
  shortcuts that closes the topmost open dialog and stops the event, so it never also triggers the action
  behind it — e.g. leaving the note editor or clearing the browser selection), a backdrop click, and any
  `[data-dialog-close]` element inside the dialog. Mark dismissal buttons with `data-dialog-close` in
  `frontend/index.html` instead of binding click handlers.
- Never add a per-dialog Escape, backdrop, or cancel-button handler, and never guard an unrelated shortcut
  with `$someDialog[0].open` — the capture listener already consumes Escape while a dialog is open. The
  factory tracks dialogs in creation order and targets the last-created open one, which is sufficient while
  a single dialog is open at a time; if dialogs ever stack, make the factory track open order instead of
  adding per-dialog handling.
- Keep the shared `.dialog` / `.dialog-body` / `.dialog-head` markup structure in `frontend/index.html` so
  dialogs stay visually consistent; a dialog's size is a variant class (`.dialog-sm`, `.dialog-md`, `.dialog-lg`).
- `.dialog-body` is a dialog's one scrolling pane and `.dialog-head` is `position: sticky` inside it, bled to the
  body's own `--dialog-pad-x` and carrying the body's own `--dialog-pad-y` as its top padding, so it covers the
  scrollport from its first pixel once stuck. The body states no top padding on purpose: a sticky box is clamped to
  its containing block, so a padded body leaves a band above the head that content scrolls through. Its own bottom
  padding (`--dialog-head-pad-b`, 8px) is what keeps a scrolling row from touching the title, so it stays inside
  the head's box rather than in a margin the head would not cover, and the body's own gap adds to it. That bottom
  edge also carries the head's own `border-bottom`, so every dialog closes its title bar off the same way instead of
  leaving the line to whichever block comes first — a section that directly follows the head states no `border-top`
  (`.dialog-head + .anki-entity-section`), because the head already drew it. Never give a dialog its own scrolling
  head or a second scroll container; a dialog whose panels scroll internally keeps the head pinned by not scrolling
  the body at all.

## One-row entity pickers

Note Type Studio (and its card templates), Deck Studio, Study Options and the Collection Profile picker in Settings
pick, rename and create their entity from one row, built by the shared
`CaroUI.fields.pickerRow({ manager, ids, sentinel, entity, run, … })` factory in `frontend/scripts/core/ui-kit.js`.

- The row is three modes over one set of controls: `pick` shows `#…Select` with `sentinel` **first**, and a selection
  that is the sentinel enters `create` while any other selection is committed to `manager.select`; `rename` and
  `create` swap the select for the matching input and turn the confirm button into a check. `toPicker` returns to
  `pick`, which is also where blur lands unless focus moved onto a row button.
- `ids` is `{ select, rename, create, confirm, back, remove }` (`remove` optional) and `entity` is the lower-case
  noun every label is built from (`deck` -> `Create a deck`). `article` is what the list's create step puts in front
  of that noun, and it is the one label built without an entity to name, so an uncountable noun passes `''`
  (`study options` -> `Create study options`). `option` is spread into `renderEntityPicker` so a caller can pass its
  own `value` / `label` / `name` mappers.
- `run(work, success, { onSaved })` is the caller's own write path, so the row inherits the caller's status line and
  queue instead of inventing a second one; `isReady()` is the caller's in-flight guard, `create` / `rename` default to
  `manager.create` / `manager.rename`, and `messages` overrides the two default `Created …` / `Renamed …` sentences.
- `arm: { className, hint(name) }` is for a rename that cannot be taken back — a collection profile's rename moves a
  folder — and asks for that press twice, stating `hint(name)` on the button in between, while a new entity stays a
  single press.
- `onMode(mode)` is where a caller shows and hides the elements that belong to one mode rather than to the row (a
  panel only the list shows, a field only a new entity needs), and `stay` names the controls it showed that way: a
  form is left by its own input, so without `stay` moving the focus onto such a control would read as the user
  abandoning the form.
- `render()` paints the row and does not call back into the caller: a caller repaints from `onPick(id)` and returns
  the same `render()` from its own full render. Never write a fourth picker by hand — add what a new dialog needs to
  this factory.
- A caller's `load` path must put the row on the entity the list says is current instead of on whatever the list put
  first, because the row's own writes are offered for what it shows.

## Card contract

The card contract must align with `caro-btt` CardPrompt and `caro-anki-card` templates. Keep field definitions in
one backend module; do not duplicate them in jQuery event handlers or route code.

## Validation

Run `npm run check` and `npm test` after backend or SQLite changes. For frontend changes, also open the local server
and verify empty, loading, error, and narrow viewport states.

- `npm start` and `npm run dev` are servers: they never return, so never run them as a foreground blocking
  command (it looks like a hang for as long as it runs). Use an asynchronous terminal or the desktop app.
- Every wait on an external process is bounded, and the bound measures silence: the Anki bridge's `timeoutMs`
  answers 504 and is re-armed by each `__ANKI_BRIDGE_PROGRESS__` line, the DeepSeek provider's `idleTimeoutMs`
  is re-armed by every streamed chunk, and Keychain calls run through `execWithTimeout`. A wait that can
  outlive its deadline without an answer is what leaves the UI stuck, so a new wait must settle on expiry too.
- The frontend follows the same rule through one mechanism: `frontend/scripts/core/api-client.js` `armDeadline` is the silence
  deadline every request carries (`config.timings.requestTimeoutMs`, and `streamIdleMs` for a chat turn),
  re-armed by whatever proves the request is alive — the sync from its progress poll, the chat stream from each
  event — and cleared the moment the request settles. Never add a bare `await fetch(...)` on a path the UI waits
  on: an unanswered request has to fail with `deadlineError`'s sentence instead of spinning forever.
- Tests that need the real backend use `backend/test/server-process.js` `startServer()`, which drains both
  pipes and reports what the server wrote when it dies while starting. Fixtures under `backend/test/fixtures/`
  must exit when their stdin ends, and a test must `close()` every client it opened.

## Desktop development entry point

- `desktop/` owns the Electron development window, source watchers, and backend process lifecycle.
- Run the backend with external Node.js 26+, preserving the existing `.env` and SQLite paths.
- Keep renderer Node integration disabled, context isolation and sandbox enabled.
- The development app owns the backend lifecycle: it probes the configured port, starts `backend/server.js` with
  external Node.js, and stops it on quit.
- Development prefers the checkout's `tmp/anki-runtime`; production uses its bundled helper at
  `Contents/Resources/anki-runtime`. When `backend/anki_bridge.py` changes, rebuild the development helper before
  restarting the backend. Keep explicit runtime overrides authoritative.
- `scripts/js/install-desktop-dev.js` builds a local app bundle that references this checkout. Never copy secrets
  into it.
