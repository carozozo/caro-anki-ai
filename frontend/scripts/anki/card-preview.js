((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardPreview = api;
})(globalThis, () => {
  const previewIndex = (notes, selectedIds) => notes.findIndex(note => !selectedIds.size || selectedIds.has(note.id));
  const previewKeyboardInit = (data, type) => {
    if (!data || data.type !== type || typeof data.key !== 'string') return null;
    const init = {
      bubbles: true,
      cancelable: true,
      key: data.key,
      code: typeof data.code === 'string' ? data.code : '',
      altKey: data.altKey === true,
      ctrlKey: data.ctrlKey === true,
      metaKey: data.metaKey === true,
      shiftKey: data.shiftKey === true,
    };
    return init.metaKey || init.ctrlKey || init.key === 'Escape' ? init : null;
  };

  // The card preview dialog is a reader of the loaded list order, and the page follows it: the card on screen
  // is the note the page's own actions act on, so walking cards moves the selected row as it goes — in place,
  // never by re-rendering the table — and an open editor reads the same note in itself, because there the
  // editor is what shows the page. Both landings are the one the list already navigates with, so leaving an
  // edited note for the next card writes it first exactly as any other way out of the editor does.
  const createCardPreview = ({
    $, config, request, CaroUI, createDialog, CardDocument, notes, selectedIds,
    landOnIndex, isBusy,
  }) => {
    const { optionsHtml } = CaroUI.fields;
    const { escapeHtml, formatCount } = CaroUI.text;
    const { previewKeyboardEventType } = CardDocument;
    const MODES = [
      { value: 'back', label: 'Back only' },
      { value: 'full', label: 'Front and back' },
    ];
    // The library Anki's own card webview supplies, which every template's script is written against.
    const SCRIPT_SRC = config.ankiBrowser.cardPreview.scriptSrc;
    const cache = new Map();
    // The landings still in flight, and the generation the open dialog reads in: a prefetch that answers
    // after the dialog closed never lands in the cache the next opening re-reads.
    const pending = new Map();
    let generation = 0;
    // `at` is the cursor: the note on screen, plus which of that note's sides counts as a step under the
    // current mode.
    let at = { index: -1, step: 0 };
    let mode = MODES[0].value;
    let token = 0;
    const currentNote = () => notes()[at.index];
    const current = () => cache.get(currentNote()?.id);
    const previewFrame = () => $('#ankiCardPreviewContent .anki-card-preview-frame')[0];
    window.addEventListener('message', event => {
      const init = previewKeyboardInit(event.data, previewKeyboardEventType);
      const frame = previewFrame();
      if (!init || event.source !== frame?.contentWindow) return;
      frame.dispatchEvent(new KeyboardEvent('keydown', init));
    });
    // One step per card in the back-only mode, two in the full mode with the front first, so Next walks a
    // card's front into that same card's back before it walks on to the next note.
    const steps = cards => (mode === 'full'
      ? cards.flatMap((_, card) => [[card, 'front'], [card, 'back']])
      : cards.map((_, card) => [card, 'back']));
    const stepsOf = () => steps(current()?.cards || []);
    // The card page itself — the shell, the library it loads, and the surface it states — is `CardDocument`'s.
    const message = (className, text) =>
      $('#ankiCardPreviewContent').html(`<p class="${className}">${escapeHtml(text)}</p>`);

    const renderNav = () => {
      const list = notes();
      const atFirst = at.index <= 0 && at.step <= 0;
      const atLast = at.index >= list.length - 1 && at.step >= stepsOf().length - 1;
      $('#ankiPreviewFirst, #ankiPreviewPrevious').prop('disabled', atFirst);
      $('#ankiPreviewNext, #ankiPreviewLast').prop('disabled', atLast);
      $('#ankiPreviewPosition').text(at.index < 0
        ? ''
        : `${formatCount(at.index + 1)} / ${formatCount(list.length)}`);
    };

    // One card side is on screen at a time, and it keeps its frame: re-creating that frame empties the card
    // area and resizes the dialog around the button being clicked, which is the flash a step must not have.
    // A new `srcdoc` on the frame it already has leaves the card being read painted until the next one is.
    const render = () => {
      const preview = current();
      const [cardIndex, side] = stepsOf()[at.step] || [];
      const card = preview?.cards?.[cardIndex];
      $('#ankiCardPreviewTitle').text(preview ? `${preview.modelName} · Card preview` : 'Card preview');
      renderNav();
      const $content = $('#ankiCardPreviewContent');
      if (!card) {
        $content.empty().html('<p class="dialog-help">This note has no cards.</p>');
        return;
      }
      const name = card.templateName || `Card ${cardIndex + 1}`;
      const label = side === 'front' ? 'Front' : 'Back';
      $content.children(':not(.anki-card-preview-card)').remove();
      let $card = $content.children('.anki-card-preview-card');
      if (!$card.length) {
        $card = $('<article class="anki-card-preview-card">')
          .append($('<h3>'))
          .append($('<section class="anki-card-preview-side">')
            .append($('<h4>'))
            // The card's template is user data, so it gets a document of its own with an opaque origin: it
            // runs its own scripts and reaches nothing of this page.
            .append('<iframe class="anki-card-preview-frame" sandbox="allow-scripts"></iframe>'))
          .appendTo($content);
      }
      const $side = $card.children('.anki-card-preview-side');
      $card.children('h3').text(name);
      $side.children('h4').text(label);
      const $frame = $side.children('.anki-card-preview-frame');
      $frame.attr('title', `${name} ${label}`);
      $frame[0].srcdoc = CardDocument.previewDocument({ html: card[side], scriptSrc: SCRIPT_SRC });
    };

    // A cached landing answers with no request, and the neighbours are loaded while the card on screen is
    // being read, so a step normally paints straight from the cache instead of waiting on the collection.
    const load = async id => {
      if (cache.has(id)) return cache.get(id);
      if (!pending.has(id)) {
        const read = generation;
        pending.set(id, request(`/api/anki/notes/${encodeURIComponent(id)}/preview`)
          .then(({ preview }) => {
            if (read === generation) cache.set(id, preview);
            return preview;
          })
          .finally(() => pending.delete(id)));
      }
      return pending.get(id);
    };

    const prefetch = index => {
      [index + 1, index - 1].forEach(neighbour => {
        const note = notes()[neighbour];
        if (note && !cache.has(note.id)) load(note.id).catch(() => {});
      });
    };

    // `edge` is where in the landing note the cursor starts — its first side going forward, its last going
    // back — which is why that note's own preview is loaded before the step can be clamped.
    const show = async (index, edge = 'first') => {
      const note = notes()[index];
      if (!note) return;
      const requestToken = ++token;
      at = { index, step: 0 };
      $('#ankiCardPreviewTitle').text('Card preview');
      // Only a cold dialog states that it is waiting: a step keeps the card being read on screen until its
      // successor has rendered, so moving between cards never flashes an empty frame.
      if (!$('#ankiCardPreviewContent').children().length) message('dialog-help', 'Loading…');
      renderNav();
      let preview;
      try {
        preview = await load(note.id);
      } catch (error) {
        if (requestToken === token) message('system-message is-error', error.message);
        return;
      }
      if (requestToken !== token) return;
      const sides = steps(preview.cards);
      at = { index, step: edge === 'last' ? Math.max(sides.length - 1, 0) : 0 };
      // The page follows the card only once it is painted, so the card never waits on the editor's own read of
      // the note it is about to show.
      render();
      prefetch(index);
      await landOnIndex(index);
    };

    // The sides of the note on screen first, then the neighbouring note that follows them in the same
    // direction, so one offset covers Prev/Next and both jumps.
    const move = async offset => {
      if (isBusy() || at.index < 0) return;
      const step = at.step + offset;
      if (step >= 0 && step < stepsOf().length) {
        at = { ...at, step };
        render();
        return;
      }
      const index = at.index + offset;
      if (index < 0 || index >= notes().length) return;
      await show(index, offset > 0 ? 'first' : 'last');
    };

    const jump = edge => {
      if (isBusy() || !notes().length) return undefined;
      return show(edge < 0 ? 0 : notes().length - 1, edge < 0 ? 'first' : 'last');
    };

    const open = async () => {
      const selected = selectedIds();
      if (isBusy()) return;
      const index = previewIndex(notes(), selected);
      if (index < 0) return;
      cache.clear();
      mode = MODES[0].value;
      $('#ankiPreviewMode').val(mode);
      dialog.open();
      await show(index);
    };

    const dialog = createDialog({
      selector: '#ankiCardPreviewDialog',
      // Closing ends the walk: a landing still in flight must not render into the dialog it left, and the
      // next opening re-reads the selected note.
      onClose: () => {
        token++;
        generation++;
        at = { index: -1, step: 0 };
        cache.clear();
        $('#ankiCardPreviewContent').empty();
        $('#ankiPreviewPosition').text('');
      },
    });

    $('#ankiPreviewNote').on('click', open);
    $('#ankiPreviewFirst').on('click', () => jump(-1));
    $('#ankiPreviewPrevious').on('click', () => move(-1));
    $('#ankiPreviewNext').on('click', () => move(1));
    $('#ankiPreviewLast').on('click', () => jump(1));
    $('#ankiPreviewMode').html(optionsHtml(MODES)).val(mode)
      .on('change', event => {
        mode = event.currentTarget.value;
        if (at.index < 0) return;
        // A mode opens on its own first side: the back alone, or the front of the card on screen.
        at = { ...at, step: 0 };
        render();
      });

    return { open, isOpen: () => dialog.isOpen(), contains: node => dialog.$element[0].contains(node) };
  };

  return { createCardPreview, previewIndex, previewKeyboardInit };
});
