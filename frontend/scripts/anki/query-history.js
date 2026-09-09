((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QueryHistory = api;
})(globalThis, () => {
  // The query field remembers what was searched before, as a listbox the field itself owns: the list stays
  // closed while the user types, opens on the arrow keys, moves with them, and closes on a choice, on Escape,
  // on input, or on a click anywhere outside the field.
  const createQueryHistory = ({ $, $panel, config, CaroUI }) => {
    const { escapeAttr, escapeHtml } = CaroUI.text;
    const key = config.storageKeys.ankiQueryHistory;
    const limit = config.ankiBrowser.queryHistoryLimit;
    const $query = $('#ankiQuery');
    const $history = $('#ankiQueryHistory');
    let queryHistoryIndex = -1;

    const readQueryHistory = () => JSON.parse(localStorage.getItem(key) || '[]');
    const renderQueryHistory = history => $history.html(history
      .map(query => `<button class="anki-query-history-item" type="button" role="option"
        data-query="${escapeAttr(query)}">${escapeHtml(query)}</button>`)
      .join(''));
    const close = () => {
      queryHistoryIndex = -1;
      $query.attr('aria-expanded', 'false');
      $history.prop('hidden', true).find('.active').removeClass('active').attr('aria-selected', 'false');
    };
    const show = () => {
      if (!$history.children().length) return;
      $query.attr('aria-expanded', 'true');
      $history.prop('hidden', false);
    };
    const selectQueryHistoryItem = index => {
      const $items = $history.children();
      queryHistoryIndex = (index + $items.length) % $items.length;
      $items.removeClass('active').attr('aria-selected', 'false');
      $items.eq(queryHistoryIndex).addClass('active').attr('aria-selected', 'true')[0].scrollIntoView({ block: 'nearest' });
    };
    const remember = query => {
      if (!query) return;
      const history = [query, ...readQueryHistory().filter(item => item !== query)].slice(0, limit);
      localStorage.setItem(key, JSON.stringify(history));
      renderQueryHistory(history);
    };

    renderQueryHistory(readQueryHistory());

    $query.on('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!$history.children().length) return;
        event.preventDefault();
        show();
        const initialIndex = event.key === 'ArrowDown' ? 0 : $history.children().length - 1;
        selectQueryHistoryItem(queryHistoryIndex < 0
          ? initialIndex
          : queryHistoryIndex + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter' && !$history.prop('hidden') && queryHistoryIndex >= 0) {
        event.preventDefault();
        $query.val($history.children().eq(queryHistoryIndex).data('query'));
        close();
      } else if (event.key === 'Escape') {
        close();
      }
    }).on('input', close);

    $history.on('mousedown', event => event.preventDefault()).on('click', '.anki-query-history-item', event => {
      $query.val($(event.currentTarget).data('query')).trigger('focus');
      close();
    });

    $panel.on('click', event => {
      if (!event.target.closest('.anki-query-field')) close();
    });

    return { remember, close };
  };

  return { createQueryHistory };
});
