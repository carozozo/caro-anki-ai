((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroShortcutSettings = api;
})(globalThis, () => {
  // The Shortcuts panel: one row per definition, a capture field that listens for the next key press, and the
  // persistence the whole page hears through `anki-shortcuts-changed`. It is one section of the settings
  // dialog, so it owns only its own status line.
  const createShortcutSettings = ({ $, CaroUI, config, NoteShortcuts }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const { icon } = CaroUI.icons;
    const { escapeAttr, escapeHtml } = CaroUI.text;

    const setShortcutSettingsStatus = (text, kind = '') =>
      setSystemMessage($('#shortcutSettingsStatus'), text, kind);
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    let shortcutCaptureId = null;
    let shortcutFilter = '';

    const shortcutRowHtml = shortcut => {
      const isDefault = NoteShortcuts.sameBinding(shortcut, NoteShortcuts.defaultFor(shortcut.id));
      const bindingLabel = NoteShortcuts.display(shortcut, isMac);
      const name = escapeAttr(shortcut.id);
      return `<div class="shortcut-setting" role="listitem">
        <span class="shortcut-setting-label">${escapeHtml(shortcut.label)}</span>
        <button class="field field-sm shortcut-binding${shortcutCaptureId === shortcut.id ? ' is-capturing' : ''}"
          type="button" data-shortcut-id="${name}" aria-label="Set shortcut for ${escapeAttr(shortcut.label)}"
          title="Select, then press a new shortcut">${escapeHtml(
            shortcutCaptureId === shortcut.id ? 'Press keys…' : bindingLabel,
          )}</button>
        <button class="button button-write button-icon shortcut-reset" type="button" data-shortcut-id="${name}"
          aria-label="Restore ${escapeAttr(shortcut.label)} shortcut" title="Restore default shortcut"${
            isDefault ? ' disabled' : ''
          }>${icon('back')}</button>
      </div>`;
    };
    const matchingShortcuts = () => {
      const query = shortcutFilter.trim().toLowerCase();
      return NoteShortcuts.definitions.filter(shortcut => !query || [
        shortcut.id, shortcut.label, NoteShortcuts.display(shortcut, isMac),
      ].join(' ').toLowerCase().includes(query));
    };
    const renderShortcutSettings = () => {
      const shortcuts = matchingShortcuts();
      $('#shortcutSettingsList').html(shortcuts.length
        ? shortcuts.map(shortcutRowHtml).join('')
        : '<p class="dialog-help shortcut-empty">No shortcuts match your search.</p>');
    };
    const persistShortcuts = () => {
      NoteShortcuts.persist(localStorage, config.storageKeys.ankiShortcuts);
      $(document).trigger('anki-shortcuts-changed');
    };
    const renderShortcutRow = ($row, shortcut) => {
      $row.find('.shortcut-binding').removeClass('is-capturing').text(NoteShortcuts.display(shortcut, isMac));
      $row.find('.shortcut-reset').prop('disabled', NoteShortcuts.sameBinding(
        shortcut, NoteShortcuts.defaultFor(shortcut.id)));
    };
    const restoreShortcut = (id, message, $row) => {
      NoteShortcuts.reset(id);
      persistShortcuts();
      shortcutCaptureId = null;
      renderShortcutRow($row, NoteShortcuts.find(id));
      setShortcutSettingsStatus(message, 'ok');
    };
    $('#shortcutSettingsList').on('click', '.shortcut-binding', event => {
      shortcutCaptureId = event.currentTarget.dataset.shortcutId;
      $(event.currentTarget).addClass('is-capturing').text('Press keys…').trigger('focus');
    });
    $('#shortcutSettingsList').on('focusout', '.shortcut-binding', event => {
      if (shortcutCaptureId !== event.currentTarget.dataset.shortcutId) return;
      shortcutCaptureId = null;
      const shortcut = NoteShortcuts.find(event.currentTarget.dataset.shortcutId);
      $(event.currentTarget).removeClass('is-capturing').text(NoteShortcuts.display(shortcut, isMac));
    });
    $('#shortcutSettingsList').on('keydown', '.shortcut-binding', event => {
      event.preventDefault();
      const id = event.currentTarget.dataset.shortcutId;
      const binding = NoteShortcuts.capture(event.originalEvent);
      if (!binding) {
        setShortcutSettingsStatus('Use Command or Control with another key.', 'warn');
        return;
      }
      const conflict = NoteShortcuts.definitions.find(shortcut => shortcut.id !== id
        && NoteShortcuts.sameBinding(shortcut, binding));
      if (conflict) {
        setShortcutSettingsStatus(
          `${NoteShortcuts.display(binding, isMac)} is already used by ${conflict.label}.`, 'error');
        return;
      }
      const previous = NoteShortcuts.binding(NoteShortcuts.find(id));
      try {
        NoteShortcuts.update(id, binding);
        persistShortcuts();
        shortcutCaptureId = null;
        renderShortcutRow($(event.currentTarget).closest('.shortcut-setting'), NoteShortcuts.find(id));
        setShortcutSettingsStatus(
          `${NoteShortcuts.find(id).label} saved as ${NoteShortcuts.display(binding, isMac)}.`, 'ok');
      } catch (error) {
        NoteShortcuts.update(id, previous);
        shortcutCaptureId = null;
        renderShortcutRow($(event.currentTarget).closest('.shortcut-setting'), NoteShortcuts.find(id));
        setShortcutSettingsStatus(error.message, 'error');
      }
    });
    $('#shortcutSettingsList').on('click', '.shortcut-reset', event => {
      const shortcut = NoteShortcuts.find(event.currentTarget.dataset.shortcutId);
      try {
        restoreShortcut(shortcut.id, `Restored ${shortcut.label}.`,
          $(event.currentTarget).closest('.shortcut-setting'));
      }
      catch (error) { setShortcutSettingsStatus(error.message, 'error'); }
    });
    $('#shortcutFilter').on('input', event => {
      shortcutCaptureId = null;
      shortcutFilter = event.currentTarget.value;
      renderShortcutSettings();
    });
    $('#shortcutResetAll').on('click', () => {
      try {
        NoteShortcuts.resetAll();
        persistShortcuts();
        shortcutCaptureId = null;
        matchingShortcuts().forEach(shortcut => renderShortcutRow(
          $(`.shortcut-reset[data-shortcut-id="${shortcut.id}"]`).closest('.shortcut-setting'), shortcut));
        setShortcutSettingsStatus('Restored all default shortcuts.', 'ok');
      } catch (error) { setShortcutSettingsStatus(error.message, 'error'); }
    });

    return {
      render: renderShortcutSettings,
      reset: () => {
        shortcutCaptureId = null;
        shortcutFilter = '';
        $('#shortcutFilter').val('');
      },
      setPanelStatus: setShortcutSettingsStatus,
    };
  };

  return { createShortcutSettings };
});
