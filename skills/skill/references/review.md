# Reviewing an installed skill

Run this pass after loading the skill, before any edit. It is a reading checklist, not a rewrite plan: report
what is wrong, then change only what the user asked for. When a skill is broken beyond a targeted edit, say
that and offer the replacement — never quietly restructure a skill the user did not ask you to restructure.

`backend/skill-library.js` is authoritative for the format, the profile that describes the note type
(`~/.caro-anki/card-profiles/<NoteType>.json`, compiled by `backend/card-profile.js`) for card content, and
`skills/README.md` in the repo documents the format for a human reader.

## Frontmatter

- **`name` equals the folder.** A mismatch does not degrade the skill, it removes it: the loader skips the
  folder and lists it as an error, so a skill the user believes is installed never appears. This is also the
  line a rename rewrites, and the reason a rename is never a hand edit.
- **`description` is a matching line, not a summary.** It should name what the skill does and the requests that
  should trigger it. A description that only describes tone or quality ("a helpful assistant for Anki") gives
  the model nothing to match on.
- **`argument-hint` matches what the body expects.** A hint of `[deck name]` on a skill whose workflow takes a
  search query misleads the user at the moment they type it.
- **The two flags match the skill's risk.** `disable-model-invocation: true` belongs on a skill that must never
  run on the model's own initiative; `user-invocable: false` belongs on a skill that only makes sense as an
  internal step the agent loads itself. Neither flag substitutes for saying when the skill applies, and either
  one is the answer when a skill should stay in the library but leave the menu.

## Body

- **The steps match the tools that exist.** The agent has `search_notes`, `read_notes`, `create_notes`,
  `update_notes`, `delete_notes`, `list_decks`, `read_card_profiles`, `propose_card_profile`, `apply_card_profile`,
  `load_skill`, `propose_instructions`, `apply_instructions`, `propose_skills`, and `apply_skills`. A body that
  says to run a script, fetch a URL, or write a file describes something that cannot happen, and the model will
  improvise around it.
- **The proposal is its own instrument.** `propose_skills` shows a change and writes nothing, and
  `apply_skills` is the only tool that writes one — so a body that tells the agent to "save" or "install" the
  skill through some other route is describing an action it has no tool for. A revision reaches the library
  through the apply, and only after the user has agreed to it.
- **It says when to stop and what it must not do.** A procedure with no boundary is read as licence to
  continue: an audit that does not say it never writes becomes an audit that fixes things.
- **It resolves its target instead of defaulting to everything.** A body that quietly falls back to the whole
  collection turns a narrow request into a collection-wide pass.
- **It does not restate the card profile.** Field names, separators, allowed values, and the one-sense rule
  live in the profile that describes the note type, which a skill reads with `read_card_profiles`
  (`~/.caro-anki/card-profiles/<NoteType>.json`); a skill that copies them goes stale and then contradicts it.
- **The shape is predictable**: `## Scope`, `## Workflow`, and the sections the task needs — that is what makes
  a skill readable at a glance.
- **Nothing is said twice.** A rule in the body and the same rule in a reference means two places to keep in
  step; pick one.

## References

- **Named in the body, with a condition.** "Read `field-contract.md` before judging anything" is a reference
  the run actually reads. An unmentioned file is dead weight the agent never opens.
- **Flat, one level deep, `.md` or `.txt`.** Nested folders, `..`, absolute paths, and symlinks out of the
  skill's directory are rejected by design.
- **The body is not a table of contents for them.** Progressive disclosure only pays when the body stands alone
  and the reference adds depth.
- **Each one still earns its place.** A reference the workflow no longer reaches should be deleted and removed
  from `## References` in the same edit, not left behind as a file nothing names.

## Claims about the rest of the app

A skill that names a module, a limit, a tool, or a path is making a claim that ages. Check those claims against
the code rather than against the skill's own confidence:

- Card shape and allowed values → `~/.caro-anki/card-profiles/<NoteType>.json`, compiled by `backend/card-profile.js`.
- Format limits, frontmatter keys, reference rules → `backend/skill-library.js`.
- The tools an agent turn can call → the tool list in `backend/anki-agent.js`.
- Where the library lives, how seeds are copied, and which commands exist → `backend/config.js` and the repo's
  `skills/README.md`.

## Verdicts worth giving the user

- **No change needed** — the skill already covers the request. Say so and quote the passage.
- **Targeted edit** — one or two files change; apply those and only those, each one whole.
- **Rename** — the procedure is right and only its name is wrong: `renames: [{ name, to }]`, with the new
  command to type. Never restate a body just to give it a new name.
- **Split** — the skill now holds two procedures with different triggers, so two skills match better than one;
  apply the split and say which name each half takes.
- **Retire** — the collection work it describes is now handled elsewhere, so `removals: [name]` removes a menu
  entry that would otherwise mislead. It is the user's call, and the folder is kept under `versions/`, so it is
  reversible; a skill they want to keep but not see can be flagged instead.
