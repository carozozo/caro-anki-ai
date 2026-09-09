# Skill format — what you are writing

`backend/skill-library.js` is authoritative for every rule below, and the repo's `skills/README.md` documents
the same format for a human reader. Where this file and the module disagree, the module wins and this file is
out of date.

## Where a skill lives

| Location | Role |
| --- | --- |
| `~/.caro-anki/skills/` | The live library. This is where the folder your apply writes. |
| the repo's `skills/` | Bundled seeds, copied into the live library once. Never hand a user a repo path to edit. |

```
~/.caro-anki/skills/
├── my-skill/
│   ├── SKILL.md                       # required — the instructions
│   └── references/
│       └── review-checks.md            # optional — read only when needed
└── another-skill/
    └── SKILL.md
```

- Exactly **one level deep**: `skills/<name>/SKILL.md`. A skill in a nested folder is ignored.
- The **folder name is the skill name**, and the frontmatter `name` must repeat it exactly. That is what makes
  a rename two things at once — the folder and the one line that names it — and why the library does both in
  its own rename rather than leaving you to restate the body.
- `README.md`, dotfiles, and folders without a `SKILL.md` are ignored, so a stray folder in the library is
  invisible rather than harmful.

One call carries the folder whole: `apply_skills` takes the name once and every file beside it, `SKILL.md`
first and then the references it names. That is not a convenience — a folder that arrives one file at a time
is briefly a skill whose body points at a reference that does not exist, and the library validates the call
with the same rules it will load the folder by, so a file the loader could not read back is refused before
any file of that call is written. `propose_skills` takes the same change and writes none of it; the app places a
Preview button under the reply so the user can open the complete folder while deciding.

The same call carries the other two things a folder can be asked to do, because one change to the library is
one thing the user reads:

| Key | What it means |
| --- | --- |
| `files` | Create or replace a folder, whole: `SKILL.md` and the references that travel with it. |
| `renames: [{ name, to }]` | Move an installed folder to a new name. Its text is kept; the library rewrites the frontmatter `name` line so the folder still loads. A target that already exists is refused — a rename never replaces a skill. |
| `removals: [name]` | Retire an installed folder, so it leaves the menu and the catalogue. The folder is kept under `versions/` first, so it is recoverable. |

## Frontmatter

The file starts with a block between `---` lines. Only flat `key: value` pairs are read; nested values and
unknown keys are ignored, so a skill can keep its own notes in there.

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `name` | yes | — | Must equal the folder name. Lowercase letters, digits, single hyphens. |
| `description` | yes | — | What it does **and** when to use it. This is all the model sees until it loads the skill, so write it for matching. |
| `argument-hint` | no | — | Placeholder shown in the composer's chip, describing the text written after the command. |
| `user-invocable` | no | `true` | `false` hides the skill from the slash menu, leaving it reachable only by the agent. |
| `disable-model-invocation` | no | `false` | `true` keeps the skill out of the catalogue the model sees, so only the user can run it. Use it for a skill that must never act on the model's own initiative. |

```yaml
---
name: my-skill
description: Review a named deck and report the results without writing. Use when the user asks for this review.
argument-hint: "[deck or search query]"
---
```

## Limits

| Item | Limit | Behaviour when exceeded |
| --- | --- | --- |
| `name` | 64 characters, no `--` | skill skipped, reported as an error |
| `description` | 1024 characters | skill skipped, reported as an error |
| body, and each single reference | 16000 characters | truncated for the model, marked `…(truncated)` |

A skipped skill is the failure mode to avoid: it does not appear in the menu or the catalogue at all, and the
error is only visible in the library's error output. So an invalid `name` or an over-long `description` is a
skill that silently does not exist.

## Body

Plain markdown, no required sections, but every seeded skill uses one shape so a reader can predict it:

```markdown
## Scope
What this skill does, and what it deliberately does not do.

## Workflow
The ordered steps the agent takes.

## Card rules
The subset of the note type's card profile this skill depends on — the shape the agent reads with
`read_card_profiles`, never a copy of it, because a copied field name goes stale.

## References
One line per file in `references/`, and when to read it.
```

Keep it short. The body is loaded on every run that uses the skill, so a paragraph the run does not need is a
paragraph the model reads instead of the request.

## References (progressive disclosure)

The catalogue shows the `description`; loading the skill shows the body; anything longer belongs in
`references/`, read one file at a time.

- Flat files inside the skill's own `references/`, named with letters, digits, `.`, `_`, `-`, ending in
  `.md` or `.txt`. Nested folders, `..`, absolute paths, and symlinks out of the directory are rejected.
- Only a path of the form `name + file` reaches one, and only through the `load_skill` tool, so a reference
  the body never names is never read.
- Document each one in `## References` with the exact file name and the condition for reading it.

## Hard limits a skill cannot waive

- **No shell, no HTTP, no AnkiConnect, no credentials.** Skills are markdown; the agent's tools are the only
  way to act, and they are already scoped.
- **Read before write.** Every edit or deletion reads the affected notes first.
- **Never replay an interrupted write.** Report it instead.
- **Card content follows the note type's own profile** — the one that describes it
  (`~/.caro-anki/card-profiles/<NoteType>.json`, compiled by `backend/card-profile.js`) — for field names, required
  fields, separators, and the allowed `type` / `typeLabel` values.
- **One sense, one card.** A second sense is a note of its own; how each field of it is written is the
  profile's business, not the skill's.
- **Plain text, not JSON.** Field values are the text a human would read; lists use the contract's separators.

## Good and bad

```markdown
# yes — the model can decide from this line alone
description: Review a named deck and report the results without writing. Use when the user asks for this review.
```

```markdown
# no — nothing here says when to load it, and the tone is not a trigger
description: A powerful assistant that helps you keep your Anki collection in great shape.
```

- `deck-tidy` — yes. `Deck Tidy`, `deck--tidy`, `deck_tidy` — no.
- `my-skill` with a `references/review-checks.md` that its body names — yes.
- The same file placed in the body and referenced again — no; pick one place for the content.
