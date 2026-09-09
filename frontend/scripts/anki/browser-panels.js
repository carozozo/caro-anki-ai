((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserPanels = api;
})(globalThis, () => {
  // The two side panels share one resizer model: an inline CSS var holds the expanded width, while collapsing
  // swaps in a rail track and leaves that var untouched so the width survives toggling. The widget owns its
  // own elements and the keys it persists under, so the page hands it the panel, config, and shortcut registry.
  const createBrowserPanels = ({ $, config, $panel, NoteShortcuts }) => {
    const browserBody = document.querySelector('.anki-browser-body');
    const leftSplitter = document.querySelector('.anki-splitter[data-anki-splitter="left"]');
    if (!browserBody || !leftSplitter) return null;
    const { handle, minQuick, minChat, minContent, keyStep, keyStepFast } = config.ankiBrowser.panelResizer;
    const widthsKey = config.storageKeys.ankiBrowserWidths;
    const panels = {
      quick: {
        splitter: leftSplitter, toggle: $('#toggleAnkiQuickSearch'),
        cssVar: '--anki-quick-panel', selector: '.anki-quick-search', anchor: 'left', min: minQuick,
        collapsedClass: 'is-quick-collapsed', collapsedKey: config.storageKeys.ankiQuickSearchCollapsed,
        shortcut: 'toggle-quick-search', label: 'quick search',
        neighbours: ['.anki-splitter[data-anki-splitter="right"]', '.anki-chat'],
      },
      chat: {
        splitter: document.querySelector('.anki-splitter[data-anki-splitter="right"]'),
        toggle: $('#collapseChat'),
        cssVar: '--anki-chat-panel', selector: '.anki-chat', anchor: 'right', min: minChat,
        collapsedClass: 'is-chat-collapsed', collapsedKey: config.storageKeys.chatCollapsed,
        shortcut: 'toggle-chat', label: 'Anki Agent',
        neighbours: ['.anki-splitter[data-anki-splitter="left"]', '.anki-quick-search'],
      },
    };
    const widthOf = selector => {
      const element = browserBody.querySelector(selector);
      return element ? element.getBoundingClientRect().width : 0;
    };
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    const storedWidth = panel => {
      const value = parseFloat(browserBody.style.getPropertyValue(panel.cssVar));
      return Number.isFinite(value) ? Math.round(value) : null;
    };
    const expandedWidth = panel => storedWidth(panel) ?? Math.round(widthOf(panel.selector));
    const setWidth = (panel, value) =>
      browserBody.style.setProperty(panel.cssVar, `${Math.round(value)}px`);
    const isCollapsed = panel => browserBody.classList.contains(panel.collapsedClass);
    // A resize may never squeeze the remaining content below minContent.
    const limit = (panel, value) => clamp(value, panel.min, browserBody.getBoundingClientRect().width
      - handle - minContent - panel.neighbours.reduce((total, selector) => total + widthOf(selector), 0));
    const persist = () => localStorage.setItem(widthsKey,
      JSON.stringify(Object.fromEntries(Object.entries(panels)
        .map(([name, panel]) => [name, expandedWidth(panel)]))));

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const renderToggleLabel = (panel, collapsed) => {
      const shortcut = NoteShortcuts.find(panel.shortcut);
      const action = `${collapsed ? 'Expand' : 'Collapse'} ${panel.label}`;
      panel.toggle.attr({
        'aria-expanded': String(!collapsed),
        'aria-keyshortcuts': NoteShortcuts.aria(shortcut),
        'aria-label': `${action} (${NoteShortcuts.display(shortcut, isMac)})`,
        title: `${action} (${NoteShortcuts.display(shortcut, isMac)})`,
      });
    };
    const applyCollapsed = (panel, collapsed) => {
      if (collapsed && storedWidth(panel) === null) setWidth(panel, widthOf(panel.selector));
      browserBody.classList.toggle(panel.collapsedClass, collapsed);
      renderToggleLabel(panel, collapsed);
      localStorage.setItem(panel.collapsedKey, collapsed ? '1' : '0');
    };

    const drag = (panel, event) => {
      event.preventDefault();
      const apply = moveEvent => {
        const rect = browserBody.getBoundingClientRect();
        const pointer = panel.anchor === 'left'
          ? moveEvent.clientX - rect.left
          : rect.right - moveEvent.clientX - handle;
        setWidth(panel, limit(panel, pointer));
      };
      panel.splitter.classList.add('active');
      document.body.classList.add('is-resizing');
      document.addEventListener('pointermove', apply);
      document.addEventListener('pointerup', () => {
        document.removeEventListener('pointermove', apply);
        panel.splitter.classList.remove('active');
        document.body.classList.remove('is-resizing');
        persist();
      }, { once: true });
    };

    const nudge = (panel, event) => {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      event.preventDefault();
      const delta = (panel.anchor === 'left' ? step : -step) * (event.shiftKey ? keyStepFast : keyStep);
      setWidth(panel, limit(panel, expandedWidth(panel) + delta));
      persist();
    };

    const reset = panel => {
      browserBody.style.removeProperty(panel.cssVar);
      localStorage.removeItem(widthsKey);
    };

    const normalize = () => {
      if (window.matchMedia('(max-width: 720px)').matches) return;
      Object.values(panels).forEach(panel => {
        if (!isCollapsed(panel)) setWidth(panel, limit(panel, expandedWidth(panel)));
      });
    };

    Object.values(panels).forEach(panel => {
      if (!panel.splitter) return;
      panel.splitter.addEventListener('pointerdown', event => drag(panel, event));
      panel.splitter.addEventListener('keydown', event => nudge(panel, event));
      panel.splitter.addEventListener('dblclick', () => reset(panel));
      panel.toggle.on('click', () => {
        applyCollapsed(panel, !isCollapsed(panel));
        normalize();
      });
    });
    $(document).on('anki-shortcuts-changed', () => {
      Object.values(panels).forEach(panel => renderToggleLabel(panel, isCollapsed(panel)));
    });

    const saved = JSON.parse(localStorage.getItem(widthsKey) || 'null') || {};
    Object.entries(panels).forEach(([name, panel]) => {
      if (saved[name]) setWidth(panel, saved[name]);
      applyCollapsed(panel, localStorage.getItem(panel.collapsedKey) === '1');
    });
    $panel.on('show-chat', () => applyCollapsed(panels.chat, false));
    $panel.on('open-browser-panels', normalize);
    window.addEventListener('resize', normalize);

    return { normalize };
  };

  return { createBrowserPanels };
});
