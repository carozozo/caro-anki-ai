((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteEditor = api;
})(globalThis, () => {
  const createNoteEditor = ({
    $, $editor, $list, request, CardDocument, NoteSelection, NoteShortcuts,
    autoGrow, chipButton, icon, optionsHtml, escapeAttr, escapeHtml, plainText,
    activeNote, noteIndexOf, rememberSelection, notes, fetchNote, noteFields, notePreview,
    rebuildNoteIndex, trackLoadedNote, clearLoadedPages, bumpNoteTotal,
    applySelection, renderSelection, renderBrowserList, renderBrowserRow, renderSelectedCount,
    loadVisibleNotePages, renderVisibleRows, setBrowserStatus, setNoteListStatus,
    isBusy, setBusy, isEditorOpen, setEditorOpen, editorBase, setEditorBase,
    setDraftNote, getActiveId, setActiveId, getModelChoices, setModelChoices, refreshQuickSearchTags,
    refreshUndoStatus,
  }) => {
    // The preview is a sandboxed rendering; the textarea stays the source of truth for
    // collectEditorFields / saveActiveNote.
    const RICH_MODE_ICONS = { preview: 'eye', html: 'code' };
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    let richFieldName = '';
    const rememberRichField = $field => {
      const name = $field.find('.anki-note-input').data('field-name');
      if (name) richFieldName = name;
      return name;
    };
    const clearOtherRichFocus = $field =>
      $editor.find('.anki-rich-field.is-focused').not($field).removeClass('is-focused');
    const resizeRichView = frame => {
      const body = frame.contentDocument?.body;
      if (!body) return;
      frame.style.height = `${Math.max(34, body.scrollHeight + 2)}px`;
    };
    const serializeRichBody = body => {
      const clone = body.cloneNode(true);
      if (clone.lastChild?.nodeName === 'BR') clone.lastChild.remove();
      return clone.innerHTML;
    };
    const caretAtEnd = body => {
      const range = body.ownerDocument.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      const selection = body.ownerDocument.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const focusRichBody = ($field, body, { caretAtEnd: placeCaret = false } = {}) => {
      body.focus();
      const selection = body.ownerDocument.getSelection();
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      if (placeCaret || !range || !body.contains(range.commonAncestorContainer)) caretAtEnd(body);
      rememberRichField($field);
      clearOtherRichFocus($field);
      $field.addClass('is-focused');
    };
    const richViewState = new WeakMap();
    const syncRichView = ($field, { focus = false, caretAtEnd = false } = {}) => {
      const frame = $field.find('.anki-rich-view')[0];
      if (!frame) return;
      const value = $field.find('.anki-note-input').val();
      const field = editorField($field.find('.anki-note-input').data('field-name'));
      const body = frame.contentDocument?.body;
      const rendered = richViewState.get(frame);
      // An unmarked body is still the frame's placeholder document: replace it, never write into it.
      if (!body?.dataset.bound || rendered?.loading || rendered?.styling !== editorModel.styling
        || rendered?.field !== field) {
        const next = { styling: editorModel.styling, field, value, loading: true };
        frame.onload = () => {
          bindRichView(frame);
          richViewState.set(frame, { ...next, loading: false });
          if (focus) focusRichBody($field, frame.contentDocument.body, { caretAtEnd });
        };
        frame.srcdoc = CardDocument.editorDocument({ html: value, styling: editorModel.styling, field });
        richViewState.set(frame, next);
        return;
      }
      if (rendered.value !== value) {
        body.innerHTML = CardDocument.richFieldMarkup(value);
        richViewState.set(frame, { ...rendered, value });
      }
      resizeRichView(frame);
      if (focus) focusRichBody($field, body, { caretAtEnd });
    };
    const bindRichView = frame => {
      const document = frame.contentDocument;
      const body = document?.body;
      if (!body || body.dataset.bound === 'true') return;
      body.dataset.bound = 'true';
      body.contentEditable = 'true';
      body.spellcheck = false;
      const $field = $(frame).closest('.anki-rich-field');
      const syncInput = () => {
        const markup = serializeRichBody(body);
        $field.find('.anki-note-input').val(markup);
        richViewState.set(frame, { ...richViewState.get(frame), value: markup });
        resizeRichView(frame);
      };
      body.addEventListener('input', syncInput);
      // A frame's inner focus never reaches this page's :focus-within, so the field states it.
      body.addEventListener('focus', () => {
        rememberRichField($field);
        clearOtherRichFocus($field);
        $field.addClass('is-focused');
      });
      // The field's value is settled the moment its own focus is done with it, so a blur is what commits it —
      // not a timer and not every keystroke. `saveActiveNote` already no-ops when nothing actually changed.
      body.addEventListener('blur', () => {
        $field.removeClass('is-focused');
        saveActiveNote({ silent: true });
      });
      body.addEventListener('keydown', event => {
        const primary = event.metaKey || event.ctrlKey;
        const key = event.key.toLowerCase();
        if (primary && !event.altKey && !event.shiftKey && key === 'b') {
          event.preventDefault();
          document.execCommand('styleWithCSS', false, false);
          document.execCommand('bold');
          syncInput();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          document.execCommand('insertLineBreak');
          return;
        }
        // The page owns these shortcuts, but a key pressed in the frame never reaches its document.
        // Native text commands stay inside the field.
        const unshifted = primary && !event.shiftKey && !event.altKey;
        const rawHtmlToggle = NoteShortcuts.matches(event, NoteShortcuts.find('toggle-html'));
        const saveShortcut = NoteShortcuts.matches(event, NoteShortcuts.find('save-note'));
        if (unshifted && ['a', 'c', 'v', 'x', 'z', 'backspace'].includes(key)) return;
        const pageShortcut = NoteShortcuts.definitions.some(item => (item.scope === 'app'
          || (item.scope === 'browser' && item.selector)) && NoteShortcuts.matches(event, item));
        if (!rawHtmlToggle && !saveShortcut && event.key !== 'Escape'
          && !pageShortcut) return;
        const pageWindow = frame.ownerDocument.defaultView;
        const handled = !frame.ownerDocument.dispatchEvent(new pageWindow.KeyboardEvent('keydown', {
          key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true,
        }));
        if (handled) event.preventDefault();
      });
      body.addEventListener('copy', event => {
        const selection = document.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (!body.contains(range.commonAncestorContainer)) return;
        const wrapper = document.createElement('div');
        wrapper.append(range.cloneContents());
        event.clipboardData.setData('text/html', wrapper.innerHTML);
        event.clipboardData.setData('text/plain', selection.toString());
        event.preventDefault();
      });
      body.addEventListener('cut', event => {
        const selection = document.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (!body.contains(range.commonAncestorContainer)) return;
        const wrapper = document.createElement('div');
        wrapper.append(range.cloneContents());
        event.clipboardData.setData('text/html', wrapper.innerHTML);
        event.clipboardData.setData('text/plain', selection.toString());
        event.preventDefault();
        range.deleteContents();
        selection.removeAllRanges();
        selection.addRange(range);
        syncInput();
      });
      body.addEventListener('paste', event => {
        event.preventDefault();
        const clipboard = event.clipboardData;
        const html = clipboard?.getData('text/html');
        const content = html
          ? CardDocument.richFieldHtml(html)
          : escapeHtml(clipboard?.getData('text/plain') || '').replace(/\r?\n/g, '<br>');
        document.execCommand('insertHTML', false, content);
        syncInput();
      });
      resizeRichView(frame);
    };
    // A note type owns both the styling its cards render in and the settings of its fields, and one read answers
    // both. It is taken whenever the editor loads a note rather than cached, because a setting the user just
    // changed in Note Type Studio has to be in effect on the next note they open.
    let editorModel = { styling: '', fields: [] };
    const fieldCollapseStates = new Map();
    const richFieldModes = new Map();
    let fieldSettingsOpen = '';
    const loadEditorModel = async modelName => {
      editorModel = { styling: '', fields: [] };
      fieldCollapseStates.clear();
      fieldSettingsOpen = '';
      if (!modelName) return;
      try {
        const { model } = await request(`/api/anki/models/${encodeURIComponent(modelName)}?select=fields,styling`);
        editorModel = { styling: model.styling || '', fields: model.fields || [] };
      } catch {
        editorModel = { styling: '', fields: [] };
      }
    };
    // A field the note type no longer names has no settings, and one shared object keeps that answer stable: the
    // preview compares the settings it rendered with to decide whether its document is still the right one.
    const NO_FIELD_SETTINGS = {};
    const editorField = name => editorModel.fields.find(field => field.name === name) || NO_FIELD_SETTINGS;
    const richFieldModeKey = name => `${activeNote()?.modelName || ''}\u0000${name}`;
    const richFieldMode = name => richFieldModes.get(richFieldModeKey(name))
      ?? Boolean(editorField(name).htmlEditor);
    // The raw-HTML textarea states the field's own font and size itself, because a style attribute outranks the kit's
    // field font. The preview keeps them in the field's document instead.
    const fieldFont = ({ font, size } = {}) => {
      const rule = [font && `font-family: ${font}`, Number(size) > 0 && `font-size: ${Number(size)}px`]
        .filter(Boolean).join('; ');
      return rule ? ` style="${escapeAttr(rule)}"` : '';
    };
    // Anki's sticky fields keep what was typed in them when the next note of the same note type is started, so the
    // values are remembered for this session, keyed by note type and field.
    const stickyValues = new Map();
    const stickyKey = (modelName, fieldName) => `${modelName}\u0000${fieldName}`;
    const withStickyValues = note => ({
      ...note,
      fields: note.fields.map(field => ({
        ...field,
        value: editorField(field.name).sticky
          ? field.value || stickyValues.get(stickyKey(note.modelName, field.name)) || '' : '',
      })),
    });
    const rememberStickyValues = (modelName, fields) => editorModel.fields.forEach(field => (field.sticky
      ? stickyValues.set(stickyKey(modelName, field.name), fields[field.name] || '')
      : stickyValues.delete(stickyKey(modelName, field.name))));
    const collapseLabel = (name, collapsed) => `${collapsed ? 'Expand' : 'Collapse'} ${name}`;
    const setFieldCollapsed = ($field, collapsed) => {
      const name = $field.find('.anki-note-input').data('field-name');
      fieldCollapseStates.set(name, collapsed);
      $field.toggleClass('is-collapsed', collapsed);
      const label = collapseLabel(name, collapsed);
      $field.find('.anki-rich-collapse')
        .attr({ 'aria-expanded': String(!collapsed), 'aria-label': label, 'title': label });
    };
    const fieldSettingToggle = (key, field, label) => `
      <label class="anki-rich-setting-check">
        <input class="anki-rich-field-setting" type="checkbox" data-field-setting="${key}"
          ${field[key] ? 'checked' : ''}>
        ${label}
      </label>`;
    // A field carries its note type's settings for it: the font and size its text is written in, an RTL direction,
    // its description as a hint beside the name, its configured editing mode, and a name button that can fold or
    // unfold it without changing the note type's default.
    const renderNoteField = field => {
      const settings = editorField(field.name);
      const attrs = `${settings.rtl ? ' dir="rtl"' : ''}${fieldFont(settings)}`;
      const collapsed = fieldCollapseStates.get(field.name) ?? settings.collapsed;
      const label = collapseLabel(field.name, collapsed);
      const htmlMode = richFieldMode(field.name);
      const action = htmlMode ? 'Preview' : 'Edit';
      const fieldClasses = ['card-field', 'anki-rich-field', collapsed && 'is-collapsed',
        htmlMode && 'is-editing'].filter(Boolean).join(' ');
      return `
      <div class="${fieldClasses}">
        <div class="anki-rich-head">
          <button class="anki-rich-field-name anki-rich-collapse" type="button"
            aria-expanded="${String(!collapsed)}" aria-label="${escapeAttr(label)}"
            title="${escapeAttr(label)}">
            <span>${escapeHtml(field.name)}</span>${icon('chevron-right')}
          </button>
          ${settings.description ? `<span class="anki-rich-hint">${escapeHtml(settings.description)}</span>` : ''}
          <span class="anki-rich-actions">
            <button class="icon-button icon-button-sm anki-rich-settings-toggle" type="button"
              aria-expanded="${String(fieldSettingsOpen === field.name)}"
              aria-label="Field options for ${escapeAttr(field.name)}"
              title="Field options for ${escapeAttr(field.name)}">${icon('settings')}</button>
            <button class="icon-button icon-button-sm anki-rich-toggle" type="button" aria-pressed="${htmlMode}"
              aria-label="${action} ${escapeAttr(field.name)} as raw HTML (Command or Control+Shift+X)"
              title="${action} ${escapeAttr(field.name)} as raw HTML (⌘/Ctrl+Shift+X)"
              >${icon(htmlMode ? RICH_MODE_ICONS.preview : RICH_MODE_ICONS.html)}</button>
          </span>
        </div>
        ${fieldSettingsOpen === field.name ? `<div class="anki-rich-field-options">
          ${fieldSettingToggle('rtl', settings, 'Right to left')}
          ${fieldSettingToggle('sticky', settings, 'Sticky')}
          ${fieldSettingToggle('collapsed', settings, 'Collapsed by default')}
          ${fieldSettingToggle('htmlEditor', settings, 'Use HTML editor by default')}
        </div>` : ''}
        <iframe class="field anki-rich-view" title="${escapeAttr(field.name)}" sandbox="allow-same-origin"></iframe>
        <textarea class="field card-input anki-note-input" data-field-name="${escapeAttr(field.name)}"
          rows="1" spellcheck="false"${attrs}>${escapeHtml(field.value)}</textarea>
      </div>`;
    };
    const toggleTargetField = () => {
      const $focused = $(document.activeElement).closest('.anki-rich-field');
      if ($focused.length) return $focused;
      const $last = $editor.find('.anki-rich-field').filter((_, element) =>
        $(element).find('.anki-note-input').data('field-name') === richFieldName).first();
      return $last.length ? $last : $editor.find('.anki-rich-field').first();
    };
    // A toggle hands the caret back to the preview, which never lost it: the document is the one its field was
    // built with, so it still holds the selection the textarea interrupted. Only a preview that was never entered
    // lands at the end — where the raw-HTML textarea's own caret lands as well — and the field states the focus
    // itself, because a body that already held its frame's focus fires no second focus event to state it with.
    const setRichFieldMode = ($field, htmlMode, { focus = false, reveal = focus, persist = false } = {}) => {
      const fieldName = $field.find('.anki-note-input').data('field-name');
      const action = htmlMode ? 'Preview' : 'Edit';
      const label = `${action} ${fieldName} as raw HTML`;
      if (persist) richFieldModes.set(richFieldModeKey(fieldName), htmlMode);
      if (focus) richFieldName = fieldName;
      $field.toggleClass('is-editing', htmlMode);
      // A user opening raw HTML also opens a collapsed field. Its configured default mode alone does not.
      if (htmlMode && reveal) setFieldCollapsed($field, false);
      if (htmlMode) $field.removeClass('is-focused');
      $field.find('.anki-rich-toggle').attr('aria-pressed', String(htmlMode))
        .attr('aria-label', `${label} (Command or Control+Shift+X)`)
        .attr('title', `${label} (⌘/Ctrl+Shift+X)`);
      $field.find('.anki-rich-toggle use').attr('href',
        `#i-${htmlMode ? RICH_MODE_ICONS.preview : RICH_MODE_ICONS.html}`);
      if (htmlMode) {
        const $textarea = $field.find('.anki-note-input');
        autoGrow($textarea);
        if (focus) $textarea.trigger('focus');
      } else {
        syncRichView($field, { focus });
      }
    };

    const tagChips = tags => (tags || []).map(tag => chipButton({
      text: tag, label: `Remove tag ${tag}`, title: `Remove tag ${tag}`, data: { 'data-tag': tag },
    })).join('');
    const tagControl = tags => `
      <span class="anki-tag-chips">${tagChips(tags)}</span>
      <input class="field field-bare anki-tag-input" type="text" autocomplete="off" spellcheck="false"
        aria-label="Add tag" aria-expanded="false" placeholder="tag">
      <div class="anki-tag-suggestions" role="listbox" aria-label="Tag suggestions" hidden></div>`;

    const ensureBrowserEditor = () => {
      if ($editor.find('.anki-note-body').length) return;
      $editor.html(`
        <div class="anki-note-top">
          <div class="anki-note-top-items">
            <button class="button button-ui button-icon anki-note-close" type="button"
              aria-label="Back to list" title="Back to list">${icon('back')}</button>
            <div class="anki-note-type-field">
              <span class="eyebrow">NOTE TYPE</span>
              <span class="anki-note-type"></span>
              <select class="field field-select anki-note-type-select" aria-label="Note type" hidden></select>
            </div>
            <div class="anki-deck-field">
              <span class="eyebrow">DECK</span>
              <span class="anki-note-deck"></span>
            </div>
          </div>
          <div class="anki-note-meta">
            <span class="muted anki-note-id"></span>
            <button class="button button-write button-with-icon anki-note-save" type="button" hidden>
              ${icon('check-circle')}</button>
          </div>
        </div>
        <div class="anki-note-body">
          <div class="card-fields"></div>
        </div>
        <div class="anki-note-footer">
          <div class="anki-tag-field">
            <span class="eyebrow">TAGS</span>
            <div class="anki-tag-control"></div>
          </div>
        </div>
      `);
    };

    const updateBrowserEditorFields = fields => {
      const $fields = $editor.find('.anki-rich-field');
      const renderedNames = $fields.map((_, element) =>
        $(element).find('.anki-note-input').data('field-name')).get();
      const names = fields.map(field => field.name);
      if (renderedNames.join('\0') !== names.join('\0')) {
        $editor.find('.card-fields').html(fields.map(renderNoteField).join(''));
      }
      $editor.find('.anki-rich-field').each((index, element) => {
        const $field = $(element);
        const $input = $field.find('.anki-note-input');
        if ($input.val() !== fields[index].value) $input.val(fields[index].value);
        setRichFieldMode($field, richFieldMode(fields[index].name));
        autoGrow($input);
      });
    };

    const renderEditorDeck = () => {
      if (!isEditorOpen()) return;
      const deck = activeNote().deckName || '—';
      $editor.find('.anki-note-deck').text(deck).attr('title', deck);
    };

    const renderEditorNoteType = () => {
      if (!isEditorOpen()) return;
      const note = activeNote();
      const editable = !note.id;
      const noteType = note.modelName || '—';
      const models = [...new Set([noteType, ...getModelChoices()])];
      $editor.find('.anki-note-type').text(noteType).attr('title', noteType).prop('hidden', editable);
      $editor.find('.anki-note-type-select').html(optionsHtml(models)).val(noteType).prop('hidden', !editable);
    };

    const renderEditorSave = () => {
      const shortcut = NoteShortcuts.find('save-note');
      const label = `Save new note (${NoteShortcuts.display(shortcut, isMac)})`;
      $editor.find('.anki-note-save').prop('hidden', Boolean(activeNote()?.id)).attr({
        'aria-keyshortcuts': NoteShortcuts.aria(shortcut), 'aria-label': label, title: label,
      });
    };

    function renderBrowserEditor () {
      const note = activeNote();
      if (!isEditorOpen() || !note) {
        setEditorOpen(false);
        setEditorBase({});
        $editor.prop('hidden', true).parent().removeClass('is-editing');
        renderSelectedCount();
        return;
      }
      ensureBrowserEditor();
      $editor.prop('hidden', false).parent().addClass('is-editing');
      renderEditorNoteType();
      renderEditorDeck();
      $editor.find('.anki-tag-control').html(tagControl(note.tags));
      $editor.find('.anki-note-id').text(note.id ? `noteId ${note.id}` : 'New note draft');
      renderEditorSave();
      updateBrowserEditorFields(note.fields);
      setEditorBase(Object.fromEntries(note.fields.map(field => [field.name, field.value])));
      renderSelectedCount();
    }

    const collectEditorFields = () => {
      const fields = {};
      $editor.find('.anki-note-input').each((_, input) => { fields[input.dataset.fieldName] = input.value; });
      return fields;
    };

    const preserveEditorFields = () => {
      const note = activeNote();
      if (!note) return;
      const values = collectEditorFields();
      note.fields.forEach(field => { if (field.name in values) field.value = values[field.name]; });
    };

    const refreshEditorField = name => {
      const note = activeNote();
      const field = note?.fields.find(item => item.name === name);
      const $field = $editor.find('.anki-rich-field').filter((_, element) =>
        $(element).find('.anki-note-input').data('field-name') === name).first();
      if (!field || !$field.length) return;
      $field.replaceWith(renderNoteField(field));
      const $replacement = $editor.find('.anki-rich-field').filter((_, element) =>
        $(element).find('.anki-note-input').data('field-name') === name).first();
      setRichFieldMode($replacement, richFieldMode(name));
    };

    // `false` means the note was NOT persisted, so callers must not discard the editor.
    const saveActiveNote = async ({ silent = false, create = false } = {}) => {
      const note = activeNote();
      if (!note || !isEditorOpen()) return { saved: true, skipped: false };
      if (isBusy()) return { saved: false, skipped: true };
      // Only fields the user typed are written, so a refresh cannot push a stale snapshot over a
      // concurrent agent write.
      const edited = Object.entries(collectEditorFields())
        .filter(([name, value]) => value !== editorBase()[name]);
      if (!note.id) {
        if (!create) return { saved: true, skipped: true };
        const fields = collectEditorFields();
        if (!Object.values(fields).some(value => plainText(value))) {
          setBrowserStatus('Enter content before saving the new note', 'warn');
          return { saved: false, skipped: true };
        }
        setBusy(true);
        try {
          const payload = await request('/api/anki/notes', {
            method: 'POST', body: JSON.stringify({
              fields, tags: note.tags, deckName: note.deckName, modelName: note.modelName,
            }),
          });
          notes().unshift(payload.note);
          rebuildNoteIndex();
          trackLoadedNote(payload.note.id);
          clearLoadedPages();
          bumpNoteTotal();
          rememberStickyValues(note.modelName, fields);
          // An add leaves the editor on a fresh draft of the same note type: a sticky field carries its value into
          // it and every other field is cleared, while the created note stays selected in the list behind it.
          setDraftNote(withStickyValues({ ...note, id: null,
            fields: note.fields.map(field => ({ ...field, value: '' })) }));
          setActiveId(payload.note.id);
          applySelection(NoteSelection.single(payload.note.id));
          renderBrowserList();
          renderBrowserEditor();
          focusFirstField();
          refreshQuickSearchTags();
          setBrowserStatus(`Created note ${payload.note.id}`, 'ok');
          refreshUndoStatus();
          return { saved: true, skipped: false };
        } catch (error) {
          setBrowserStatus(error.message, 'error');
          return { saved: false, skipped: false };
        } finally {
          setBusy(false);
        }
      }
      if (!edited.length) return { saved: true, skipped: true };
      setBusy(true);
      try {
        // A field whose server value moved off the editor base was changed elsewhere: the newer wins.
        const refreshed = await fetchNote(note.id, 'fields,sortField');
        const current = noteFields(refreshed ?? note);
        const writable = Object.fromEntries(edited.filter(([name]) => current[name] === editorBase()[name]));
        if (!Object.keys(writable).length) {
          if (!silent) setBrowserStatus(`Note ${note.id} changed elsewhere; kept the newer values`, 'warn');
          return { saved: true, skipped: false };
        }
        await request(`/api/anki/notes/${note.id}`, { method: 'PUT', body: JSON.stringify({ fields: writable }) });
        Object.assign(editorBase(), writable);
        note.fields.forEach(field => { if (field.name in writable) field.value = writable[field.name]; });
        note.preview = notePreview(note.fields);
        // The list row reads the note type's own field names, so the row is rebuilt from the fields the save
        // just wrote rather than from a second role-shaped read.
        note.sortField = refreshed?.sortField ?? note.sortField;
        note.fieldValues = Object.fromEntries(note.fields.map(field => [field.name, field.value]));
        const index = noteIndexOf(note.id);
        const $row = $list.find(`.anki-note-row[data-note-id="${note.id}"]`);
        if ($row.length) $row.replaceWith(renderBrowserRow(note, index));
        if (!silent) setBrowserStatus(`Saved note ${note.id}`, 'ok');
        refreshUndoStatus();
        return { saved: true, skipped: false };
      } catch (error) {
        setBrowserStatus(error.message, 'error');
        return { saved: false, skipped: false };
      } finally {
        setBusy(false);
      }
    };

    // Where typing continues: the first field, whether the editor was just opened or a draft was started after
    // an add. A frame that still has to load hands the caret over when it is ready.
    const focusFirstField = () => {
      const $field = $editor.find('.anki-rich-field').first();
      if (!$field.length) return;
      if ($field.hasClass('is-editing')) return $field.find('.anki-note-input').trigger('focus');
      const frame = $field.find('.anki-rich-view')[0];
      if (!frame) return;
      if (frame.contentDocument?.body?.dataset.bound) return focusRichBody($field, frame.contentDocument.body);
      frame.addEventListener('load', () => {
        const body = frame.contentDocument?.body;
        if (body) focusRichBody($field, body);
      }, { once: true });
    };

    const focusRichField = name => {
      const $field = $editor.find('.anki-rich-field').filter((_, element) =>
        $(element).find('.anki-note-input').data('field-name') === name).first();
      if (!$field.length) return focusFirstField();
      if ($field.hasClass('is-editing')) return $field.find('.anki-note-input').trigger('focus');
      syncRichView($field, { focus: true, caretAtEnd: true });
    };

    const leaveNoteEditor = async () => {
      if (isEditorOpen() && !(await saveActiveNote()).saved) return false;
      setEditorOpen(false);
      renderBrowserEditor();
      // The list is display:none while the editor is open, so its rows are only caught up here.
      loadVisibleNotePages(renderVisibleRows(true));
      return true;
    };

    // Last resort for a reload or a close with edits still pending: a keepalive request outlives the page
    // teardown. It writes exactly what `saveActiveNote` decided, against the base it holds here, because the
    // merge that one runs needs an answer the unload cannot wait for.
    const flushEditorOnUnload = () => {
      const note = activeNote();
      if (!isEditorOpen() || !note || isBusy()) return;
      const send = (url, method, body) => fetch(url, {
        method, keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => {});
      if (!note.id) {
        // A draft is worth writing only for what the user typed into it: a sticky value it inherited from the
        // last add is not an edit, so a reload never turns a kept value into a note.
        const fields = collectEditorFields();
        const base = editorBase();
        if (!Object.entries(fields).some(([name, value]) => plainText(value) && value !== base[name])) return;
        send('/api/anki/notes', 'POST',
          { fields, tags: note.tags, deckName: note.deckName, modelName: note.modelName });
        return;
      }
      const fields = Object.fromEntries(Object.entries(collectEditorFields())
        .filter(([name, value]) => value !== editorBase()[name]));
      if (Object.keys(fields).length) send(`/api/anki/notes/${note.id}`, 'PUT', { fields });
    };

    const openNoteEditor = async id => {
      const preserveFocus = isEditorOpen() && getActiveId() !== id;
      const focusField = preserveFocus ? richFieldName : '';
      if (isEditorOpen() && getActiveId() !== id && !(await saveActiveNote()).saved) return;
      const index = noteIndexOf(id);
      if (index < 0) return;
      if (!notes()[index].fields) {
        setBusy(true);
        setBrowserStatus(`Loading note ${id}…`, 'pending');
        try {
          const { note } = await request(`/api/anki/notes/${id}`);
          notes()[index] = { ...notes()[index], ...note };
          trackLoadedNote(note.id);
          setBrowserStatus(`Loaded note ${id}`, 'ok');
        } catch (error) {
          setBrowserStatus(error.message, 'error');
          return;
        } finally {
          setBusy(false);
        }
      }
      setActiveId(id);
      setDraftNote(null);
      setEditorOpen(true);
      rememberSelection(id);
      applySelection(NoteSelection.single(id));
      await loadEditorModel(notes()[index].modelName);
      renderBrowserEditor();
      if (preserveFocus) focusRichField(focusField);
    };

    const createNote = async () => {
      if (isBusy()) return;
      if (isEditorOpen() && !(await saveActiveNote()).saved) return;
      setBusy(true);
      setBrowserStatus('Opening new note…', 'pending');
      try {
        const [{ note }, { models }] = await Promise.all([
          request('/api/anki/notes/new'), request('/api/anki/decks?select=models'),
        ]);
        await setModelChoices(models);
        // The settings are read before the draft is drawn, because they decide it: the note type names the field
        // settings and holds the values a sticky field keeps.
        await loadEditorModel(note.modelName);
        setDraftNote(withStickyValues(note));
        setActiveId(null);
        setEditorOpen(true);
        applySelection(NoteSelection.none());
        renderBrowserEditor();
        focusFirstField();
        setBrowserStatus('New note draft', 'ok');
      } catch (error) {
        setBrowserStatus(error.message, 'error');
      } finally {
        setBusy(false);
        renderSelectedCount();
      }
    };

    const changeDraftNoteType = async event => {
      const note = activeNote();
      const modelName = event.currentTarget.value;
      if (!note || note.id || isBusy() || modelName === note.modelName) return;
      setBusy(true);
      try {
        const { note: template } = await request(`/api/anki/notes/new?modelName=${encodeURIComponent(modelName)}`);
        const fields = collectEditorFields();
        setDraftNote({
          ...template,
          deckName: note.deckName,
          tags: note.tags,
          fields: template.fields.map(field => ({ ...field, value: fields[field.name] || '' })),
        });
        await loadEditorModel(template.modelName);
        renderBrowserEditor();
        setBrowserStatus(`Note type changed to ${template.modelName}`, 'ok');
      } catch (error) {
        renderBrowserEditor();
        setBrowserStatus(error.message, 'error');
      } finally {
        setBusy(false);
        renderSelectedCount();
      }
    };

    const activeNoteTags = () => {
      const note = activeNote();
      return note && Array.isArray(note.tags) ? note.tags : [];
    };
    // Only the chips are re-rendered so the tag input keeps its value and the suggestion list.
    const refreshTagChips = () => $editor.find('.anki-tag-chips').html(tagChips(activeNoteTags()));
    const changeNoteTag = async (action, tag) => {
      const note = activeNote();
      if (!note || isBusy() || !tag) return;
      const removing = action === 'remove';
      if (removing !== activeNoteTags().includes(tag)) return;
      if (!note.id) {
        note.tags = removing ? note.tags.filter(value => value !== tag) : [...note.tags, tag];
        refreshTagChips();
        return;
      }
      setBusy(true);
      try {
        const payload = await request(`/api/anki/notes/${note.id}/tags`, {
          method: 'PUT', body: JSON.stringify({ [action]: [tag] }),
        });
        note.tags = payload.note.tags;
        refreshTagChips();
        refreshQuickSearchTags();
        setBrowserStatus(`${removing ? 'Removed' : 'Added'} tag "${tag}" `
          + `${removing ? 'from' : 'to'} note ${note.id}`, 'ok');
      } catch (error) {
        setBrowserStatus(error.message, 'error');
      } finally {
        setBusy(false);
      }
    };

    // Suggestions start at two characters and filter server-side, so a pick reuses an existing tag.
    const TAG_SUGGESTION_MIN = 2;
    let tagSuggestionTimer;
    const closeTagSuggestions = () => {
      $editor.find('.anki-tag-suggestions').prop('hidden', true).empty();
      $editor.find('.anki-tag-input').attr('aria-expanded', 'false');
    };
    const renderTagSuggestions = tags => {
      const $suggestions = $editor.find('.anki-tag-suggestions');
      if (!tags.length) { closeTagSuggestions(); return; }
      $suggestions.html(tags.map(tag => `<button class="anki-tag-suggestion" data-tag="${escapeAttr(tag)}"
        type="button" role="option">${escapeHtml(tag)}</button>`).join('')).prop('hidden', false);
      $editor.find('.anki-tag-input').attr('aria-expanded', 'true');
    };
    const loadTagSuggestions = async query => {
      try {
        const { tags } = await request(`/api/anki/tags?query=${encodeURIComponent(query)}`);
        const $input = $editor.find('.anki-tag-input');
        if (!$input.length || $input.val().trim() !== query) return;
        renderTagSuggestions(tags.filter(tag => !activeNoteTags().includes(tag)));
      } catch (error) {
        setBrowserStatus(error.message, 'error');
        closeTagSuggestions();
      }
    };

    $editor.on('input', 'textarea.anki-note-input', event => autoGrow($(event.currentTarget)));
    $editor.on('focusin', 'textarea.anki-note-input', event => {
      const $field = $(event.currentTarget).closest('.anki-rich-field');
      rememberRichField($field);
      clearOtherRichFocus($field);
    });
    // Same commit-on-blur rule as the rich body: the raw-HTML textarea only writes once its own focus is done
    // with it. `focusout` (unlike `blur`) bubbles, so one delegated listener covers every field.
    $editor.on('focusout', 'textarea.anki-note-input', () => saveActiveNote({ silent: true }));

    $editor.on('click', '.anki-rich-toggle', event => {
      const $field = $(event.currentTarget).closest('.anki-rich-field');
      setRichFieldMode($field, !$field.hasClass('is-editing'), { focus: true, persist: true });
    });
    $editor.on('click', '.anki-rich-collapse', event => {
      const $field = $(event.currentTarget).closest('.anki-rich-field');
      setFieldCollapsed($field, !$field.hasClass('is-collapsed'));
    });
    $editor.on('click', '.anki-rich-settings-toggle', event => {
      const name = $(event.currentTarget).closest('.anki-rich-field').find('.anki-note-input').data('field-name');
      if (!name) return;
      preserveEditorFields();
      const opening = fieldSettingsOpen !== name;
      fieldSettingsOpen = opening ? name : '';
      if (opening) fieldCollapseStates.set(name, false);
      refreshEditorField(name);
    });
    $editor.on('change', '.anki-rich-field-setting', async event => {
      const element = event.currentTarget;
      const name = $(element).closest('.anki-rich-field').find('.anki-note-input').data('field-name');
      const note = activeNote();
      if (!name || !note || isBusy()) return;
      preserveEditorFields();
      setBusy(true);
      try {
        const setting = element.dataset.fieldSetting;
        const fieldUrl = `/api/anki/models/${encodeURIComponent(note.modelName)}/fields/${encodeURIComponent(name)}`;
        const { model } = await request(fieldUrl, {
          method: 'PUT', body: JSON.stringify({ [setting]: element.checked }),
        });
        editorModel = { styling: model.styling || '', fields: model.fields || [] };
        if (setting === 'collapsed') fieldCollapseStates.delete(name);
        if (setting === 'htmlEditor') richFieldModes.delete(richFieldModeKey(name));
        refreshEditorField(name);
        setBrowserStatus(`Saved ${name} field settings`, 'ok');
      } catch (error) {
        refreshEditorField(name);
        setBrowserStatus(error.message, 'error');
      } finally {
        setBusy(false);
      }
    });
    const returnToNoteList = async () => {
      if (!await leaveNoteEditor()) return;
      renderSelection(getActiveId());
      setNoteListStatus();
    };
    $editor.on('click', '.anki-note-close', returnToNoteList);
    $editor.on('click', '.anki-note-save', () => saveActiveNote({ create: true }));
    $editor.on('change', '.anki-note-type-select', changeDraftNoteType);

    $editor.on('input', '.anki-tag-input', event => {
      const query = $(event.currentTarget).val().trim();
      window.clearTimeout(tagSuggestionTimer);
      if (query.length < TAG_SUGGESTION_MIN) { closeTagSuggestions(); return; }
      tagSuggestionTimer = window.setTimeout(() => loadTagSuggestions(query), 150);
    });
    $editor.on('click', '.anki-tag-chip', event =>
      changeNoteTag('remove', $(event.currentTarget).data('tag')));
    // Keep the input focused while choosing, so the pick is a plain click on the suggestion.
    $editor.on('mousedown', '.anki-tag-suggestions', event => event.preventDefault());
    $editor.on('click', '.anki-tag-suggestion', event => {
      const $suggestion = $(event.currentTarget);
      $editor.find('.anki-tag-input').val('');
      closeTagSuggestions();
      changeNoteTag('add', $suggestion.data('tag'));
    });
    $editor.on('keydown', '.anki-tag-input', event => {
      const $options = $editor.find('.anki-tag-suggestion');
      if (event.key === 'Enter') {
        event.preventDefault();
        const $picked = $options.filter('.is-active').first();
        const tag = $picked.data('tag') || $(event.currentTarget).val().trim();
        if (!tag) return;
        $(event.currentTarget).val('');
        closeTagSuggestions();
        changeNoteTag('add', tag);
        return;
      }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !$options.length) return;
      event.preventDefault();
      const index = $options.index($options.filter('.is-active'));
      const next = event.key === 'ArrowDown'
        ? (index + 1) % $options.length
        : (index <= 0 ? $options.length : index) - 1;
      $options.removeClass('is-active').eq(next).addClass('is-active');
    });
    $(document).on('mousedown', event => {
      if ($(event.target).closest('.anki-tag-control').length) return;
      closeTagSuggestions();
    });

    document.addEventListener('keydown', async event => {
      const shortcut = NoteShortcuts.find('save-note');
      if (event.defaultPrevented || !isEditorOpen() || activeNote()?.id
        || !NoteShortcuts.matches(event, shortcut)) return;
      event.preventDefault();
      await saveActiveNote({ create: true });
    }, true);

    $(document).on('anki-shortcuts-changed', renderEditorSave);

    document.addEventListener('keydown', async event => {
      if (event.key !== 'Escape' || !isEditorOpen()) return;
      event.preventDefault();
      // The first Escape dismisses the tag suggestions; only the next one leaves the editor.
      if ($(event.target).is('.anki-tag-input')
        && $editor.find('.anki-tag-suggestions').is(':not([hidden])')) {
        closeTagSuggestions();
        return;
      }
      await returnToNoteList();
    }, true);

    return {
      renderBrowserEditor, renderEditorDeck, collectEditorFields, saveActiveNote,
      openNoteEditor, createNote, toggleTargetField, flushEditorOnUnload,
    };
  };

  return { createNoteEditor };
});
