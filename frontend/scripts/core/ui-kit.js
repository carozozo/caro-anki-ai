/**
 * Caro Anki UI kit — the single implementation of every interactive control in the app.
 *
 * Component families (behaviour here, base style in the "UI KIT" section of styles.css):
 *   icons    `icon(name)` / `iconButton({...})` — every icon is a `<symbol>` in index.html's sprite.
 *   fields   `autoGrow` / `setTextareaValue` / `optionsHtml` / `fillOptions` / `renderEntityPicker` /
 *            `pickerRow` — one skeleton (`.field`) for every input, select and textarea, the one way a
 *            select's options are written (only when they changed), the one way an `entityManager` fills
 *            a select, the one-row picker a studio picks, makes, renames and deletes an entity from, plus
 *            the Anki field readers both list and editor share.
 *   status   `setSystemMessage($el, text, kind)` — one status vocabulary (`.system-message.is-*`), with
 *            non-error messages clearing after the shared delay, a `pending` sentence held back for its own
 *            grace period so a wait worth announcing is the only one that shows, and an `onClear` hook for a
 *            line that has a baseline to go back to.
 *   confirm  `armed(...)` — the two-step arming every destructive control must use, in the
 *            destructive red by default or a caller's own `armedClass` for a non-destructive one.
 *   dialogs  `create({selector, onOpen, onClose, dismissible})` — the one place that opens/closes a
 *            `<dialog>`, including Escape, backdrop and `[data-dialog-close]` dismissal; a
 *            `dismissible: false` window (a sync in flight) can only be closed by code.
 *
 * Loaded before app.js; exposes `window.CaroUI` (or `module.exports` under Node for tests).
 */
((root, $, config, factory) => {
  const api = factory($, config);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroUI = api;
})(globalThis, typeof jQuery === 'function' ? jQuery : null,
  typeof window === 'object' ? window.CARO_AI_UI_CONFIG : null, ($, config) => {
  const STATUS_KINDS = ['pending', 'ok', 'warn', 'error'];
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  const TERM_FIELD = /^(詞彙|term)$/i;
  const MEANING_FIELD = /^(意思|meaning)$/i;
  const text = value => String(value ?? '');
  const escapeHtml = value => text(value).replace(/[&<>]/g, char => HTML_ESCAPES[char]);
  const escapeAttr = value => escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const plainText = value => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const pad = value => String(value).padStart(2, '0');
  // A count reads at a glance only once it is grouped ("30000" -> "30,000"), so every number the page shows
  // goes through here, in the app's own locale so the separator is the one the user reads everywhere else.
  const formatCount = value => Number(value || 0).toLocaleString(config?.locale || undefined);
  const formatDateTime = value => {
    if (value == null) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—'
      : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  // Collection fields reach the frontend in two shapes: the Agent's `{name: {value}}` (read/create/update)
  // and the browser's `[{name, value}]`. Both readers accept either.
  const fieldValue = (fields, matcher) => {
    if (Array.isArray(fields)) return plainText(fields.find(field => matcher.test(field.name))?.value);
    const [, value] = Object.entries(fields || {}).find(([name]) => matcher.test(name)) || [];
    return plainText(value?.value ?? value);
  };
  const termFromFields = (fields, sortField = '') => fieldValue(fields, TERM_FIELD) || sortField || '';
  const meaningFromFields = fields => fieldValue(fields, MEANING_FIELD);
  const noteTerm = note => note.term || termFromFields(note.fields, note.sortField);
  const noteMeaning = note => note.meaning || meaningFromFields(note.fields);

  // Icons are `<symbol>`s in the sprite at the top of index.html; never inline a path twice.
  const icon = name => `<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
  const iconButton = ({ className = '', icon: name, label, title = label, attributes = '' }) =>
    `<button class="button button-quiet button-icon ${className}" ${attributes} type="button"
      aria-label="${escapeAttr(label)}" title="${escapeAttr(title)}">${icon(name)}</button>`;
  // A removable pill: the note editor's tag chips and the composer's pinned skill are one control — the chip
  // is its own remove button, so neither needs a second clear control beside it.
  const chipButton = ({ text, label, title, data = {} }) => `<button class="anki-tag-chip"${
    Object.entries(data).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('')} type="button"
    aria-label="${escapeAttr(label)}" title="${escapeAttr(title)}">${escapeHtml(text)}${icon('close')}</button>`;

  // Textareas start at one row and grow with their content up to the CSS max-height, after which they
  // scroll. The height is scrollHeight plus the borders (box-sizing is border-box), so the field also
  // shrinks again when text is removed.
  const autoGrow = $textarea => {
    const element = $textarea[0];
    if (!element) return;
    const limit = parseFloat(window.getComputedStyle(element).maxHeight) || Infinity;
    element.style.overflowY = 'hidden';
    element.style.height = 'auto';
    const height = element.scrollHeight + (element.offsetHeight - element.clientHeight);
    element.style.height = `${Math.min(height, limit)}px`;
    element.style.overflowY = height > limit ? 'auto' : 'hidden';
  };
  const setTextareaValue = ($textarea, value) => {
    $textarea.val(text(value));
    autoGrow($textarea);
  };
  // Every select in the app renders its options through this one helper; the caller picks the value
  // with `.val(...)`, so no option carries a `selected` attribute.
  const optionsHtml = (items, { value = item => item?.value ?? item, label = item => item?.label ?? item } = {}) =>
    items.map(item => `<option value="${escapeAttr(value(item))}">${escapeHtml(label(item))}</option>`).join('');
  // Writing a select's options is a visible repaint: the browser redraws the control, and a focus, a scroll
  // position or an open popup it holds is lost. So the markup is compared with what that element already
  // shows and only a real change is written — a picker that repaints every keystroke of an unrelated save
  // stands perfectly still, because the list it would write is the one already there. The chosen value and
  // the disabled state are applied by the caller every time, because they are cheap and invisible.
  const optionMarkup = new WeakMap();
  const fillOptions = ($select, markup) => {
    const element = $select[0];
    if (element && optionMarkup.get(element) === markup) return $select;
    $select.html(markup);
    if (element) optionMarkup.set(element, markup);
    return $select;
  };
  // The select half of `entityManager`: one manager's items ARE the options and its selection IS the current
  // value, so a studio can never render the two out of step. Only the option label is worth customising (a
  // note type shows its field and card counts), `selectedId` is for a picker whose value is not the manager's
  // selection, and `leading` is the entry no manager holds — a row's own "new…" choice, which leads the list
  // because it is the one entry that is not an entity. It is a value like any other, so the picker that offers
  // it reads its own value instead of the manager's selection.
  const renderEntityPicker = ($select, manager,
    { value, label, selectedId = manager.selectedId(), disabled = false, leading = [] } = {}) => fillOptions($select,
    optionsHtml(leading, { value: option => option.value, label: option => option.label })
      + optionsHtml(manager.items(), { value, label }))
    .val(selectedId ?? '')
    .prop('disabled', Boolean(disabled));

  const statusTimers = new WeakMap();
  const clearSystemMessageTimer = $element => {
    const element = $element[0];
    const timer = statusTimers.get(element);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    statusTimers.delete(element);
  };
  const paintSystemMessage = ($element, value, kind, { persistent = false, onClear } = {}) => {
    $element.removeClass(STATUS_KINDS.map(name => `is-${name}`).join(' '))
      .addClass(kind ? `is-${kind}` : '')
      .text(value);
    if (!value || kind === 'error' || persistent) return $element;
    const element = $element[0];
    const timer = globalThis.setTimeout(() => {
      if (statusTimers.get(element) !== timer) return;
      statusTimers.delete(element);
      paintSystemMessage($element, '', '');
      onClear?.();
    }, config?.timings?.systemMessageMs ?? 3000);
    statusTimers.set(element, timer);
    return $element;
  };
  // A `pending` sentence is a wait the user is told about, so it is held back for the shared grace period and
  // painted only if the work is still running when that elapses: a write that finishes in a blink then shows
  // its result alone instead of flashing "Saving…" and replacing it in the same frame. Every message shares
  // the one timer slot, so the result (or an error) cancels the sentence it would have interrupted, and a
  // persistent status is state rather than a wait, which is why it is never held back. `onClear` is for a line
  // that has a baseline — the browser's status says which notes are on screen — so a transient sentence hands
  // the line back instead of leaving it blank.
  const setSystemMessage = ($element, value, kind = '', { persistent = false, delay, onClear } = {}) => {
    clearSystemMessageTimer($element);
    const wait = delay ?? (kind === 'pending' ? config?.timings?.pendingDelayMs ?? 0 : 0);
    if (wait <= 0 || !value || kind === 'error' || persistent) {
      return paintSystemMessage($element, value, kind, { persistent, onClear });
    }
    const element = $element[0];
    const timer = globalThis.setTimeout(() => {
      if (statusTimers.get(element) !== timer) return;
      statusTimers.delete(element);
      return paintSystemMessage($element, value, kind, { persistent, onClear });
    }, wait);
    statusTimers.set(element, timer);
    return $element;
  };
  const bindEnterToClick = ($input, $button) => $input.on('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if ($button.prop('disabled')) return;
    $button.trigger('click');
  });

  // The one-row picker: a studio picks an entity, makes one, renames it and deletes it from a single control
  // instead of from four controls stacked down the dialog. The row has three modes — the list, the open
  // entity's name, and a name for a new one — and the mode is the row's own state, because keeping it in step
  // with the six elements it shows and hides is exactly what every caller would otherwise repeat. A caller
  // states only what its own dialog needs: which elements the row drives, the noun it names them with, how a
  // write is performed, and what the saved sentence says.
  //
  // `entity` is that noun and it carries every label ("deck" → "Create a deck" from the list, "Rename deck"
  // and "Create deck" for the two writes), and every icon is the sprite's own: a pencil for the list's rename
  // step, a plus for the entry that is not an entity, and a check for the write itself. `article` is what the
  // list's create step puts in front of that noun; only the one label without an entity to name states it, so a
  // noun that takes no article ("study options" → "Create study options") passes an empty one. `isReady` is
  // the caller's own guard against a write already in flight, `run` is the one way it writes (so the row
  // inherits its status line and its queue), and `messages` is what the two writes are called once they land.
  //
  // `option` is what the row reads off an entity: `value` and `label` are the list's own (they are
  // `renderEntityPicker`'s), and `name` is the third thing an entity has — the one its form edits, which is the
  // key for a studio and a separate field for the one list that is not named by its key. The form opens on that
  // name, the sentence a rename saves states it, and a name the user did not change is not a write at all.
  //
  // A registry-backed list without a standalone create operation passes `create: null`. Two other things a
  // caller adds to that shape: `arm`, for a rename that cannot be taken back — a collection
  // profile's rename moves a folder — asks for that press twice, stating `arm.hint(name)` on the button in
  // between while a new entity is still a single press; `onMode`, where the caller shows and hides the elements
  // that belong to one mode rather than to the row (a panel only the list shows, a field only a new entity
  // needs), and `stay`, naming the controls it showed that way. A form is left by its own input, so a control a
  // form owns is not a way out of it: without `stay`, moving the focus onto that field would read as the user
  // abandoning the form. `canCommit` lets a caller whose create form owns details outside the row validate those
  // details before the row makes its write.
  const pickerRow = ({
    manager, ids, sentinel, entity, run,
    article = 'a',
    option = {}, isReady = () => true, canCommit = () => true,
    create = name => manager.create(name),
    rename = (from, name) => manager.rename(from, name),
    messages = {},
    arm = null,
    stay = [],
    onPick = () => {},
    onMode = () => {},
  }) => {
    const $select = $(ids.select);
    const $rename = $(ids.rename);
    const $create = $(ids.create);
    const $confirm = $(ids.confirm);
    const $back = $(ids.back);
    const $buttons = $confirm.add($back);
    const $stay = $(stay.length ? stay.join(', ') : null);
    const $form = () => (mode === 'create' ? $create : $rename);
    const saved = {
      created: messages.created || (name => `Created ${name}`),
      renamed: messages.renamed || ((from, name) => `Renamed ${from} to ${name}`),
    };
    const valueOf = option.value || (item => item?.value ?? item);
    const labelOf = option.label || (item => item?.label ?? item);
    const nameOf = option.name || (item => item?.name ?? item);
    const named = `${article ? `${article} ` : ''}${entity}`;
    const canCreate = typeof create === 'function';
    let mode = 'pick';
    const controls = () => {
      const ready = isReady();
      const open = manager.selectedId();
      return {
        open,
        selectDisabled: !ready || (!canCreate && !manager.items().length),
        confirmDisabled: !ready || (mode === 'pick' && (open == null ? !canCreate : !manager.canRename())),
      };
    };
    const syncReady = () => {
      const { selectDisabled, confirmDisabled } = controls();
      $select.prop('disabled', selectDisabled);
      $confirm.prop('disabled', confirmDisabled);
    };

    // What the list holds while it shows: the open entity, or, where creation is available, the entry that
    // makes the first one. That entry is a choice and never an id, so only the list reads the selection.
    const render = () => {
      const picking = mode === 'pick';
      const { open, selectDisabled, confirmDisabled } = controls();
      const shown = picking ? open ?? (canCreate ? sentinel : null) : null;
      renderEntityPicker($select, manager, {
        value: valueOf, label: labelOf, disabled: selectDisabled,
        selectedId: shown,
        leading: canCreate ? [{ value: sentinel, label: sentinel }] : [],
      });
      $select.prop('hidden', !picking);
      $rename.prop('hidden', mode !== 'rename');
      $create.prop('hidden', mode !== 'create');
      $back.prop('hidden', picking);
      if (ids.remove) $(ids.remove).prop('hidden', !picking);
      const step = picking
        ? open == null ? canCreate ? { icon: 'plus', label: `Create ${named}` }
          : { icon: 'pencil', label: `No ${entity} to rename` }
          : { icon: 'pencil', label: `Rename ${nameOf(manager.selected())}` }
        : { icon: 'check-circle', label: `${mode === 'rename' ? 'Rename' : 'Create'} ${entity}` };
      // An entity whose own guard refuses a rename says so on the button that would take the step — the bridge
      // refuses it anyway, so the row must not offer it.
      $confirm.attr({ 'aria-label': step.label, title: step.label })
        .prop('disabled', confirmDisabled)
        .find('use').attr('href', `#i-${step.icon}`);
      onMode(mode);
    };

    const toPicker = () => { mode = 'pick'; disarm(); render(); };
    const enter = next => {
      mode = next;
      disarm();
      if (next === 'create') $create.val('');
      if (next === 'rename') $rename.val(nameOf(manager.selected()) ?? '');
      render();
      $form().trigger('focus').trigger('select');
    };

    // A form is left the way it is opened, by its own input, so a name the user changed nothing in simply
    // gives the list back instead of writing. A write that lands is what returns to the list — a failed one
    // keeps the name on screen to correct, which is why the return rides inside the write's own success.
    const commit = async () => {
      if (!isReady()) return;
      if (mode === 'pick') {
        enter($select.val() === sentinel ? 'create' : 'rename');
        return;
      }
      if (mode === 'create') {
        if (!canCreate) { toPicker(); return; }
        const name = $create.val().trim();
        if (!name) { toPicker(); return; }
        if (!canCommit(mode)) return;
        await run(() => create(name), saved.created(name),
          { onSaved: () => { $create.val(''); toPicker(); } });
        return;
      }
      const open = manager.selectedId();
      const name = $rename.val().trim();
      // The name the form opened on is read before the write, so a form nobody edited is the list coming back
      // rather than a rename to the name it already has, and the sentence afterwards can state what it was.
      const previous = nameOf(manager.selected());
      if (open == null || !name || name === previous) { toPicker(); return; }
      await run(() => rename(open, name), saved.renamed(previous, name), { onSaved: toPicker });
    };

    bindEnterToClick($rename, $confirm);
    bindEnterToClick($create, $confirm);
    // Choosing an entity is a read, so it opens that one at once. The entry that is not an entity is a choice
    // with nothing to name it after, so choosing it opens the form for a new one itself rather than leaving a
    // marked list for a second click on the confirm button.
    $select.on('change', event => {
      if (canCreate && event.currentTarget.value === sentinel) { enter('create'); return; }
      manager.select(event.currentTarget.value);
      onPick(event.currentTarget.value);
      render();
    });
    // A write that cannot be taken back is asked for twice: the first press states what the second one does and
    // writes nothing. Only a rename is armed — it renames something that already exists — because the list's own
    // press merely opens a form and a new entity has nothing to lose yet.
    const askedTwice = arm ? armed(() => commit(), { armedClass: arm.className }) : null;
    $confirm.on('click', event => (askedTwice && mode === 'rename'
      ? askedTwice.handle(event, arm.hint($form().val().trim()))
      : commit()));
    $back.on('click', () => { if (isReady()) toPicker(); });
    // Leaving a form is what focus does: the row is left when the focus moves off a control the form owns onto
    // something that is not one, and a press on either button is cancelled before it can move the focus at all,
    // so only a real move is judged. `stay` is how a form says which other controls are its own.
    const owns = element => $form().is(element) || $buttons.is(element) || $stay.is(element);
    $buttons.on('mousedown', event => event.preventDefault());
    $rename.add($create).add($stay).on('blur', event => {
      if (mode === 'pick' || !isReady()) return;
      if (!owns(event.currentTarget) || owns(event.relatedTarget)) return;
      toPicker();
    });

    return { mode: () => mode, render, syncReady, toCreate: () => { if (canCreate) enter('create'); }, toPicker };
  };

  // Two-step confirm for every destructive control: the first click arms the button — danger styling
  // plus a "click again" hint — and a second click on that same button within confirmArmMs runs its
  // action. Only one control can be armed at a time and each button's own label and title are
  // restored whenever the armed state clears. `armedClass` inks the armed state; the destructive red
  // is the default, and a control whose second click cannot lose data passes its own variant (e.g.
  // `button-confirm`) so the hint is never read as a delete.
  let armedButton = null;
  let armedClass = 'button-danger';
  let armedTimer;
  const disarm = () => {
    window.clearTimeout(armedTimer);
    if (!armedButton) return;
    armedButton.removeClass(armedClass)
      .attr('aria-label', armedButton.data('originalLabel'))
      .attr('title', armedButton.data('originalTitle'));
    armedButton = null;
  };
  const armed = (onConfirm, { armedClass: style = 'button-danger' } = {}) => ({
    handle: (event, armLabel) => {
      const $button = $(event.currentTarget);
      if (armedButton && armedButton[0] === event.currentTarget) {
        disarm();
        return onConfirm($button);
      }
      disarm();
      armedButton = $button;
      armedClass = style;
      $button.data({ originalLabel: $button.attr('aria-label'), originalTitle: $button.attr('title') })
        .addClass(style).attr('aria-label', armLabel).attr('title', armLabel);
      armedTimer = window.setTimeout(disarm, config.timings.confirmArmMs);
      return undefined;
    },
  });

  // Every modal is a native <dialog> opened and closed here, so dismissal behaves identically
  // everywhere: Escape, a backdrop click, or any `[data-dialog-close]` button. The Escape listener is a
  // document CAPTURE listener registered before every page shortcut and it stops the event, so an open
  // dialog never also triggers the action behind it (e.g. leaving the note editor). `onOpen` runs before
  // `showModal()`; `onClose` is the reset hook and also runs for a close of a dialog that is not open.
  const dialogs = [];
  const topDialog = () => [...dialogs].reverse().find(dialog => dialog.isOpen()) ?? null;
  // `dismissible: false` is for a window that reports work the user must not interrupt (a sync holding the
  // collection): no key, click or button closes it, only code. A dismissible dialog is the norm.
  const createDialog = ({ selector, onOpen, onClose, dismissible = true } = {}) => {
    const $element = $(selector);
    const dialog = {
      $element,
      isOpen: () => $element[0].open,
      isDismissible: () => dismissible,
      // Idempotent, because `showModal()` on an open dialog throws: a caller that re-opens by state (a poll,
      // a repeated section click) needs no guard of its own.
      open: () => { if (!$element[0].open) { onOpen?.(); $element[0].showModal(); } },
      close: () => { if ($element[0].open) $element[0].close(); else onClose?.(); },
    };
    $element.on('close', () => onClose?.())
      .on('click', event => { if (dismissible && event.target === $element[0]) dialog.close(); })
      .on('click', '[data-dialog-close]', () => { if (dismissible) dialog.close(); });
    dialogs.push(dialog);
    return dialog;
  };
  if (typeof document === 'object') document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const dialog = topDialog();
    if (!dialog) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // A non-dismissible window still consumes Escape — the page behind a modal must never act on a key the
    // modal owns — it simply has nothing to close.
    if (dialog.isDismissible()) dialog.close();
  }, true);

  // The shared shape behind every "pick one, create one, rename it, delete it" list in the app: Note Type
  // Studio, Deck Studio, and the Collection Profile picker. It holds no DOM — it is the state machine a
  // dialog wires a `<select>` and a status line to — so the same object is exercised here without jQuery
  // or a document. `list`/`create`/`rename`/`remove` are the caller's own API calls; `id`/`labelOf` read
  // whatever shape those calls return (a note type's key is its name, a profile's is its `id`).
  // `canRename`/`canDelete` receive the selected entity (or `null`) and default to always allowed — a
  // caller such as Deck Studio's `Default` deck, or Collection Profile's active/unmanaged entries, passes
  // its own guard instead of checking it again at every call site.
  const entityManager = ({
    list, create, rename, remove,
    id = entity => entity?.id ?? entity?.name,
    labelOf = entity => entity?.name,
    canRename = () => true,
    canDelete = () => true,
  } = {}) => {
    let items = [];
    let selectedId = null;
    const selected = () => items.find(item => id(item) === selectedId) ?? null;
    // Keeps the previous selection when it still exists, falls back to a preferred id (a name just
    // created or renamed), and otherwise the first item — the same fallback order every caller needs.
    const resolveSelection = preferredId => {
      const ids = items.map(id);
      if (preferredId != null && ids.includes(preferredId)) return preferredId;
      if (selectedId != null && ids.includes(selectedId)) return selectedId;
      return ids[0] ?? null;
    };
    return {
      items: () => items,
      selected,
      selectedId: () => selectedId,
      // The id a caller names is looked up in the items, because a `<select>` hands its value back as a string:
      // a preset keyed by a number must stay held as that number, since it is what the detail request is made
      // with and what `selected` compares against.
      select (candidate) {
        const match = items.find(item => String(id(item)) === String(candidate));
        selectedId = match ? id(match) : candidate;
      },
      async load (preferredId) {
        items = await list();
        selectedId = resolveSelection(preferredId);
        return items;
      },
      async create (...args) {
        const entity = await create(...args);
        await this.load(entity != null ? id(entity) : selectedId);
        return entity;
      },
      async rename (...args) {
        const entity = await rename(...args);
        await this.load(entity != null ? id(entity) : selectedId);
        return entity;
      },
      async remove (...args) {
        const result = await remove(...args);
        await this.load();
        return result;
      },
      canRename: () => canRename(selected()),
      canDelete: () => canDelete(selected()),
    };
  };

  // Sync progress arrives as Anki's own numbers, and every view that shows it — the pill, the dialog,
  // the tooltip — must agree, so the one sentence is built here. A transfer size is the only number
  // Anki reports for a full sync; a merge (normal sync) sends change chunks and reports none, which is
  // why it says "Updating collection" instead of inventing a byte count.
  const formatBytes = bytes => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
  };
  // Anki sends media counts as its own formatted strings, so they are shown verbatim; a field that is
  // absent is omitted rather than printed as a null.
  const mediaParts = media => {
    const { checked, added, removed } = media || {};
    return [checked && `${checked} checked`, added && `${added} uploaded`,
      removed && `${removed} downloaded`].filter(Boolean);
  };
  const progressText = (progress, direction = null) => {
    if (!progress || typeof progress !== 'object') return 'Syncing with AnkiWeb…';
    if (progress.kind === 'full_sync') {
      const label = direction === 'upload' ? 'Uploading to AnkiWeb' : 'Downloading from AnkiWeb';
      const total = Number(progress.total) || 0;
      const transferred = Number(progress.transferred) || 0;
      return total ? `${label} — ${formatBytes(transferred)} of ${formatBytes(total)}`
        : `${label} — ${formatBytes(transferred)}`;
    }
    if (progress.kind === 'media_sync') {
      const parts = mediaParts(progress.media);
      return parts.length ? `Syncing media — ${parts.join(', ')}` : 'Syncing media…';
    }
    // Anki's stage is its own word, so it is shown as-is; the counts it adds are its formatted ones too.
    const counts = [progress.added, progress.removed].filter(Boolean);
    return `Updating collection\n${progress.stage || 'Syncing'}${counts.length ? ` · ${counts.join(' · ')}` : ''}`;
  };
  // What a finished sync adds to its completion message: a size it transferred, or the files a media sync
  // moved. A normal sync has nothing to add, because its counts are DATABASE ROWS and not the notes the
  // reader changed — deleting one note writes a note grave plus a card grave and reads "2", and a direction
  // that moved nothing still reads "0↑ 0↓" — so repeating them turns a one-line outcome into a long and
  // misleading one. The pill shows them while the sync runs, which is what they describe: work in flight.
  const progressSummary = progress => {
    if (!progress || typeof progress !== 'object') return '';
    if (progress.kind === 'full_sync') {
      const transferred = Number(progress.transferred) || 0;
      return transferred ? ` — ${formatBytes(transferred)} transferred` : '';
    }
    if (progress.kind !== 'media_sync') return '';
    const parts = mediaParts(progress.media);
    return parts.length ? ` — ${parts.join(', ')}` : '';
  };
  // Whether Anki is reporting data ACTUALLY moving, which is what opens the blocking transfer window. A
  // stage alone is not proof: Anki reports one as soon as it talks to AnkiWeb, a sync with nothing to move
  // included. A full sync proves it with bytes; a merge only with a non-zero count, and its counts are
  // Anki's own formatted strings (`U+2068<n>U+2069↑` per direction of `added`/`removed`), read here and
  // never recomputed. Anything unreadable counts as "nothing yet", so the gate can only under-report.
  const progressActive = progress => {
    if (!progress || typeof progress !== 'object') return false;
    if (progress.kind === 'full_sync') return (Number(progress.transferred) || 0) > 0;
    if (progress.kind === 'media_sync') {
      const { checked, added, removed } = progress.media || {};
      return Boolean(checked || added || removed);
    }
    return [progress.added, progress.removed].some(count => /[1-9]/.test(String(count ?? '')));
  };

  return {
    confirm: { armed, disarm },
    dialogs: { create: createDialog, isOpen: () => Boolean(topDialog()), top: topDialog },
    fields: {
      autoGrow, fillOptions, meaningFromFields, noteMeaning, noteTerm, optionsHtml, pickerRow, renderEntityPicker,
      setTextareaValue, termFromFields,
    },
    icons: { chipButton, icon, iconButton },
    keyboard: { bindEnterToClick },
    progress: { active: progressActive, formatBytes, summary: progressSummary, text: progressText },
    status: { kinds: STATUS_KINDS, set: setSystemMessage },
    text: { escapeAttr, escapeHtml, formatCount, formatDateTime, pad, plainText },
    entityManager,
  };
});
