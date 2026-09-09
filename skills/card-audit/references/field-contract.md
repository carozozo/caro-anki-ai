# The card profile — how to read it, and what to check

A card's shape is not in this file, and not in the code. It lives in the profile the user wrote for the note
type, and `read_card_profile` hands you that profile: the note type's logical fields, where each one is
stored in Anki, and the rules a card of that note type must satisfy. Read it before judging a note.

Never carry a field name in from somewhere else — another collection, another note type, an earlier
conversation, or this file. A name that is right somewhere else is a wrong finding here, and a wrong finding
costs the audit its credibility. Everything below is a question to ask of the profile you were handed.

Where this file says *the profile*, it means that answer: the rules themselves, not a module and not an
example.

## The answer you get

`read_card_profile` answers with the profile that compiles the note type, with every default written out, so
the answer is the whole shape rather than a diff against one:

- `noteType` — the Anki note type this describes. It must be the one the notes really are; `list_decks`
  answers nothing about that, so a note's own type comes from its fields.
- `profile` — the version of the profile format itself, which the user does not write.
- `version` — the profile author's own version string, when they set one.
- `groups` — named value lists the profile's conditions point at.
- `fields[]` — the logical fields, in order.
- `storage[]` — how those fields reach Anki's fields, in order.
- `collapseDuplicates[]` — `{ keep, fields }` groups: when every field named holds the same value, the
  profile writes `keep` alone and blanks the others.

With no name at all the call answers for this collection's own note type. When that one has no profile either,
and whenever the name you pass is not installed, the answer is instead the installed list plus the path a
profile for that note type belongs at — read it as a finding, not as a dead end: see **When no profile is
installed** below for what an audit can still say.

## Reading `fields[]`

| Key | What it settles |
| --- | --- |
| `name` | the logical field, and the word to use in the report |
| `kind` | `text`, `list` (several items in one value), or `lines` (rows of sub-fields) |
| `required` | the value, or at least one item, must be present |
| `requiredWhen` / `forbiddenWhen` | a condition on another field's value: `{ field, in, notIn, message }` — required or forbidden while it holds, and `message` is the author's own wording for it |
| `enum` / `enumMode` | the closed list of allowed values; `labels` means the value is written space-separated in canonical order, so `A or B` also accepts `B or A` |
| `pattern` / `patternMessage` | a shape the value must match, and the sentence to complain with |
| `script` | `en` — must hold no Han characters; `zh` — must hold Chinese |
| `traditional` | `true` rejects characters Taiwan Traditional Chinese never uses |
| `forbiddenChars` | on a `text` field or a `lines` row: the characters the value may not contain at all, whichever script it is written in |
| `punctuation` | declared once at the profile's top level as `{ zh: '、；，。？！()/":%-' }`: the only punctuation a value of that script may use, so every other punctuation character in it is a finding. A script the profile omits is not checked |
| `minItems` / `maxItems` / `maxChars` | bounds on how many items a list holds, or how long one value may be |
| `guidance` | what the generator was told to write, which is guidance rather than a rule (see below) |
| `sort` | `visualLength` — the field is ordered shortest first on the way to Anki, so order alone is never a finding |
| `item` | for a `lines` field: `{ fields: [{ name, required, guidance, script, traditional, allowTags, endPunctuation, widePunctuation, forbiddenChars }] }`, the row shape and what each cell of it must be |
| `ai` / `editor` | `false` marks the field user-owned (`ai`) or hidden from the editor (`editor`) — see below |

Both flags are always present, and they answer different questions. `ai: false` marks a field the user owns:
the agent never writes it, and an audit never judges it — its content is the user's business, so never report
it as missing or wrong. `editor: false` only means the note editor leaves the field out of its form; the field
is still written and still audited, and an example field is usually the one carrying that flag.

## Reading `storage[]`

One entry per Anki field:

| Key | What it settles |
| --- | --- |
| `field` | the Anki field name, the one written on the note |
| `of` | the logical field(s) it holds, always a list, in write order — more than one means they share this field |
| `join` | what separates those parts, and what separates the items of a `list` field |
| `line` | a `lines` field's row template, e.g. `{en} {zh}` |
| `stripEnds` | characters dropped from either end of the written value |

This is the layer that makes the two lists differ, and the layer an audit gets wrong. A logical field with
no field of its own is **not** a missing field — it lives inside a shared one, in the order `of` gives, joined
by `join`. So the checks that read a field are checks about the part of it: which part a value belongs to,
and whether every part the entry names is actually there. Reporting a shared field's second part as a missing
field is itself an audit defect.

## Checks

**Language** — a `script` and a `traditional` rule is what the profile says about a field's characters: `en`
must hold no Han at all, `zh` must hold Chinese, and `traditional` rejects the set of characters only
simplified Chinese uses (a `traditional` field is a Taiwan Traditional Chinese one). Report the field and the
character that broke the rule. Do not "fix" any of this by rewriting the value yourself while auditing.

**Machine-shaped values** — a field must hold the text a reader sees. `["a","b"]`, `{"en":"…","zh":"…"}`, or
a quoted JSON string is a defect even when the content inside is correct, because the stored value is
rendered verbatim rather than parsed.

**Required content** — `required`, `requiredWhen` and `forbiddenWhen` are the hard part of the profile, and
their wording comes from the profile itself. For a shared `storage` entry, a part that is missing is exactly
as much a missing field as an empty one of its own: the value has fewer parts than `of` names, so the reader
sees a half.

**Type and label** — an `enum` is closed. A value outside it is a defect, including a value that is right in
substance but not in the list's own spelling. `enumMode: labels` accepts the listed labels in the order they
are named and writes them in that order, so a reversed pair is not a defect.

**Senses** — one sense per note. Two senses crammed into one definition (often joined by `;` or `、`) is a
defect, and so are two notes whose term and definition say the same thing. Report both halves.

**Separators** — a `list` is written with the `join` of its own storage entry, spacing included. A list
joined another way, or a field holding content that belongs to another field, is a defect.

**Duplicates** — inside a `collapseDuplicates` group, every field holding the same value is the case the
profile drops. Content that is genuinely different is correct, and a group whose fields differ is not a
finding at all.

**Examples** — a `lines` field is a list of rows, each row the sub-fields `item.fields` names. Report a note
when

- the whole field is empty — the card shows no use of the term at all;
- a row is missing one of its required sub-fields;
- the row's text does not use the term or a natural inflection of it, or states a sense the note's definition
  does not;
- the row's halves disagree: the translation says something the sentence does not. A related word instead of
  this sense counts here, because the line then teaches the wrong word;
- the row is not an example at all: a definition instead of a usage, a bare word or fragment, no terminal
  punctuation where the row's `endPunctuation` requires it, or inline markup used for something other than
  rendering a `allowTags` entry names.

How MANY rows a note holds is the owner's decision — see below. Ordering is the profile's own `sort`, so
ordering alone is never worth reporting.

## When no profile is installed

`read_card_profile` answers with the installed list and the path a profile for this note type belongs at. That
is the first finding, not the end of the audit: report it plainly, name the path, and say which checks you
could not make.

The checks that survive are the ones the notes themselves answer — values that are machine-shaped, fields
whose two halves disagree, definitions or examples that teach the wrong word, two notes claiming the same
sense. The checks that need the profile — required fields, separators, allowed values, script rules, the row
shape of a `lines` field — cannot be judged without it, so do not guess a field name to fill the gap.

## Contract rules vs generation shape

The profile is the whole hard rule set. The card-style instruction the user installs under
`~/.caro-anki/instructions/` asks for a richer shape than the profile enforces — 3–6 examples per note, for
instance. That guidance is addressed to the agent while it CREATES a card; it is not a rule the collection
must keep satisfying.

So treat a count that misses the guidance as expected, not as a defect. The user curates their own notes
after creation and may deliberately trim what the generator produced — keep only two examples, drop one of
several senses, rewrite a translation. Those are the owner's choices, so **how many examples a note holds is
never a finding, in either direction**: two is as acceptable as six.

What still matters is whether what remains is usable. Report a shortfall only when it is one of substance —
the example field empty, or a row that is not a valid, appropriate example of this card's sense — and never
because a count sits below the guidance. Name the guidance you are citing when a create-time shape rule is the
reason something is worth mentioning at all.

This is exactly where the report's two prefixes divide (see the skill's `## Report format`): a shape gap that
survives the profile is an `s` line, never an `i` one. An empty example field is an issue; two examples where
the generator wanted four is a suggestion, and if the user trimmed it on purpose it is nothing at all.
