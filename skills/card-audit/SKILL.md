---
name: card-audit
description: Audit existing notes against the note type's card profile and report every violation without writing. Use when the user asks to check, review, validate, or clean up notes, or asks why a card looks wrong.
argument-hint: "[deck or search query]"
---

## Scope

Review notes that already exist and report what breaks the note type's card profile. This skill **never
writes**: it produces a report the user decides what to do with. Fixing is a separate, explicitly requested
pass.

Every finding is labelled — `i` for an issue, `s` for a suggestion — so the user can answer "fix i1 and i3"
by label instead of quoting a sentence back (see `## Report format`).

Do not run this on the whole collection unprompted — it is meant for a named deck, a search query, or a
selection the user just made.

## Workflow

1. Resolve the target: the deck, search query, or selection the user gave. If they gave nothing, ask for one
   rather than defaulting to every note.
2. Read the note type's profile with `read_card_profile` before judging anything — it is the only source for
   the field names, separators, required fields, script rules and allowed values you are about to check, and a
   name carried in from another collection becomes a wrong finding on this one.
   `references/field-contract.md` explains the answer.
3. Use the `search_notes` tool to list the target's notes and `read_note` for the ones you will judge. Judge
   from the stored values, not from the term alone.
4. Resolve every logical field through the profile's storage before reporting on it. A logical field can share
   an Anki field with another, so having no field of its own is not a missing field — reporting one as missing
   is itself an audit defect. Judge the stored value the way a reader sees it.
5. Check each note against the profile's rules and the defect kinds in `## Card rules` below.
6. Report a note only when you can name the field and the exact defect, and label every finding as you write
   it: `i` for an issue, `s` for a suggestion. Group the report by label, most common first, because a defect
   repeated across forty notes is one fix, not forty.
7. State the count you checked next to the count you flagged. "12 of 240 notes" tells the user the audit
   actually covered the deck; a bare list does not.
8. Stop. Do not offer to fix until the user asks.

## Report format

Two kinds of finding, two prefixes. The split is the profile's, not severity: an **issue** is a rule the
profile requires, a **suggestion** is one the note would survive without.

- **`i` — issue.** A violation: something stored wrong, required content missing, or content that teaches the
  wrong thing. Everything listed under `## Card rules` is an issue.
- **`s` — suggestion.** A note that is valid but could be better, or something the profile deliberately
  leaves open — a stiffer-than-needed translation, a sense that could be split more narrowly, a usable but
  weak example, or a gap against the create-time guidance rather than the profile (fewer examples than the
  generator asks for). Never dress a suggestion up as an issue, and never call a note broken for one.

Name each finding in the profile's own words: the logical field, plus the Anki field it is stored in when the
profile stores it somewhere other than a field of its own — that is what lets the user find it in the editor.

Number each series from 1 in report order and keep them independent (`i1`, `i2`, `s1`). One label names one
problem and every note that shares it; two different problems in the same note get two labels. Write each
finding as a single line, label first:

```
i1: `translation` — its half of the shared field is missing — 12 notes (14, 27, 88, …)
i2: an example line states a sense the definition does not — 3 notes (8, 19, 40)
s1: the synonym list is empty although the term has obvious synonyms — 4 notes (2, 5, 31, 44)
```

It is normal for one series to be empty: a clean deck reports no `i` lines, a deck with no room for
improvement reports no `s` lines. Never pad the report to make either list exist — a finding the user cannot
act on by label is not worth its line.

## Card rules

The profile is the whole rule set. `read_card_profile` states which fields are required, which are required
only under a condition (`requiredWhen` / `forbiddenWhen`), how a list is joined, which values an enum allows,
which script a value must or must not hold, and which Anki field each logical field is stored in. Judge
against that answer and nothing else — this file deliberately names no field of any note type, because a name
that is right for one collection is a wrong finding on the next.

The defects worth reporting — every one of them an `i` line — in rough order of how often they matter:

- **Wrong language** — a value holding characters of a script the profile forbids, or missing the one it
  requires. A value that is one language where its storage entry names two parts is missing content, below.
- **Machine-shaped values** — a field holding JSON (`["a","b"]`, `{"en":…}`) instead of the text a reader
  would see.
- **Missing required content** — a required field empty; a field whose condition holds while the field is
  empty; or a stored field holding fewer parts than its storage entry names, which is how a shared field
  loses a half.
- **Wrong language in a half** — the parts of a shared stored field written in each other's script.
- **Invented type or type label** — a value outside the enum the profile allows, or a label list written in an
  order `enumMode: labels` does not canonicalize.
- **Merged senses** — one note covering two distinct senses, or two notes duplicating the same sense.
- **Separator drift** — a list joined with anything but the separator its own storage entry declares, or one
  field holding another field's content.
- **Unusable or missing examples** — a `lines` field empty, or a line whose halves disagree, whose text does
  not use the term, whose sense is not the one the note's definition states, or that is a definition or
  fragment rather than a sentence.
- **Redundant spellings** — a `collapseDuplicates` group whose fields all hold the same value, which the
  profile drops.

Judge what is stored, not what the generator would have produced. How many examples a note holds is the
owner's call — so a count is never a finding in either direction. Report a shortfall only when it is one of
substance: the example field empty, or a line that is not a valid, appropriate example of this card's sense.

## References

- `field-contract.md` — how to read a profile answer, what each check means against it, and what an audit can
  still judge when a note type has no profile at all.
