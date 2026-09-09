# Skills

A **skill** is a folder of instructions the Anki agent can load on demand. It is the supported way to add a
reusable procedure — an audit, a vocabulary drill, a review routine — without changing the backend.

Skills are markdown only. They are read, never executed: a skill cannot run shell commands, call HTTP, or
reach AnkiConnect. Everything a skill asks for is performed by the agent's normal tools, under the normal
rules.

## Where skills live

| Location | Role |
| --- | --- |
| `~/.caro-anki/skills/` | The live library. Edit it freely. Override with `CARO_SKILLS_DIR`. |
| `skills/` (this folder, in the repo) | The bundled seeds. Read-only. |

The app copies `skills/` into the live library **once**, the first time it starts. It never overwrites a
file afterwards, so your edits survive. If you delete a seeded skill it stays deleted; copy it again from
this folder if you want it back. Delete `~/.caro-anki/skills/.caro-seeded` to re-copy the current seeds
(that only adds files that are missing — nothing existing is replaced).

## Bundled skills

| Skill | What it does | Argument |
| --- | --- | --- |
| `card-audit` | Reviews notes against the note type's own card profile and reports every violation without writing. | a deck, search query, or selection |
| `instruction` | Interviews you for a standing preference, then shows the instruction file — a new topic, or the smallest edit to one you already have. | the topic or rule to change, or the preference it should capture |
| `skill` | Interviews you for a procedure, then shows the skill folder it would write, rename, or retire — a new skill, or the smallest edit to one you already have. | a skill name, or what it should do, and what should change |

The two authoring skills show you the change before it happens. They hand the files to
`propose_instructions` / `propose_skills`, which place a Preview button under the reply for files they would write
and write nothing — clicking it opens the complete draft, so the message above it is the reasoning and never a
second copy of the file; once you say yes, the agent applies that same text with `apply_instructions` /
`apply_skills`, and no answer may claim a file was written before one of those calls answered. A write is announced
in words: nothing is written until you agree, so the preview you read is the text that lands. The library is
re-read on every request, so an applied file is live immediately, with no restart. Every replaced, renamed, or
retired text is kept beside it under `versions/`.
A card profile reaches its library through the same pair of tools (`propose_card_profile` /
`apply_card_profile`), under the same rule: nothing you have not seen is written.

## Instructions vs skills

Two things a user can write, and they answer different questions. Pick by *when* it should apply.

|  | Instruction | Skill |
| --- | --- | --- |
| Location | `~/.caro-anki/instructions/<topic>.md` (flat) | `~/.caro-anki/skills/<name>/SKILL.md` |
| Loaded | On every request, always | Only when named or matched by the model |
| Put in the prompt | The whole file, every turn | Only its one-line description, until loaded |
| Answers | "How should you behave?" | "How do I do this task?" |
| Shape | A short list of preferences and rules | Scope, workflow, references |
| Invoked | Never — it just applies | `/name <argument>` in the composer |
| Frontmatter | None | Required (`name`, `description`, …) |
| Cost | Paid on every turn | Paid only when read |
| Author with | `/instruction` | `/skill` |

An instruction is a preference: reply language, card style, how aggressive the agent is about asking. A skill
is a procedure: an ordered set of steps that only makes sense once it has started.

Instructions are framed by the app as **preferences, not permissions** — a file cannot add a tool, relax the
read-before-write rule, or claim a field the note type's profile does not define. Neither can a skill.

Editing either one needs no restart: both directories are re-read on every request.

## Card profiles

`~/.caro-anki/card-profiles/<NoteType>.json` is the note type's own contract — its fields, where each one is
stored in Anki, separators, allowed values — compiled by `backend/card-profile.js` and read by the agent with
`read_card_profile`. It is not something you have to hand-write: the agent edits it the way it edits an
instruction, through `propose_card_profile` (a whole profile, or one field's keys) and `apply_card_profile`.
The file name follows the note type, so renaming a note type is a profile rename — one apply moves the file
and rewrites its `noteType` key together, which is what keeps a renamed note type compiling.

## Directory layout

```
~/.caro-anki/skills/
├── card-audit/
│   ├── SKILL.md                       # required — the instructions
│   └── references/
│       └── field-contract.md          # optional — read only when needed
└── my-skill/
    └── SKILL.md
```

- Exactly **one level deep**: `skills/<name>/SKILL.md`. A skill in a nested folder is ignored.
- The folder name **is** the skill name.
- `README.md`, dotfiles, and folders without a `SKILL.md` are ignored.
- A skill whose frontmatter is invalid is skipped and reported as an error — it never breaks the others.

## Frontmatter

`SKILL.md` starts with a YAML-style block between `---` lines. Only flat `key: value` pairs are read; nested
values are ignored. Unknown keys are ignored, so you can keep your own notes in there.

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `name` | yes | — | Must equal the folder name. Lowercase letters, digits, single hyphens. |
| `description` | yes | — | One or two sentences: what it does **and** when to use it. This is all the model sees until it loads the skill, so write it for matching, not for marketing. |
| `argument-hint` | no | — | Placeholder shown in the composer's skill chip once the skill is pinned, describing the argument to write after the command. |
| `user-invocable` | no | `true` | `false` hides the skill from the slash command list. |
| `disable-model-invocation` | no | `false` | `true` keeps the skill out of the catalogue the model sees, so only the user can invoke it. Use it for skills that must never run on the model's own initiative. |

```yaml
---
name: card-audit
description: Audit existing notes against the card contract and report every violation without writing. Use when the user asks to check or clean up notes.
argument-hint: "[deck or search query]"
---
```

## Body

The body is plain markdown with no required sections, but every seeded skill uses the same shape so a reader
can predict it:

```markdown
## Scope
What this skill does, and what it deliberately does not do.

## Workflow
The ordered steps the agent takes.

## Card rules
The subset of the note type's card profile this skill depends on, read at run time with `read_card_profile`
before the skill judges anything.

## References
One line per file in `references/`, and when to read it.
```

Keep the body short. Put detail in `references/` instead — see below.

## References (progressive disclosure)

The catalogue shows only a skill's `description`. Loading a skill shows its body. Anything longer than that
belongs in `references/`, read one file at a time, only when the task actually needs it.

- References are **flat files inside `references/`**. Names may use letters, digits, `.`, `_`, `-` and must
  end in `.md` or `.txt`. Nested folders, `..`, and absolute paths are rejected.
- Document each reference in the body's `## References` section with the exact file name and the condition
  for reading it. A reference the body never mentions will never be read.

## Hard limits

A skill is instructions, not privilege. The following hold no matter what a skill says:

- **No shell, no HTTP, no AnkiConnect, no credentials.** Skills are markdown; the agent's tools are the only
  way to act, and they are already scoped.
- **Read before write.** Every edit or deletion reads the affected notes first. A skill cannot waive this.
- **Never replay an interrupted write.** If a tool call is interrupted, report it; do not re-run it.
- **Card content follows the note type's own profile.** The profile that describes it
  (`~/.caro-anki/card-profiles/<NoteType>.json`, compiled by `backend/card-profile.js`) is the single source of truth
  for field names, required fields, separators, and the allowed `type` / `typeLabel` values. Do not restate
  its rules in a skill as if the skill were authoritative — point at it.
- **One sense, one card.** Taiwan Traditional Chinese for translations and annotations.
- **Plain text, not JSON.** Field values are the text a human would read; lists use the contract's
  separators.

## Limits

| Item | Limit | Behaviour when exceeded |
| --- | --- | --- |
| `name` | 64 characters, no `--` | skill skipped and reported as an error |
| `description` | 1024 characters | skill skipped and reported as an error |
| body / single reference | 16000 characters | truncated for the model, marked `…(truncated)` |

## Invoking a skill from the composer

Type `/` in the composer and the menu offers every skill; picking one — or typing a `/name` that matches an
installed skill — pins it. A pinned skill is shown as a chip above the input and the message itself starts with
its command:

```
/card-audit 檢查這三張卡片
```

- The leading `/name` is how the app knows which skill to use — it is read from the message, so nothing else needs
to be set. Everything after the command is the skill's argument, and the chip's placeholder is the skill's
`argument-hint`.
- A pinned skill is loaded before the model even sees the request, so it applies even when the model would not
have picked it itself. The conversation reports it as a skill step like any other load.
- Only an exact name counts, and only at the start of the message: `/card-audit-extra` or a `/name` written
mid-sentence stays ordinary text. A command can be removed with the chip's ✕, which leaves the argument in place.

## Checking your work

Invalid skills are listed in the skill library's error output rather than failing silently, so a typo in the
frontmatter is visible instead of leaving you with a skill that never appears. Editing the library needs no
restart: the menu and the agent both re-read it on each request.
