((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TagStudio = api;
})(globalThis, () => {
  const createTagStudio = ({ $, request, CaroUI, createDialog, armedConfirm, onTagsChanged }) => {
    const { pickerRow } = CaroUI.fields;
    const { set: setSystemMessage } = CaroUI.status;
    const dialog = createDialog({ selector: '#ankiTagDialog' });
    let saving = false;

    const status = (text, kind = '') => setSystemMessage($('#ankiTagStatus'), text, kind);
    const manager = CaroUI.entityManager({
      id: tag => tag,
      labelOf: tag => tag,
      list: async () => (await request('/api/anki/tags?select=tags&all=true')).tags,
      rename: async (oldName, name) => {
        await request(`/api/anki/tags/${encodeURIComponent(oldName)}`, {
          method: 'PUT', body: JSON.stringify({ name }),
        });
        return name;
      },
      remove: tag => request(`/api/anki/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),
    });

    const withSave = async (work, success, { onSaved = () => {} } = {}) => {
      if (saving) return;
      saving = true;
      render();
      try {
        const result = await work();
        await onTagsChanged();
        status(typeof success === 'function' ? success(result) : success, 'ok');
        onSaved();
      } catch (error) {
        status(error.message, 'error');
      } finally {
        saving = false;
        render();
      }
    };

    const picker = pickerRow({
      manager,
      ids: {
        select: '#ankiTagSelect', rename: '#ankiTagName', confirm: '#ankiTagConfirm',
        back: '#ankiTagReturn', remove: '#ankiDeleteTag',
      },
      sentinel: '- New tag -',
      entity: 'tag',
      create: null,
      isReady: () => !saving,
      run: withSave,
      messages: { renamed: (from, name) => `Renamed tag ${from} to ${name}` },
    });

    const render = () => {
      const ready = !saving;
      const picking = picker.mode() === 'pick';
      picker.render();
      $('#ankiDeleteTag').prop('disabled', !(ready && manager.canDelete()));
      $('#ankiClearUnusedTags').prop({ disabled: !(ready && picking), hidden: !picking });
    };

    const open = async () => {
      dialog.open();
      status('Loading tags…', 'pending');
      try {
        await manager.load();
        render();
        status('', '');
      } catch (error) {
        status(error.message, 'error');
      }
    };

    const deleteConfirm = armedConfirm(() => {
      const tag = manager.selected();
      if (!tag || saving) return undefined;
      return withSave(() => manager.remove(tag), `Deleted tag ${tag} and its children`);
    });
    $('#ankiDeleteTag').on('click', event => {
      if (saving || !manager.canDelete()) return;
      deleteConfirm.handle(event, `Click again to delete "${manager.selected()}" and its children`);
    });

    $('#ankiClearUnusedTags').on('click', () => {
      if (saving || picker.mode() !== 'pick') return;
      withSave(
        () => request('/api/anki/tags?unused=true', { method: 'DELETE' }),
        ({ cleared }) => cleared
          ? `Cleared ${cleared} unused tag${cleared === 1 ? '' : 's'}` : 'No unused tags to clear',
      );
    });

    return { open };
  };

  return { createTagStudio };
});
