((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuickSearch = api;
})(globalThis, () => {
  const groupIds = groups => groups.map(({ id }) => id);
  const normalizeGroupOrder = (order, groups) => {
    const ids = groupIds(groups);
    const known = new Set(ids);
    const saved = Array.isArray(order) ? order.filter(id => known.has(id)) : [];
    return [...new Set([...saved, ...ids])];
  };
  const moveGroupOrder = (order, sourceId, targetId, after = false) => {
    if (sourceId === targetId || !order.includes(sourceId) || !order.includes(targetId)) return [...order];
    const next = order.filter(id => id !== sourceId);
    next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
    return next;
  };
  const escapeSearchValue = value => String(value)
    .replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    .replace(/[\\*_\"]/g, '\\$&');
  const namedEntry = ({ prefix, quote }, value) => ({
    text: value,
    query: `${prefix}:${quote ? `"${escapeSearchValue(value)}"` : escapeSearchValue(value)}`,
  });
  const groupEntries = (group, decks, models, tags) => {
    const values = group.source === 'decks' ? decks
      : group.source === 'models' ? models
        : group.source === 'tags' ? tags : group.values;
    return values.map(value => typeof value === 'object' ? value : namedEntry(group, value));
  };
  const searchPrefixes = groups => [...new Set(groups.flatMap(({ prefix, values = [] }) => [
    prefix,
    ...values.map(({ query }) => String(query).split(':', 1)[0]),
  ]).filter(Boolean))];
  const visibleDeckNames = (decks, settings) => {
    const chosen = settings?.visibleDecks || [];
    return chosen.length ? decks.filter(deck => chosen.includes(deck)) : decks;
  };

  // Groups fold independently and their stable ids preserve an explicit order across label changes and new groups.
  const createQuickSearch = ({
    $, config, CaroUI, restoredGroups, restoredGroupOrder, deckNames, modelNames, getSettings, request,
    loadNotes, persistView,
  }) => {
    const { escapeAttr, escapeHtml } = CaroUI.text;
    const { quickSearchGroups } = config.ankiBrowser;
    const $quick = $('#ankiQuickSearchList');
    let quickGroups = [];
    let groupOrder = normalizeGroupOrder(restoredGroupOrder, quickSearchGroups);
    let tagNames = [];
    let tagRequest = 0;
    let suppressGroupClick = false;
    const collapsedGroups = new Set(restoredGroups);
    const groupById = new Map(quickSearchGroups.map(group => [group.id, group]));

    const renderItem = ({ text, query, flag }) => {
      const className = ['anki-quick-item', flag && 'is-flag-item', flag && `is-flag-${flag}`]
        .filter(Boolean).join(' ');
      return `<button class="${className}" data-query="${escapeAttr(query)}" type="button">`
        + `${escapeHtml(text)}</button>`;
    };
    const renderGroup = ({ id, label, entries }) => {
      const expanded = !collapsedGroups.has(label);
      return `
        <div class="anki-quick-group${expanded ? ' is-expanded' : ''}" data-group="${escapeAttr(label)}"
          data-group-id="${escapeAttr(id)}">
          <button class="anki-quick-group-head" type="button" aria-expanded="${expanded}"
            aria-keyshortcuts="Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
            title="Toggle ${escapeAttr(label)}; drag to reorder (Alt+Shift+Up/Down)">
            <span class="eyebrow">${escapeHtml(label)}</span>
            <svg class="icon" aria-hidden="true" focusable="false"><use href="#i-chevron-down"></use></svg>
          </button>
          <div class="anki-quick-group-body">
            ${entries.map(renderItem).join('')}
          </div>
        </div>
      `;
    };

    const renderPanel = () => {
      const html = quickGroups.filter(group => group.entries.length).map(renderGroup).join('');
      $quick.html(html || '<div class="empty-state compact">No quick searches available</div>');
    };

    // An empty choice means every deck; a saved selection omits deleted decks until the Settings list reloads.
    const listedDeckNames = () => visibleDeckNames(deckNames(), getSettings());

    const render = () => {
      quickGroups = groupOrder.map(id => {
        const group = groupById.get(id);
        return { id, label: group.label, entries: groupEntries(group, listedDeckNames(), modelNames(), tagNames) };
      });
      renderPanel();
    };
    const renderError = message => $quick.html(`<div class="empty-state compact">${escapeHtml(message)}</div>`);
    const refreshTags = async () => {
      const revision = ++tagRequest;
      try {
        const { tags } = await request('/api/anki/tags?select=tags&all=true');
        if (revision !== tagRequest) return;
        tagNames = tags;
        render();
      } catch { /* Keep the last successful tag list; the other quick searches still work. */ }
    };
    const ordersMatch = next => next.every((id, index) => id === groupOrder[index]);
    const reorderGroups = (sourceId, targetId, after) => {
      const next = moveGroupOrder(groupOrder, sourceId, targetId, after);
      if (ordersMatch(next)) return false;
      groupOrder = next;
      render();
      persistView();
      return true;
    };
    const clearGroupDropTarget = () => $quick.find('.is-quick-group-drop-before, .is-quick-group-drop-after')
      .removeClass('is-quick-group-drop-before is-quick-group-drop-after');
    const markGroupClickSuppressed = () => {
      suppressGroupClick = true;
      window.setTimeout(() => { suppressGroupClick = false; }, 0);
    };
    const groupAtPoint = event => document.elementFromPoint(event.clientX, event.clientY)
      ?.closest('#ankiQuickSearchList .anki-quick-group');
    const startGroupReorder = (event, head) => {
      if (event.button !== 0) return;
      const group = head.closest('.anki-quick-group');
      const sourceId = group.dataset.groupId;
      const { clientX: startX, clientY: startY, pointerId } = event;
      let dragging = false;
      let dropTarget = null;
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
        if (!dragging) {
          dragging = true;
          group.classList.add('is-quick-group-dragging');
          document.body.classList.add('is-reordering-quick-groups');
        }
        moveEvent.preventDefault();
        clearGroupDropTarget();
        dropTarget = null;
        const target = groupAtPoint(moveEvent);
        const targetId = target?.dataset.groupId;
        if (!target || targetId === sourceId) return;
        const { top, height } = target.getBoundingClientRect();
        const after = moveEvent.clientY > top + height / 2;
        dropTarget = { id: targetId, after };
        target.classList.add(after ? 'is-quick-group-drop-after' : 'is-quick-group-drop-before');
      };
      const stop = (stopEvent, commit) => {
        if (stopEvent.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', cancel);
        head.removeEventListener('lostpointercapture', cancel);
        window.removeEventListener('blur', cancelOnBlur);
        if (head.hasPointerCapture(pointerId)) head.releasePointerCapture(pointerId);
        clearGroupDropTarget();
        group.classList.remove('is-quick-group-dragging');
        document.body.classList.remove('is-reordering-quick-groups');
        if (!dragging) return;
        if (commit && dropTarget) reorderGroups(sourceId, dropTarget.id, dropTarget.after);
        if (commit) markGroupClickSuppressed();
      };
      const finish = stopEvent => stop(stopEvent, true);
      const cancel = stopEvent => stop(stopEvent, false);
      const cancelOnBlur = () => stop({ pointerId }, false);
      head.setPointerCapture(pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', cancel);
      head.addEventListener('lostpointercapture', cancel);
      window.addEventListener('blur', cancelOnBlur);
    };

    $quick.on('click', '.anki-quick-group-head', event => {
      if (suppressGroupClick) return;
      const label = $(event.currentTarget).closest('.anki-quick-group').data('group');
      if (collapsedGroups.has(label)) collapsedGroups.delete(label);
      else collapsedGroups.add(label);
      renderPanel();
      persistView();
    });

    $quick.on('click', '.anki-quick-item', event => {
      const query = $(event.currentTarget).data('query');
      $('#ankiQuery').val(query);
      loadNotes(query);
    });
    $quick.on('pointerdown', '.anki-quick-group-head', event => startGroupReorder(event, event.currentTarget));
    $quick.on('keydown', '.anki-quick-group-head', event => {
      if (!event.altKey || !event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const sourceId = event.currentTarget.closest('.anki-quick-group').dataset.groupId;
      const sourceIndex = groupOrder.indexOf(sourceId);
      const targetId = groupOrder[sourceIndex + (event.key === 'ArrowUp' ? -1 : 1)];
      if (!targetId) return;
      event.preventDefault();
      if (!reorderGroups(sourceId, targetId, event.key === 'ArrowDown')) return;
      requestAnimationFrame(() => $quick.find(`[data-group-id="${sourceId}"] .anki-quick-group-head`).trigger('focus'));
    });

    return {
      collapsedGroups: () => [...collapsedGroups], groupOrder: () => [...groupOrder], listedDeckNames,
      refreshTags, render, renderError,
    };
  };
  return {
    createQuickSearch, escapeSearchValue, groupEntries, moveGroupOrder, namedEntry, normalizeGroupOrder,
    searchPrefixes, visibleDeckNames,
  };
});
