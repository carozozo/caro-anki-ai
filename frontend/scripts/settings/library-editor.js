((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroLibraryEditor = api;
})(globalThis, () => {
  // The library panel: one row picks an entry — an instruction file or a skill folder — and the editor under it
  // writes the one the row has open. It is shown for one kind at a time — the Agent section's `Instructions`
  // and `Skills` labels name the same panel — so the row's own words follow the label that showed it. An entry
  // saves itself as it is typed, so this panel owns the debounce and the chain that keeps one write from
  // outliving the editor it was typed in; the name is the row's own write, and a new entry is a draft this panel
  // holds until it has something in it.
  const createLibraryEditor = ({ $, CaroUI, request, libraryNames }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const { armed: armedConfirm } = CaroUI.confirm;
    const { pickerRow } = CaroUI.fields;
    const { displayLibraryName, normalizeLibraryName, sameLibraryEntry } = libraryNames;

    let libraryEntries = [];
    let libraryKind = 'instructions';
    let libraryTimer = null;
    let libraryRowWriting = false;
    let libraryChain = Promise.resolve();
    // One visit's readers: a load started before the dialog closed must not write into the panel after it.
    let libraryVisit = 0;
    // The entry the editor shows and whether a new one is being named, together: the editor is repainted only
    // when that changes, so a save landing while the user types never writes over the text they typed.
    let libraryShown = '';
    let libraryCreating = false;
    const setLibraryStatus = (text, kind = '') => setSystemMessage($('#librarySettingsStatus'), text, kind);
    const libraryEntry = ({ type, name }) => libraryEntries.find(entry => entry.type === type && entry.name === name);
    const libraryEntriesOfKind = () => libraryEntries.filter(entry => entry.type === libraryKind && !entry.seeded);
    const libraryNouns = { instructions: 'instruction', memories: 'memory', skills: 'skill' };
    const libraryNoun = (type = libraryKind) => libraryNouns[type];
    const libraryPlural = () => ({ instructions: 'Instructions', memories: 'Memories', skills: 'Skills' })[libraryKind];
    const libraryTitle = ({ type, name }) => `${libraryNoun(type).toUpperCase()}: ${displayLibraryName({ type, name })}`;
    const entryKey = entry => (entry ? `${entry.type}\u0000${entry.name}` : '');

    // The row's own list. Its three writes are the three things an entry can be asked for — made, renamed,
    // deleted — and a draft is a name this panel holds until the entry has something in it to write.
    const libraryManager = CaroUI.entityManager({
      list: async () => libraryEntriesOfKind(),
      create: async name => {
        const stored = normalizeLibraryName(libraryKind, name);
        const existing = libraryEntry({ type: libraryKind, name: stored });
        if (existing) throw new Error(`${displayLibraryName(existing)} already exists.`);
        const draft = {
          type: libraryKind, name: stored, draft: true, content: '',
          description: libraryKind === 'skills' ? `New ${stored} skill.` : '',
        };
        libraryEntries.push(draft);
        return draft;
      },
      rename: async (name, next) => {
        const entry = libraryEntry({ type: libraryKind, name });
        const stored = normalizeLibraryName(libraryKind, next);
        const target = libraryEntry({ type: libraryKind, name: stored });
        if (target && target !== entry) throw new Error(`${displayLibraryName(target)} already exists.`);
        // A draft's name is this panel's own until the entry is written, so it moves without a request.
        if (!entry || entry.draft) {
          libraryEntries = libraryEntries.map(item => (item === entry ? { ...item, name: stored } : item));
          return { ...entry, name: stored };
        }
        const answer = await request(`/api/${libraryKind}/${encodeURIComponent(name)}`,
          { method: 'PATCH', body: JSON.stringify({ to: stored }) });
        const renamed = answer[libraryNoun()].to || stored;
        libraryEntries = libraryEntries.map(item => (item === entry ? { ...item, name: renamed } : item));
        return { ...entry, name: renamed };
      },
      remove: async entry => {
        if (!entry.draft) {
          await request(`/api/${libraryKind}/${encodeURIComponent(entry.name)}`, { method: 'DELETE' });
        }
        libraryEntries = libraryEntries.filter(item => item !== entry);
        return entry;
      },
      id: entry => entry.name,
      labelOf: entry => `${displayLibraryName(entry)}${entry.draft ? ' (draft)' : ''}`,
      canRename: entry => Boolean(entry),
      canDelete: entry => Boolean(entry),
    });

    // The editor shows the entry the row has open and nothing while a new one is being named, because a draft
    // does not exist until the row makes it.
    const paintLibraryEditor = mode => {
      const creating = mode === 'create';
      const entry = creating ? null : libraryManager.selected();
      if (entryKey(entry) === libraryShown && creating === libraryCreating) return;
      libraryShown = entryKey(entry);
      libraryCreating = creating;
      $('#libraryEditorForm').prop('hidden', creating);
      $('#libraryEntryType, #libraryEntryName, #libraryEditorDescription, #libraryEditorContent').val('');
      $('#libraryEditorTitle').text('SELECT AN ENTRY');
      $('#libraryDescriptionField').prop('hidden', true);
      if (!entry) return;
      $('#libraryEntryType').val(entry.type);
      $('#libraryEntryName').val(entry.name);
      $('#libraryEditorTitle').text(entry.draft
        ? `NEW ${libraryNoun().toUpperCase()}` : libraryTitle(entry));
      // A skill's description is frontmatter this panel writes when the skill is made, so it is offered for a
      // draft rather than as a field of every skill.
      $('#libraryDescriptionField').prop('hidden', !(entry.type === 'skills' && entry.draft));
      $('#libraryEditorDescription').val(entry.description || '');
      $('#libraryEditorContent').val(entry.content ?? entry.body ?? '');
    };

    // One row is the same row for instructions and skills, so the words it speaks — the select's own label, the
    // two name fields and what the trash would delete — are restated whenever the kind or the open entry
    // changes, and the trash stands down while there is nothing open to delete.
    const renderLibraryWords = () => {
      const noun = libraryNoun();
      const entry = libraryManager.selected();
      const removal = entry
        ? `Delete ${displayLibraryName(entry)}${entry.draft ? ' (draft)' : ''}` : `Delete this ${noun}`;
      $('#librarySelect').attr('aria-label', libraryPlural());
      $('#libraryName').attr('aria-label', `Rename this ${noun}`);
      $('#libraryNewName').attr({ 'aria-label': `New ${noun} name`, placeholder: `New ${noun} name` });
      $('#libraryDelete').attr({ 'aria-label': removal, title: removal }).prop('disabled', !entry);
    };

    const renderLibrary = () => {
      renderLibraryWords();
      paintLibraryEditor(libraryPicker.mode());
      libraryPicker.render();
    };

    // Every write the row makes goes through here, which is what its own buttons inherit: one at a time, with
    // the row standing down while one is in flight. The row's own sentence is what the answer is announced with,
    // and a write that answers a sentence of its own — the body writer does — says that instead. A refusal and a
    // failure both land on the panel's own status line, and a failed write leaves the form open to correct.
    const libraryRowWrite = async (work, success, { onSaved } = {}) => {
      if (libraryRowWriting) return;
      libraryRowWriting = true;
      renderLibrary();
      setLibraryStatus('Saving…', 'pending');
      try {
        const answer = await work();
        setLibraryStatus(success ?? answer, 'ok');
        await onSaved?.();
      } catch (error) {
        setLibraryStatus(error.message, 'error');
      } finally {
        libraryRowWriting = false;
        renderLibrary();
      }
    };

    const libraryPicker = pickerRow({
      manager: libraryManager,
      ids: {
        select: '#librarySelect', rename: '#libraryName', create: '#libraryNewName',
        confirm: '#libraryConfirm', back: '#libraryReturn', remove: '#libraryDelete',
      },
      sentinel: () => `- New ${libraryNoun()} -`,
      entity: libraryNoun,
      article: () => (libraryKind === 'instructions' ? 'an' : 'a'),
      option: {
        value: entry => entry.name,
        label: entry => `${displayLibraryName(entry)}${entry.draft ? ' (draft)' : ''}`,
        name: entry => displayLibraryName(entry),
      },
      isReady: () => !libraryRowWriting,
      run: libraryRowWrite,
      // The body is written before the name it is written under moves, so the row's rename waits for the chain
      // the flush joined: the row hands over the stored name, and this list's own rename takes the name and the
      // one it becomes. The editor is showing the entry whose name just moved, so it is told the new one rather
      // than repainted — a repaint would read the stored body back over whatever was typed since the flush.
      rename: async (name, next) => {
        await flushLibrarySave();
        const entry = await libraryManager.rename(name, next);
        if (libraryShown === entryKey({ type: libraryKind, name })) {
          libraryShown = entryKey(entry);
          $('#libraryEntryName').val(entry.name);
          $('#libraryEditorTitle').text(libraryTitle(entry));
        }
        return entry;
      },
      messages: {
        created: name => `${name} added. It is created as soon as you type.`,
        renamed: (from, name) => `Renamed ${from} to ${name}.`,
      },
      onMode: mode => paintLibraryEditor(mode),
      // Choosing an entry leaves the one that was being written: its body is sent before the editor moves on,
      // because a debounce that outlived its editor would write that entry's body into this one.
      onPick: () => { flushLibrarySave(); setLibraryStatus(''); paintLibraryEditor('pick'); },
    });

    const loadLibrarySettings = async () => {
      const visit = libraryVisit;
      const [{ instructions }, { memories }, { skills }] = await Promise.all([
        request('/api/instructions'), request('/api/memories'), request('/api/skills'),
      ]);
      // A close resets the panel while its own reader is still in flight, and that reader would put the drafts
      // it is here to preserve back into a panel the user has left. It belongs to the visit that started it.
      if (visit !== libraryVisit) return;
      const loaded = [...instructions.map(entry => ({ ...entry, type: 'instructions' })),
        ...memories.map(entry => ({ ...entry, type: 'memories' })),
        ...skills.map(entry => ({ ...entry, type: 'skills' }))];
      libraryEntries = [...loaded, ...libraryEntries.filter(entry => entry.draft
        && !loaded.some(saved => sameLibraryEntry(saved, entry)))];
      await libraryManager.load(libraryManager.selectedId());
      renderLibrary();
    };

    // A library entry saves itself the way a card template does: the body, and the description a skill carries,
    // are written once typing pauses. The writes are a chain because a debounce that outlived its editor would
    // write one entry's body into the next one's, and because a rename has to land after the body that belongs
    // to the name it moves.
    const queueLibraryWrite = work => {
      const next = libraryChain.then(work, work);
      libraryChain = next.catch(() => {});
      return next;
    };

    const writeLibraryContent = async ({ type, name, content, description }) => {
      const entry = libraryEntry({ type, name });
      if (!entry) return;
      const existing = !entry.draft;
      // A body that already reads as the stored one is not a write, which is also what keeps an idle pause
      // quiet; and a new entry is created only once it has something in it.
      const changed = existing
        ? content !== (entry.content ?? entry.body ?? '')
          || (type === 'skills' && description !== (entry.description ?? ''))
        : Boolean(content.trim() || (type === 'skills' && description.trim()));
      if (!changed) return;
      setLibraryStatus('Saving…', 'pending');
      try {
        const payload = type === 'skills' ? { body: content, description, name } : { content, name };
        await request(existing ? `/api/${type}/${encodeURIComponent(name)}` : `/api/${type}`,
          { method: existing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        await loadLibrarySettings();
        // The title was painted while the entry was still a draft, and it is a file now.
        if (libraryShown === entryKey({ type, name })) $('#libraryEditorTitle').text(libraryTitle({ type, name }));
        setLibraryStatus('Saved.', 'ok');
      } catch (error) {
        setLibraryStatus(error.message, 'error');
      }
    };

    // The fields are read before the write is queued: closing the dialog flushes and then resets, so the queue
    // can run after the editor has been emptied, and the entry that was being typed in is the one this is for.
    const saveLibraryEntry = () => {
      const type = $('#libraryEntryType').val();
      const name = $('#libraryEntryName').val();
      if (!type || !name) return Promise.resolve();
      const snapshot = {
        type, name, content: $('#libraryEditorContent').val(), description: $('#libraryEditorDescription').val(),
      };
      return queueLibraryWrite(() => writeLibraryContent(snapshot));
    };

    // A write still waiting on its idle is sent now, and the chain it joined is what a rename waits for.
    const flushLibrarySave = () => {
      if (libraryTimer !== null) {
        clearTimeout(libraryTimer);
        libraryTimer = null;
        saveLibraryEntry();
      }
      return libraryChain;
    };

    const scheduleLibrarySave = () => {
      clearTimeout(libraryTimer);
      libraryTimer = setTimeout(() => { libraryTimer = null; saveLibraryEntry(); }, 500);
    };

    $('#libraryEditorContent').on('input', scheduleLibrarySave);
    $('#libraryEditorDescription').on('change', () => saveLibraryEntry());
    $('#libraryName').on('input', () => setLibraryStatus(''));

    // The confirmation is armed against the entry the row has open, and the key is read again when the second
    // press lands: a selection that moved under the confirmation re-arms instead of destroying the new one.
    const deleteLibraryEntryConfirm = armedConfirm(async $button => {
      const entry = libraryManager.selected();
      if (!entry) return;
      $button.prop('disabled', true);
      setLibraryStatus('Deleting…', 'pending');
      try {
        await libraryManager.remove(entry);
        renderLibrary();
        setLibraryStatus(entry.draft ? 'Draft discarded.' : 'Deleted.', 'ok');
      } catch (error) {
        setLibraryStatus(error.message, 'error');
        $button.prop('disabled', false);
      }
    }, { lock: () => String(libraryManager.selectedId() ?? '') });

    $('#libraryDelete').on('click', event => {
      const entry = libraryManager.selected();
      if (!entry || libraryRowWriting) return;
      // A write still waiting on its idle is dropped rather than flushed: the entry it would land in is the one
      // being deleted, and a body written back into it would put it there again.
      clearTimeout(libraryTimer);
      libraryTimer = null;
      deleteLibraryEntryConfirm.handle(event, `Click again to delete ${displayLibraryName(entry)}`);
    });

    return {
      load: loadLibrarySettings,
      flush: flushLibrarySave,
      // The strip that names this panel is also what tells it which catalogue to paint, and the two catalogues
      // are different lists: the write still waiting on its idle lands first, and the row is put on the first
      // entry of the one now showing rather than on a name the other kind owns.
      render: kind => {
        if (!kind || kind === libraryKind) { renderLibrary(); return; }
        flushLibrarySave();
        libraryKind = kind;
        libraryManager.select(null);
        libraryManager.load().then(() => renderLibrary());
      },
      // Closing the dialog drops the drafts a visit left behind: they were never written, so they are not
      // entries, and the editor goes back to showing nothing until a label shows the panel again.
      reset: () => {
        libraryVisit += 1;
        libraryEntries = libraryEntries.filter(entry => !entry.draft);
        libraryManager.select(null);
        libraryShown = '';
        libraryCreating = false;
        libraryManager.load().then(() => renderLibrary());
      },
      setPanelStatus: setLibraryStatus,
    };
  };

  return { createLibraryEditor };
});
