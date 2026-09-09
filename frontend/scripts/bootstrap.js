(() => {
  const scripts = [
    'https://code.jquery.com/jquery-3.7.1.min.js',
    '/scripts/core/ui-config.js',
    '/scripts/core/ui-kit.js',
    '/scripts/chat/markdown.js',
    '/scripts/chat/chat-stream.js',
    '/scripts/chat/skill-menu.js',
    '/scripts/anki/note-list-state.js',
    '/scripts/anki/note-selection.js',
    '/scripts/core/browser-state.js',
    '/scripts/anki/note-shortcuts.js',
    '/scripts/anki/card-document.js',
    '/scripts/anki/browser-panels.js',
    '/scripts/anki/query-history.js',
    '/scripts/anki/quick-search.js',
    '/scripts/anki/note-list-columns.js',
    '/scripts/anki/note-browser-state.js',
    '/scripts/anki/note-list-view.js',
    '/scripts/anki/study-options-dialog.js',
    '/scripts/anki/deck-studio.js',
    '/scripts/anki/tag-studio.js',
    '/scripts/anki/note-type-studio.js',
    '/scripts/anki/card-preview.js',
    '/scripts/anki/batch-dialog.js',
    '/scripts/anki/find-replace-dialog.js',
    '/scripts/anki/note-list-input.js',
    '/scripts/anki/note-editor.js',
    '/scripts/core/api-client.js',
    '/scripts/anki/sync-controller.js',
    '/scripts/settings/library-names.js',
    '/scripts/settings/agent-settings.js',
    '/scripts/settings/anki-defaults.js',
    '/scripts/settings/anki-maintenance.js',
    '/scripts/settings/anki-profiles.js',
    '/scripts/settings/list-fields.js',
    '/scripts/settings/library-editor.js',
    '/scripts/settings/shortcut-settings.js',
    '/scripts/settings/settings-dialogs.js',
    '/scripts/chat/chat-controller.js',
    '/scripts/anki/anki-browser.js',
    '/scripts/app.js',
  ];

  const loadPartial = async placeholder => {
    const response = await fetch(placeholder.dataset.partial);
    if (!response.ok) throw new Error(`Could not load ${placeholder.dataset.partial}`);
    const fragment = document.createRange().createContextualFragment(await response.text());
    placeholder.replaceWith(fragment);
  };

  const loadScript = src => new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), {
      src, async: false, onload: resolve, onerror: reject,
    });
    document.head.append(script);
  });

  const showError = error => {
    const message = document.createElement('p');
    message.className = 'system-message is-error';
    message.textContent = `Unable to start Caro Anki: ${error.message}`;
    document.body.append(message);
  };

  (async () => {
    try {
      await Promise.all([...document.querySelectorAll('template[data-partial]')].map(loadPartial));
      for (const src of scripts) await loadScript(src);
    } catch (error) { showError(error); }
  })();
})();
