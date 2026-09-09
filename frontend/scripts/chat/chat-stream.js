((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatStream = api;
})(globalThis, () => {
  const STEP_LABELS = {
    search_notes: 'Search notes',
    read_notes: 'Read notes',
    list_tags: 'List tags',
    create_notes: 'Create notes',
    update_notes: 'Edit notes',
    delete_notes: 'Delete notes',
    list_decks: 'List decks',
    read_card_profiles: 'Read card profiles',
    propose_card_profile: 'Propose card profile',
    apply_card_profile: 'Apply card profile',
    update_memory: 'Update memory',
    load_skill: 'Load skill',
    propose_instructions: 'Propose instruction',
    apply_instructions: 'Apply instruction',
    propose_skills: 'Propose skill',
    apply_skills: 'Apply skill',
  };
  // A step recorded before the tool names were namespaced still shows the label and the detail of the tool it
  // was, so an old conversation reads exactly like a new one.
  const LEGACY_NAMES = {
    search: 'search_notes', read: 'read_notes', create: 'create_notes', update: 'update_notes',
    delete: 'delete_notes', decks: 'list_decks', skills: 'load_skill',
    read_card_profile: 'read_card_profiles',
    read_note: 'read_notes', update_note: 'update_notes', delete_note: 'delete_notes',
  };
  const toolName = name => LEGACY_NAMES[name] || name;
  const STEP_STATUSES = { pending: 'Running…', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' };
  const TERMINAL_STATUSES = ['completed', 'failed'];
  const isTerminal = record => TERMINAL_STATUSES.includes(record?.status);
  const count = (total, singular, plural) => `${total} ${total === 1 ? singular : plural}`;
  const formatElapsed = ms => `${Math.round(ms / 1000)}s`;
  const elapsedBetween = (from, to) => {
    const elapsed = Date.parse(to) - Date.parse(from);
    return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
  };
  // One entry per thing the library can be asked to do, so a write, a rename and a removal are told apart
  // where a run's proposals are collected. A skill has no operation — writing one writes the folder — and
  // reads as a write.
  const proposalKey = ({ kind, op, name }) => `${kind}:${op || 'write'}:${name}`;
  // What one proposal asks for, counted by verb: the three groups the call carries, so a rename or a removal
  // is as readable while it runs as a file write is. A profile library is written one entry per note type, so
  // the group a profile call carries is `profiles` and its entries are counted in their own noun.
  const proposalParts = (args, group = 'files', [one, many] = ['file', 'files']) =>
    [[(args[group] || []).length, one, many],
      [(args.renames || []).length, 'rename', 'renames'],
      [(args.removals || []).length, 'removal', 'removals']]
    .filter(([total]) => total > 0)
    .map(([total, singular, plural]) => count(total, singular, plural));

  // Reads the newline-delimited JSON events of a streaming chat response and hands each parsed event to
  // `onEvent` the moment it arrives. A transport chunk can split a line, so the unfinished tail stays
  // buffered until the next chunk (or the end of the body) completes it.
  const readEvents = async (response, onEvent) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flush = line => { if (line.trim()) onEvent(JSON.parse(line)); };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(flush);
    }
    flush(buffer);
  };

  // The agent persists one record per transition — a `pending` row, then the completed/failed result of
  // that same call — and the live stream merges the pair into one. The pending row is dropped, but the gap
  // between the two timestamps is kept as the surviving row's duration, which the raw record shows. A
  // pending row that never got a result (the run died mid-call) survives, relabelled so it cannot look
  // like it is still running.
  const collapseToolSteps = messages => {
    const durations = new Map();
    const steps = [];
    messages.forEach((message, index) => {
      if (durations.has(index)) {
        steps.push({ ...message, durationMs: durations.get(index) });
        return;
      }
      if (message.role !== 'tool') {
        steps.push(message);
        return;
      }
      const record = JSON.parse(message.content);
      const next = messages[index + 1];
      const terminal = next?.role === 'tool' ? JSON.parse(next.content) : null;
      const pairs = record.status === 'pending' && isTerminal(terminal)
        && terminal.action?.name === record.action?.name;
      if (pairs) {
        durations.set(index + 1, elapsedBetween(message.created_at, next.created_at));
        return;
      }
      steps.push(record.status === 'pending'
        ? { ...message, content: JSON.stringify({ ...record, status: 'interrupted' }) } : message);
    });
    return steps;
  };

  const stepTitle = ({ action, status }) => {
    const name = STEP_LABELS[toolName(action?.name)] || action?.name || 'Anki';
    return `${name} · ${STEP_STATUSES[status] || status}`;
  };

  // The raw record behind a step, for the case where a step needs investigating after the fact. Every
  // field the server persisted is here, including the duration derived from the two timestamps.
  const operationJson = (operation, message = {}) => JSON.stringify({
    status: operation.status,
    action: operation.action,
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.result === undefined ? {} : { result: operation.result }),
    ...(message.created_at ? { recordedAt: message.created_at } : {}),
    ...(Number.isFinite(message.durationMs) ? { durationMs: message.durationMs } : {}),
  }, null, 2);

  // What is left to show while a call is still running: the request it is making, not its result.
  const pendingDetail = ({ name, args }, termFor) => {
    if (name === 'search_notes') return `Query: ${args.query || '(all notes)'}`;
    if (name === 'list_tags') return 'Reading collection tags…';
    if (name === 'list_decks') return 'Reading Anki decks…';
    if (name === 'update_memory') {
      const changes = (args.additions || []).length + (args.updates || []).length + (args.removals || []).length;
      return changes ? `Updating ${count(changes, 'memory', 'memories')}…` : 'Updating memory…';
    }
    if (name === 'read_card_profiles') {
      const names = (Array.isArray(args.noteTypes) ? args.noteTypes : [args.noteTypes]).filter(Boolean);
      if (!names.length) return 'Reading card profiles…';
      return `Reading ${names.length === 1 ? `the ${names[0]} profile` : names.join(', ')}…`;
    }
    if (name === 'load_skill') return args.name ? `Loading skill ${args.name}…` : 'Listing skills…';
    if (name === 'propose_instructions') {
      const parts = proposalParts(args);
      return parts.length ? `Proposing ${parts.join(', ')}…` : 'Proposing an instruction change…';
    }
    if (name === 'apply_instructions') {
      const parts = proposalParts(args);
      return parts.length ? `Applying ${parts.join(', ')}…` : 'Applying an instruction change…';
    }
    if (name === 'propose_card_profile' || name === 'apply_card_profile') {
      const verb = name === 'propose_card_profile' ? 'Proposing' : 'Applying';
      const parts = proposalParts(args, 'profiles', ['profile', 'profiles']);
      return parts.length ? `${verb} ${parts.join(', ')}…` : `${verb} a card profile change…`;
    }
    // A skill call names either a folder to write or a rename and a removal to make, so the pending line
    // counts whichever the call carries — a folder is named, a rename and a removal are counted.
    if (name === 'propose_skills' || name === 'apply_skills') {
      const verb = name === 'propose_skills' ? 'Proposing' : 'Applying';
      const folders = proposalParts({ renames: args.renames, removals: args.removals });
      const target = [args.name ? `the skill ${args.name}` : '', ...folders].filter(Boolean).join(' and ');
      return `${verb} ${target || 'a skill change'}…`;
    }
    if (name === 'create_notes') return `Creating ${count((args.cards || []).length, 'note', 'notes')}…`;
    // A batch names either its list of ids or, in a conversation recorded before the tools took batches, the
    // one id it was called with — and the single-note line is kept exactly as it read then.
    if (name === 'read_notes') {
      return Array.isArray(args.ids) ? `Reading ${count(args.ids.length, 'note', 'notes')}…` : `Reading ${termFor(args.id)}…`;
    }
    if (name === 'update_notes') {
      return Array.isArray(args.notes) ? `Editing ${count(args.notes.length, 'note', 'notes')}…`
        : `Editing ${termFor(args.id)}: ${Object.keys(args.fields || {}).join(', ')}`;
    }
    if (name === 'delete_notes') {
      return Array.isArray(args.ids) ? `Deleting ${count(args.ids.length, 'note', 'notes')}…` : `Deleting ${termFor(args.id)}…`;
    }
    return '';
  };

  const stepDetail = ({ action, status, result, error }, termFor = id => `note ${id}`) => {
    if (error) return error;
    const args = action?.args || {};
    const name = toolName(action?.name);
    if (status === 'interrupted') return 'Interrupted: the run ended before this step reported a result.';
    if (status !== 'completed' || !result) return pendingDetail({ name, args }, termFor);
    if (name === 'search_notes') {
      return `Query: ${result.query || '(all notes)'} — ${count(result.total, 'match', 'matches')}`
        + `${result.hasMore ? ', more available' : ''}`;
    }
    if (name === 'list_decks') {
      return `Current deck: ${result.currentDeck} · ${count((result.decks || []).length, 'deck', 'decks')}`;
    }
    if (name === 'list_tags') return count((result.tags || []).length, 'tag', 'tags');
    // A profile call either describes the note types it named — the answer an audit works from — or answers a
    // name it could not resolve with the installed list, which is the model's mistake to correct in the same
    // turn. One line per note type, because one call can carry several; naming none lists what is installed.
    if (name === 'read_card_profiles') {
      const profiles = result.profiles || [];
      const perProfile = entry => {
        if (entry.error) {
          return `${entry.error} — ${count((entry.noteTypes || []).length, 'profile', 'profiles')} installed`;
        }
        const fields = entry.fields || [];
        return `${entry.noteType}: ${count(fields.length, 'field', 'fields')}`
          + `, ${fields.filter(field => field.required).length} required, ${(entry.storage || []).length} stored in Anki`;
      };
      if (!profiles.length) return `${count((result.noteTypes || []).length, 'profile', 'profiles')} installed`;
      return profiles.map(perProfile).join('\n');
    }
    // A skill call either lists the library, loads one skill's instructions, or answers a name it could
    // not resolve with that same list — which is the model's mistake to correct, not a failed step.
    if (name === 'load_skill') {
      if (result.error) return `${result.error} — the library was listed instead`;
      if (!result.name) return `${count((result.skills || []).length, 'skill', 'skills')} installed`;
      return `Loaded ${result.name}${result.file ? ` · references/${result.file}` : ''}`;
    }
    // What the proposal would do to each file, which is the change the user is being asked to agree to — the
    // agent writes nothing until it is applied. A change the library refused is shown as the sentence it
    // refused with; the model corrects it in the same turn, so there is nothing here for the user to act on.
    if (name === 'propose_instructions') {
      if (result.error) return `${result.error} — nothing was proposed`;
      const written = (result.files || []).map(file =>
        `${file.name} · ${file.exists ? 'replaces an existing file' : 'new file'} · ${file.bytes} bytes`);
      const renamed = (result.renames || []).map(entry =>
        `${entry.name} → ${entry.to} · renamed · ${entry.bytes} bytes`);
      const removed = (result.removals || []).map(entry =>
        `${entry.name} · removes the file · ${entry.bytes} bytes`);
      return [...written, ...renamed, ...removed].join('\n');
    }
    if (name === 'update_memory') {
      if (result.error) return `${result.error} — memory unchanged`;
      const additions = (result.additions || []).map(({ content }) => `Remembered: ${content}`);
      const updates = (result.updates || []).map(({ before, content }) => `Updated: ${before} → ${content}`);
      const removals = (result.removals || []).map(({ content }) => `Forgot: ${content}`);
      return [...additions, ...updates, ...removals].join('\n');
    }
    // What the write really did, file by file and named from the library's own answer, including the copy of
    // every text it replaced so the change is visibly reversible.
    if (name === 'apply_instructions') {
      if (result.error) {
        const landed = [...(result.files || []), ...(result.renames || []), ...(result.removals || [])];
        return `${result.error} — ${landed.length ? 'the changes above are written' : 'nothing was written'}`;
      }
      const written = (result.files || []).map(file =>
        `${file.name} · ${file.created ? 'new file' : `replaced, kept at ${file.backup}`} · ${file.bytes} bytes`);
      const renamed = (result.renames || []).map(entry => `${entry.name} → ${entry.to} · renamed`);
      const removed = (result.removals || []).map(entry => `${entry.name} · retired, kept at ${entry.backup}`);
      return [...written, ...renamed, ...removed].join('\n');
    }
    // A profile call is one note type per entry, and an entry carries either the whole profile or one edit of
    // it: the step says which note type it is and what an edit would touch, because that is the change the
    // user is being asked to agree to.
    if (name === 'propose_card_profile') {
      if (result.error) return `${result.error} — nothing was proposed`;
      const written = (result.profiles || []).map(entry => `${entry.name} · ${entry.changes
        ? `${entry.changes.join(', ')} · ${entry.bytes} bytes`
        : `${entry.exists ? 'replaces an existing profile' : 'new profile'} · ${entry.bytes} bytes`}`);
      const renamed = (result.renames || []).map(entry =>
        `${entry.noteType} → ${entry.renamed} · renamed with its note type`);
      const removed = (result.removals || []).map(entry =>
        `${entry.name} · retires the ${entry.noteType} profile · ${entry.bytes} bytes`);
      return [...written, ...renamed, ...removed].join('\n');
    }
    if (name === 'apply_card_profile') {
      if (result.error) {
        const landed = [...(result.profiles || []), ...(result.renames || []), ...(result.removals || [])];
        return `${result.error} — ${landed.length ? 'the changes above are written' : 'nothing was written'}`;
      }
      const written = (result.profiles || []).map(entry => `${entry.name} · ${entry.created
        ? 'new profile' : `replaced, kept at ${entry.backup}`}${entry.changes ? ` · ${entry.changes.join(', ')}` : ''}`);
      const renamed = (result.renames || []).map(entry =>
        `${entry.name} → ${entry.to} · renamed, kept at ${entry.backup}`);
      const removed = (result.removals || []).map(entry =>
        `${entry.name} · retired, kept at ${entry.backup}`);
      return [...written, ...renamed, ...removed].join('\n');
    }
    // A skill is a folder, so the step names it once and lists the files it would arrive with — and a folder
    // that only moves or leaves is named the same way, one line per skill rather than one per file.
    if (name === 'propose_skills') {
      if (result.error) return `${result.error} — nothing was proposed`;
      const files = (result.files || []).map(file =>
        `${file.path} · ${file.exists ? 'replaced' : 'new'} · ${file.bytes} bytes`).join('\n');
      return [result.skill
        ? `Skill ${result.skill}${result.created ? ' (new)' : ' (replaces the installed one)'}\n${files}` : '',
      ...(result.renames || []).map(entry => `Skill ${entry.name} → ${entry.to} · renamed`),
      ...(result.removals || []).map(entry => `Skill ${entry.name} · retires the folder · ${entry.bytes} bytes`)]
        .filter(Boolean).join('\n');
    }
    if (name === 'apply_skills') {
      if (result.error) {
        const landed = [...(result.files || []), ...(result.renames || []), ...(result.removals || [])];
        return `${result.error} — ${landed.length ? 'the changes above are written' : 'nothing was written'}`;
      }
      const files = (result.files || []).map(file =>
        `${file.path} · ${file.created ? 'new' : `replaced, kept at ${file.backup}`} · ${file.bytes} bytes`)
        .join('\n');
      return [result.skill
        ? `Skill ${result.skill}${result.created ? ' (new)' : ' (replaces the installed one)'}\n${files}` : '',
      ...(result.renames || []).map(entry => `Skill ${entry.name} → ${entry.to} · renamed, kept at ${entry.backup}`),
      ...(result.removals || []).map(entry => `Skill ${entry.name} · retired, kept at ${entry.backup}`)]
        .filter(Boolean).join('\n');
    }
    if (name === 'read_notes') {
      // One line per note, because one call can carry a whole batch; a note that could not be found is shown as
      // the sentence it was answered with rather than as a read.
      const notes = Array.isArray(result.notes) ? result.notes : [result];
      return notes.map(note => note.error ? `${termFor(note.noteId)}: ${note.error}` : `Read ${termFor(note.noteId)}`)
        .join('\n');
    }
    if (name === 'create_notes') {
      const created = (result.noteIds || []).filter(Boolean).length;
      // Each card names its own note type and deck, so one call can write several of each. A record stored
      // before that carries the single deck the call used, so both shapes are read and a mixed batch still
      // says exactly what it wrote.
      const noteTypes = result.noteTypes || [];
      const decks = result.decks || (result.deck ? [result.deck] : []);
      return [
        ...(noteTypes.length > 1 ? [`Note types: ${noteTypes.join(', ')}`] : []),
        ...(decks.length ? [`Deck: ${decks.join(', ')}`] : []),
        `Created ${count(created, 'note', 'notes')}${result.rejected ? `, rejected ${result.rejected}` : ''}`,
      ].join(' · ');
    }
    if (name === 'update_notes') {
      // The fields come from the call and the old values from the answer, joined per note: a batch is one line
      // per note, and a call recorded before the tool took a batch is the single entry it was, so it still
      // reads as the bare field list it did then.
      const requested = Array.isArray(args.notes) ? args.notes : [{ id: args.id, fields: args.fields }];
      const answered = new Map((Array.isArray(result.notes) ? result.notes : [result])
        .map(entry => [Number(entry.id), entry.before]));
      const changes = ({ id, fields }) => Object.entries(fields || {}).map(([field, value]) => {
        const before = answered.get(Number(id))?.fields?.[field]?.value ?? '(empty)';
        return `${field}: ${before} → ${value}`;
      });
      if (requested.length === 1) return changes(requested[0]).join('\n');
      return requested.map(entry => [termFor(entry.id), ...changes(entry)].join('\n')).join('\n');
    }
    if (name === 'delete_notes') {
      const ids = Array.isArray(result.notes) ? result.notes.map(entry => entry.id) : [args.id ?? result.id];
      return ids.length === 1 ? `Deleted ${termFor(ids[0])}` : `Deleted ${count(ids.length, 'note', 'notes')}`;
    }
    return '';
  };

  // What a run proposed, one entry per thing it named: an instruction file with the operation that touches it,
  // a skill's whole folder — the body and every reference travel together, because a folder that arrives one
  // file at a time is briefly a body naming a reference it does not have — or one card profile per note type.
  // The entries are what the app
  // draws under the reply that asked for them and what the agent later applies; what they carry is the call's
  // own args, paired with the result so only what the library agreed to is shown. A thing proposed more than
  // once is shown once, the last winning, because the later call is the correction of the earlier one; a
  // proposal the library refused contributes nothing, since its result carries no files at all.
  const proposedPreviews = operations => {
    const previews = new Map();
    for (const { action, status, result } of operations) {
      if (status !== 'completed') continue;
      const tool = toolName(action?.name);
      const args = action?.args || {};
      if (tool === 'propose_instructions') {
        const bodies = new Map((args.files || []).map(file => [String(file.name), String(file.content ?? '')]));
        for (const file of result?.files || []) {
          const name = String(file.name);
          if (bodies.has(name)) {
            previews.set(proposalKey({ kind: 'instruction', op: 'write', name }),
              { kind: 'instruction', op: 'write', name, content: bodies.get(name) });
          }
        }
        // A rename is paired by the file it names, and carries the library's own target rather than the one
        // the call spelled, so the entry can only describe a move the library already agreed to make.
        const targets = new Map((args.renames || [])
          .map(entry => [String(entry?.name), String(entry?.to ?? '')]));
        for (const entry of result?.renames || []) {
          const name = String(entry.name);
          if (targets.get(name)) {
            previews.set(proposalKey({ kind: 'instruction', op: 'rename', name }),
              { kind: 'instruction', op: 'rename', name, to: entry.to });
          }
        }
        const named = new Set((args.removals || []).map(String));
        for (const entry of result?.removals || []) {
          const name = String(entry.name);
          if (named.has(name)) {
            previews.set(proposalKey({ kind: 'instruction', op: 'remove', name }),
              { kind: 'instruction', op: 'remove', name });
          }
        }
      } else if (tool === 'propose_card_profile') {
        // A profile is shown from the library's own answer rather than from the call's arguments, because an
        // edit names no file at all: the only text that can be drawn is the file the library said it would
        // write — checked, merged and normalized — and every entry in this result already came from it.
        for (const entry of result?.profiles || []) {
          const name = String(entry.name);
          if (!entry.content) continue;
          previews.set(proposalKey({ kind: 'profile', op: 'write', name }),
            { kind: 'profile', op: 'write', name, content: String(entry.content) });
        }
        // A renamed profile and a retired one have no text of their own to show, so they name the change by
        // the note type rather than by the file, which is what the user knows them by.
        for (const entry of result?.renames || []) {
          previews.set(proposalKey({ kind: 'profile', op: 'rename', name: entry.noteType }),
            { kind: 'profile', op: 'rename', name: entry.noteType, to: entry.renamed });
        }
        for (const entry of result?.removals || []) {
          previews.set(proposalKey({ kind: 'profile', op: 'remove', name: entry.noteType }),
            { kind: 'profile', op: 'remove', name: entry.noteType });
        }
      } else if (tool === 'propose_skills') {
        const bodies = new Map((args.files || []).map(file => [String(file.path), String(file.content ?? '')]));
        const name = result?.skill ? String(result.skill) : '';
        const files = (result?.files || [])
          .map(file => ({ path: String(file.path) }))
          .filter(file => bodies.has(file.path))
          .map(file => ({ ...file, content: bodies.get(file.path) }));
        if (name && files.length) {
          previews.set(proposalKey({ kind: 'skill', op: 'write', name }),
            { kind: 'skill', op: 'write', name, files });
        }
        // A renamed folder and a retired one have no text of their own to show, so they name the change — the
        // same three operations an instruction file is shown with, keyed by the folder rather than a file.
        const targets = new Map((args.renames || []).map(entry => [String(entry?.name), String(entry?.to ?? '')]));
        for (const entry of result?.renames || []) {
          const from = String(entry.name);
          if (targets.get(from)) {
            previews.set(proposalKey({ kind: 'skill', op: 'rename', name: from }),
              { kind: 'skill', op: 'rename', name: from, to: entry.to });
          }
        }
        const named = new Set((args.removals || []).map(String));
        for (const entry of result?.removals || []) {
          const folder = String(entry.name);
          if (named.has(folder)) {
            previews.set(proposalKey({ kind: 'skill', op: 'remove', name: folder }),
              { kind: 'skill', op: 'remove', name: folder });
          }
        }
      }
    }
    return [...previews.values()];
  };

  // A persisted conversation is one list of messages, and the proposal a reply owns belongs to that reply
  // rather than to the step that made it: a step is persisted before the answer it led to, so the files a run
  // proposed are held back until the assistant message that closes it and come after it in the parts this
  // returns. A run that never replied — it was interrupted mid-call — still shows its preview, at the end
  // where its answer would have been. A part is either `{ message }` or `{ previews }`, in render order.
  const conversationParts = messages => {
    const parts = [];
    let operations = [];
    const flush = () => {
      const previews = proposedPreviews(operations);
      operations = [];
      if (previews.length) parts.push({ previews });
    };
    for (const message of messages) {
      if (message.role === 'tool') operations.push(JSON.parse(message.content));
      parts.push({ message });
      if (message.role === 'assistant') flush();
    }
    flush();
    return parts;
  };

  // One run is one window: every consecutive run of tool records folds into a single part, so the parts keep
  // the order they are read in and a streamed step and a persisted one are laid out by the same rule. The
  // window itself is the app's to render — this only says which records belong to it.
  // A stopped run's steps are indistinguishable from a completed run's (every one of them ran to its end), so
  // the window is marked by the reply that closes it: the assistant message's own payload is where the run
  // says the user stopped it. The previews a proposal left in between belong to that reply, not to a new run.
  const stoppedAfter = (parts, index) => {
    for (let next = index + 1; next < parts.length; next++) {
      const message = parts[next].message;
      if (!message) continue;
      if (message.role !== 'assistant') return false;
      return JSON.parse(message.payload_json || 'null')?.cancelled === true;
    }
    return false;
  };
  const groupSteps = parts => parts.reduce((list, part, index) => {
    if (part.message?.role !== 'tool') return [...list, part];
    const previous = list[list.length - 1];
    return previous?.steps
      ? [...list.slice(0, -1), { ...previous, steps: [...previous.steps, part.message] }]
      : [...list, { steps: [part.message], stopped: stoppedAfter(parts, index) }];
  }, []);

  return { collapseToolSteps, conversationParts, formatElapsed, groupSteps, operationJson, proposedPreviews,
    readEvents, stepDetail, stepTitle };
});
