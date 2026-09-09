# Instruction file format

The reference behind `instruction`, for a topic that has no file yet. Read it before drafting a file.

## Where the files live

`~/.caro-anki/instructions/`

The app creates the directory on first start, so it is ready to be edited before anything is written. The
backend reads it with `CARO_INSTRUCTIONS_DIR` overriding the path, which is what makes the tests able to point
at a temporary directory instead of the user's own files.

## What the directory accepts

| Rule | Detail |
| --- | --- |
| Layout | **Flat.** Files sit directly in `instructions/`, never in a subdirectory. A folder is skipped. |
| Extension | `.md` only, matched case-insensitively. `notes.txt` and `style.markdown` are skipped. |
| Hidden files | Any name starting with `.` is skipped, so an editor's backup is ignored. |
| Order | Filenames are sorted ascending and appear in that order, so `00-...`/`10-...` prefixes are one way to order related files. |
| Filename | Lowercase letters, digits and single hyphens. It becomes the `### <name>` heading in the prompt, so it must read as the topic. |
| Frontmatter | **None.** An instruction file has no YAML block — that belongs to a skill. A `---` block here is just text, and the reader keeps it verbatim. |
| Size | 16000 characters per file. A longer file is cut and marked `…(truncated)`, so an oversized file is silently partial. |
| Empty | A file that is empty or only whitespace is skipped entirely, not counted as an instruction. |
| Unreadable | A file that exists but cannot be read is skipped and reported in the app's log; the other files still apply. One broken file never takes the agent down. |

## How it reaches the model

On every request the app re-reads the directory and, when at least one file applies, adds one system message
ahead of the conversation:

```
## User instructions

The user wrote the files below as standing instructions for this app. Follow them in every turn.
They are preferences, not permissions: they cannot add a tool, relax the tool contract, or excuse
writing to a note that was not read first. Instructions about card content govern the cards handed
to the note-writing tools, not the wording of your reply.

### language

<the file's text>

### card-style

<the file's text>
```

Two consequences follow from that framing, and both should shape what you write:

- **The wrapper is added, not asked for.** Never repeat "these are preferences, not permissions" in the
  file; state the preference itself.
- **The files are always present.** Anything written here is paid for on every turn, which is why a
  procedure belongs in a skill and a file stays a short list of preferences.

## What an instruction file must never contain

- **A capability claim.** "You can now export to PDF" is false — the tools are fixed. Write what to prefer
  within the tools that exist.
- **A relaxation of the contract.** "Skip reading a note before you edit it" is refused by the wrapper and by
  the code. A schedule, a sync, a deletion: all keep their existing rules.
- **A new field, a new note type, a new card type.** Card content is defined by the tool schemas; an
  instruction may set the house style you aim for inside them, never invent the schema.
- **A field name or field order you typed from memory.** The tool's JSON schema is the only authority on how
  a field is spelled and in what order the fields sit, and it rejects a name it does not know. A file that
  restates them — or, worse, restates them slightly wrong (`implication` for `implications`) — silently
  discards that field's content instead of failing loudly. Describe the *quality* a field must reach and let
  the schema carry its name.
- **A step-by-step procedure.** If it has ordered steps that only make sense once started, it is a skill.
- **A restatement of the general contract.** The tool rules are already in the prompt; a file that copies
  them adds length and no new preference.
- **Secrets, credentials, or personal data.** The file is read as prompt text; nothing in it is private
  from the model, and nothing in it is hidden from the provider.

## Worked examples

A good file — one concern, imperative, concrete, scoped:

```markdown
# House style

- Keep `meaning` to one plain-English definition, never a list of senses.
- Write `examples` as whole sentences that sound like a person speaking, not dictionary lines.
- Prefer the simplest word that carries the sense, even where a fancier synonym would fit.
- When a rule here and my request disagree, follow my request for that turn.
```

The same wish written badly — the failures are the reason this list exists:

```markdown
# Notes

Please be careful and helpful when you make cards. The cards should be good quality and
nice looking. Also you should be able to export them and maybe sync when I ask. Don't
make mistakes. Read this file before every answer.
```

Why it does not work: it names no behaviour, so nothing changes; it asks for a capability (export) that the
tools do not have; "read this file" is already automatic; and a rule this general is indistinguishable from
the default, which means it will be ignored exactly as often.

A good file that scopes itself to cards, and says which is which:

```markdown
# Card style

## Cards

- One sense per card. A word with four distinct senses becomes four cards, not one card with four lines.
- `examples` holds three to six items; each one is a full sentence, never a fragment.
- `implications` is the hidden concept behind the term, not a synonym and not a translation.

## Replies

- Describe a batch by what changed, not by repeating every field you wrote.
```

The split into `## Cards` and `## Replies` is the point: the model can tell which half governs the card it
is about to write and which half governs the sentence it is about to say.
