((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FindReplaceDialog = api;
})(globalThis, () => {
  const createFindReplaceHistory = ({ storage, key, limit }) => {
    const read = () => {
      const saved = JSON.parse(storage.getItem(key) || '{}');
      return {
        find: Array.isArray(saved.find) ? saved.find : [],
        replace: Array.isArray(saved.replace) ? saved.replace : [],
      };
    };
    const values = field => read()[field];
    const remember = (field, value) => {
      if (!value) return values(field);
      const history = read();
      history[field] = [value, ...history[field].filter(item => item !== value)].slice(0, limit);
      storage.setItem(key, JSON.stringify(history));
      return history[field];
    };
    return { values, remember };
  };

  const createFindReplaceDialog = ({
    $, CaroUI, createDialog, request, setStatus, fieldNames, selectedIds, currentQuery, isBusy, setBusy,
    saveActiveNote, reloadNotes, refreshUndoStatus, config, storage = localStorage,
  }) => {
    const { escapeAttr, formatCount } = CaroUI.text;
    const { optionsHtml } = CaroUI.fields;
    const $dialog = $('#ankiFindReplaceDialog');
    const $find = $('#ankiFindReplaceFind');
    const $replace = $('#ankiFindReplaceWith');
    const history = createFindReplaceHistory({
      storage, key: config.storageKeys.ankiFindReplaceHistory, limit: config.ankiBrowser.findReplaceHistoryLimit,
    });
    const setError = text => $('#ankiFindReplaceError').text(text);
    const dialog = createDialog({ selector: '#ankiFindReplaceDialog', onClose: () => setError('') });
    const uniqueFields = () => [...new Map(fieldNames().map(name => [name.toLowerCase(), name])).values()]
      .sort((left, right) => left.localeCompare(right));
    const targetDescription = count => count
      ? `${formatCount(count)} selected note${count === 1 ? '' : 's'} will be changed.`
      : 'Every note matching the current search will be changed.';
    const renderHistory = field => $(`#ankiFindReplace${field === 'find' ? 'Find' : 'With'}History`).html(
      history.values(field).map(value => `<option value="${escapeAttr(value)}"></option>`).join(''));

    const open = () => {
      if (isBusy()) return;
      const count = selectedIds().size;
      $find.val('');
      $replace.val('');
      renderHistory('find');
      renderHistory('replace');
      $('#ankiFindReplaceField').html(optionsHtml([
        { value: '', label: 'All fields' },
        ...uniqueFields().map(name => ({ value: name, label: name })),
      ]));
      $('#ankiFindReplaceSelected').prop({ checked: Boolean(count), disabled: !count });
      $('#ankiFindReplaceScope').text(targetDescription(count));
      setError('');
      dialog.open();
      $('#ankiFindReplaceFind').trigger('focus');
    };

    const replace = async () => {
      if (isBusy()) return;
      const find = $find.val();
      if (!find) {
        setError('Find text is required.');
        $find.trigger('focus');
        return;
      }
      if (!(await saveActiveNote()).saved) return;
      const replacement = $replace.val();
      history.remember('find', find);
      history.remember('replace', replacement);
      const useSelection = $('#ankiFindReplaceSelected').prop('checked');
      const noteIds = useSelection ? [...selectedIds()] : null;
      setBusy(true);
      try {
        const { result } = await request('/api/anki/notes/batch', {
          method: 'POST',
          body: JSON.stringify({
            action: 'findReplace', ...(noteIds ? { noteIds } : { query: currentQuery() }), find,
            replace: replacement, field: $('#ankiFindReplaceField').val() || null,
            ignoreCase: $('#ankiFindReplaceIgnoreCase').prop('checked'),
            regularExpression: $('#ankiFindReplaceRegex').prop('checked'),
          }),
        });
        await reloadNotes();
        if (result.changedCount) refreshUndoStatus();
        dialog.close();
        setStatus(result.changedCount
          ? `Replaced ${formatCount(result.matchCount)} match${result.matchCount === 1 ? '' : 'es'} in ${
            formatCount(result.changedCount)} note${result.changedCount === 1 ? '' : 's'}`
          : 'No matches found.', result.changedCount ? 'ok' : 'warn');
      } catch (error) {
        setError(error.message);
        setStatus(error.message, 'error');
      } finally {
        setBusy(false);
      }
    };

    $('#ankiFindReplaceForm').on('submit', event => { event.preventDefault(); replace(); });
    $('#ankiFindReplaceSelected').on('change', event => {
      $('#ankiFindReplaceScope').text(targetDescription(event.currentTarget.checked ? selectedIds().size : 0));
    });
    return { close: () => dialog.close(), open };
  };

  return { createFindReplaceDialog, createFindReplaceHistory };
});
