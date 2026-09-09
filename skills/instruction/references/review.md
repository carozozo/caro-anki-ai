# Revision checklist

The reference behind `instruction`, for a topic that already has a file. Run through it on the file as it
stands, before you show the replacement.

## First, is this the right kind of change?

| The request | Where it belongs |
| --- | --- |
| "Answer in Traditional Chinese" | instruction — always-on preference |
| "Stop adding extra words to `implications`" | instruction — a rule about card content |
| "When I ask for an audit, walk the fields in order" | skill — a procedure, run deliberately |
| "Make a deck-tidy routine" | skill — ordered steps with a start and an end |
| "Change the tool so it can export" | neither — the tools are fixed; the request cannot be granted this way |

If a revision would turn the file into the third row, say so and point at `skill` instead of applying
a file that no longer matches its own shape.

## Second, check the file it is replacing

Read the file you are revising for these before editing, because each one is cheaper to fix now than to inherit:

- **Frontmatter.** A `---` block does nothing here — it is kept verbatim and read as text. Remove it and fold
  anything meaningful into the body. (It probably arrived by copying a skill.)
- **A capability claim.** "You can now …", "you are able to …", "feel free to export …". The tools are fixed;
  rewrite it as a preference about what the file's subject actually is.
- **A relaxation.** Anything that lets a write happen without a read, guesses an ID, or replays an
  interrupted write. Remove it and say why — the wrapper already refuses it, so keeping it only misleads.
- **A whole procedure.** Numbered steps, a checklist, a do-this-then-that. That is a skill.
- **Restated contract text.** A copy of the tool rules adds length and no preference. Cut it.
- **Two concerns in one file.** Reply language plus card style plus workflow: propose the split, but do not
  split it as part of a request that asked for something smaller. Note it and let the user decide.
- **Absolute words with no scope.** "Always", "never", "everything", "all cases". Either scope it or make
  the reason explicit, so the model can tell when it does not apply.
- **Contradiction with another concern.** If the file says `meaning` stays English and another line asks for
  a Chinese `meaning`, that is not a revision — it is a question for the user.
- **Length.** The file is capped at 16000 characters and silently truncated past it with `…(truncated)`.
  A file near the cap is over budget for something read on every turn; tell the user and propose a split.

## Third, keep the edit minimal

- **Only the lines the request names.** An unrelated tidy-up in the same block is how a small edit becomes a
  review the user did not ask for.
- **The user's voice wins.** Their spelling, their order, their headings. You are the editor.
- **Do not renumber or regroup** unless the change forces it; a diff should read as the requested change and
  nothing else.
- **Do not add a rationale the user did not give.** A reason you invented will be applied to cases they
  never considered — better to leave the rule bare than to explain it wrongly.
- **No examples the user did not ask for.** One short before/after pair is fine when it is what the request
  was about; a paragraph of illustration is not.
- **Unchanged means unchanged.** If a line survives the revision byte for byte, that is the goal, not
  laziness.

## Fourth, the shape of the replacement

The file you apply must be the next file, in full and in order:

- The same filename as before — `~/.caro-anki/instructions/<topic>.md`. Renaming a topic is a separate
  request, and it is a `rename` in the same call rather than a new file written under the new name.
- No frontmatter, one concern, rules addressed to you, scoped where it matters.
- Nothing about how the file was made, no changelog, no `<!-- updated -->` marker, no heading for the
  revision itself. The file states preferences, nothing else.
- No closing summary inside the file. The one-line list of changes belongs in the reply, not in the body.

## Fifth, what to say when you propose the replacement

The draft is the Preview dialog: `propose_instructions` puts a Preview button under your reply, and it opens the
complete file for the user to check the rule text, the wording they gave you, and the filename. So never paste the
body into the message as well, and never let a summary stand in for it.

The proposing turn carries three things and applies nothing:

- One line per change, naming the rule and quoting the line that changes: "`Card style` → `examples`: the range
  drops from three-to-six to two-to-six." If the file is new, say which topic it records.
- The name the file takes or keeps, because a revision never renames it.
- The question that asks for the go-ahead, so one answer from the user is enough.

The turn after that answer applies the same text and reports it saved:

- The name you applied and where it lands: `~/.caro-anki/instructions/<topic>.md`.
- One line on what the apply answered, and that the next message already follows the file — the app re-reads
  the directory on every request, so there is no restart.
- If the last rule in a topic was removed: say that a removal is how the file is retired, and that an empty
  file is skipped rather than read as an empty preference.
