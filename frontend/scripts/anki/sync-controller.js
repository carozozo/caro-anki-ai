((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroSyncController = api;
})(globalThis, () => {
  // AnkiWeb refuses to merge two collections it cannot reconcile, and it reports which directions are
  // possible instead of choosing. `FULL_SYNC` allows either side to win; the other two are dictated.
  const FULL_SYNC_DIRECTIONS = {
    FULL_SYNC: ['upload', 'download'],
    FULL_DOWNLOAD: ['download'],
    FULL_UPLOAD: ['upload'],
  };

  const syncButtonState = ({ needsSync, required = 'NO_CHANGES' } = {}) => {
    const fullSyncRequired = Boolean(FULL_SYNC_DIRECTIONS[required]);
    return { needsSync: Boolean(needsSync), fullSyncRequired };
  };

  // AnkiWeb answers NO_CHANGES both when there was nothing to do and after a merge it has just performed,
  // so the code alone cannot say what happened: `merged` is the stamp the sync wrote when it finalized, and
  // a full sync names its own direction. A merge reports no size (it sends change chunks), and the row
  // counts it does report describe the sync in flight rather than its outcome. Anything else the server can
  // answer is a full-sync requirement, and that is the one case the user decides.
  const FULL_SYNC_COMPLETIONS = {
    upload: 'Uploaded to AnkiWeb.',
    download: 'Downloaded from AnkiWeb.',
  };

  // A finished sync says as little as it can. A normal one — merge or not — says NOTHING: a sync without an
  // error is a completed sync, and whatever it transferred was already watched in the progress window. A
  // full sync still names the direction the user chose (and the bytes it moved), and a NO_CHANGES with no
  // stamp change is the one case where nothing happened at all, so it is the one case worth answering.
  const syncResult = ({ required, merged, fullSync, progress }, syncSummary) => {
    if (FULL_SYNC_COMPLETIONS[fullSync]) {
      return ['ok', `${FULL_SYNC_COMPLETIONS[fullSync]}${typeof syncSummary === 'function' ? syncSummary(progress) : ''}`];
    }
    if (merged || required === 'NORMAL_SYNC') return null;
    if (required === 'NO_CHANGES') return ['ok', 'Anki is already up to date.'];
    return ['warn', 'AnkiWeb requires a full sync.'];
  };

  // Anki's own words when it reported nothing during the sync it just performed; the outcome the window
  // derived from the stamps is added to it by `syncOutcomeText`.
  const SYNC_PROGRESS_SILENT = 'Syncing with AnkiWeb…';

  // A merge is the one case Anki does not report on: `required` answers NO_CHANGES for it, its counts
  // describe work in flight rather than an outcome, and the pill stays silent about it (see `syncResult`).
  // The window shows it instead, and `runAnkiSync` paints it from the very same two constants.
  const MERGED_SYNC_COMPLETION = 'Sync complete — your changes were merged.';

  const syncOutcomeText = completion => `${SYNC_PROGRESS_SILENT} ${completion}`;

  const createSyncController = ({
    $,
    config,
    CaroUI,
    request,
    armDeadline,
    CONNECTED_STATUS,
    SYNC_REMINDER,
    state,
    connectionStatus,
    setStatus,
    renderStatus,
    getAnkiSettingsState,
    loadAnkiSettings,
    NoteShortcuts,
  }) => {
    const { create: createDialog } = CaroUI.dialogs;
    const { set: setSystemMessage } = CaroUI.status;
    const { armed: armedConfirm } = CaroUI.confirm;
    const { active: syncTransferActive, summary: syncSummary, text: syncProgressText } = CaroUI.progress;

    const setAnkiAccountStatus = (text, kind = '') => setSystemMessage($('#ankiAccountStatus'), text, kind);
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const shortcutHint = id => NoteShortcuts.display(NoteShortcuts.find(id), isMac);
    const shortcutAria = id => NoteShortcuts.aria(NoteShortcuts.find(id));

    const ankiAccount = () =>
      getAnkiSettingsState()?.account || { username: '', endpoint: '', media: true, loggedIn: false };

    // The topbar control carries the account state in its label and colour, so the state is readable
    // without opening the dialog.
    const renderAnkiAccountButton = () => {
      const account = ankiAccount();
      const label = account.loggedIn
        ? `AnkiWeb account — signed in as ${account.username}`
        : 'AnkiWeb account — not signed in';
      $('#ankiAccountOpen').toggleClass('is-signed-in', account.loggedIn).attr({
        'aria-keyshortcuts': shortcutAria('account'),
        'aria-label': `${label} (${shortcutHint('account')})`,
        title: `${label} (${shortcutHint('account')})`,
      });
    };

    const renderAnkiAccountDialog = () => {
      const account = ankiAccount();
      const { loggedIn } = account;
      $('#ankiAccountSignIn, #ankiAccountLogin').prop('hidden', loggedIn);
      $('#ankiAccountSignedIn, #ankiAccountLogout').prop('hidden', !loggedIn);
      if (loggedIn) {
        $('#ankiAccountUsername').text(account.username);
        $('#ankiAccountEndpoint').text(account.endpoint || 'AnkiWeb');
        $('#ankiAccountMedia').text(account.media ? 'Included' : 'Not synced');
        $('#ankiAccountHelp').text('The password is kept in the macOS Keychain. Log out to change the '
          + 'account or its sync preferences.');
        return;
      }
      $('#ankiSyncUsername').val(account.username || '');
      $('#ankiSyncPassword').val('');
      $('#ankiSyncEndpoint').val(account.endpoint || '');
      $('#ankiSyncMedia').prop('checked', account.media);
      $('#ankiAccountHelp').text('Log in to sync this collection with AnkiWeb. A first sync asks whether '
        + 'to keep the local or the AnkiWeb copy.');
    };

    const ankiAccountDialog = createDialog({ selector: '#ankiAccountDialog' });

    const openAnkiAccount = async () => {
      setAnkiAccountStatus('');
      await loadAnkiSettings();
      renderAnkiAccountDialog();
      ankiAccountDialog.open();
    };

    $('#ankiAccountOpen').on('click', () => openAnkiAccount()
      .catch(error => setStatus('error', error.message)));

    // Login verifies the credentials against AnkiWeb before anything is stored, so a rejected password
    // leaves the form as typed instead of being cleared.
    $('#ankiAccountForm').on('submit', async event => {
      event.preventDefault();
      if (ankiAccount().loggedIn) return;
      $('#ankiAccountLogin').prop('disabled', true);
      setAnkiAccountStatus('Checking the account…', 'pending');
      try {
        await request('/api/anki/account/login', {
          method: 'POST',
          body: JSON.stringify({
            username: $('#ankiSyncUsername').val(), password: $('#ankiSyncPassword').val(),
            endpoint: $('#ankiSyncEndpoint').val(), media: $('#ankiSyncMedia').prop('checked'),
          }),
        });
        await loadAnkiSettings();
        renderAnkiAccountDialog();
        setAnkiAccountStatus(`Signed in as ${ankiAccount().username}`, 'ok');
      } catch (error) { setAnkiAccountStatus(error.message, 'error'); }
      finally { $('#ankiAccountLogin').prop('disabled', false); }
    });

    const ankiAccountLogoutConfirm = armedConfirm(async $button => {
      $button.prop('disabled', true);
      setAnkiAccountStatus('Logging out…', 'pending');
      try {
        await request('/api/anki/account', { method: 'DELETE' });
        await loadAnkiSettings();
        renderAnkiAccountDialog();
        setAnkiAccountStatus('Logged out', 'ok');
      } catch (error) { setAnkiAccountStatus(error.message, 'error'); }
      finally { $button.prop('disabled', false); }
    });

    $('#ankiAccountLogout').on('click', event =>
      ankiAccountLogoutConfirm.handle(event, 'Click again to log out of AnkiWeb'));

    const setSyncReminder = ({ needsSync, required }, render = true) => {
      Object.assign(connectionStatus, { needsSync, required });
      if (render) renderStatus();
    };

    const renderSyncStatus = (status, { render = true } = {}) => {
      const buttonState = syncButtonState(status);
      const required = status?.required ?? 'NO_CHANGES';
      setSyncReminder({ needsSync: buttonState.needsSync, required }, render);
      const hint = buttonState.fullSyncRequired
        ? 'AnkiWeb requires a full sync — choose which collection to keep'
        : buttonState.needsSync ? SYNC_REMINDER.hint : 'Sync with AnkiWeb';
      $('#syncAnki').toggleClass('is-needs-sync', buttonState.needsSync)
        .toggleClass('is-full-sync-required', buttonState.fullSyncRequired).attr({
        'aria-keyshortcuts': shortcutAria('sync'),
        'aria-label': `${hint} (${shortcutHint('sync')})`,
        title: `${hint} (${shortcutHint('sync')})`,
      });
    };

    const refreshSyncStatus = async () => {
      try {
        const { needsSync, required } = await request('/api/anki/sync-status');
        renderSyncStatus({ needsSync, required });
      } catch { /* keep the last state */ }
    };
    $(document).on('anki-shortcuts-changed', () => {
      renderAnkiAccountButton();
      renderSyncStatus(connectionStatus);
    });

    const syncConflictDialog = createDialog({
      selector: '#ankiSyncConflictDialog',
      onClose: () => $('#ankiSyncConflictMessage').text(''),
    });

    let syncing = false;

    const showSyncConflict = (sync, directions) => {
      $('#ankiFullUpload').prop('hidden', !directions.includes('upload'));
      $('#ankiFullDownload').prop('hidden', !directions.includes('download'));
      $('#ankiSyncConflictMessage').text(sync.serverMessage
        || 'Choose which collection to keep. The other side is replaced completely by this sync.');
      syncConflictDialog.open();
    };

    const $syncProgressText = $('#ankiSyncProgressText');
    const syncProgressDialog = createDialog({
      selector: '#ankiSyncProgressDialog',
      dismissible: false,
      onClose: () => {
        setSystemMessage($syncProgressText, '');
        $('#ankiSyncProgressBar').removeAttr('value');
        $('#ankiSyncProgressDialog').removeClass(config.syncProgressClosing);
      },
    });
    const $syncProgressBar = $('#ankiSyncProgressBar');

    const fillSyncProgress = (progress, direction) => {
      setSystemMessage($syncProgressText, syncProgressText(progress, direction));
      const total = progress?.kind === 'full_sync' ? Number(progress.total) || 0 : 0;
      if (total) {
        $syncProgressBar.attr('value', Math.min(100, (Number(progress.transferred) || 0) / total * 100));
      } else {
        $syncProgressBar.removeAttr('value');
      }
    };

    const openSyncProgress = direction => {
      fillSyncProgress(null, direction);
      syncProgressDialog.open();
    };

    const showSyncProgress = (progress, direction) => {
      if (!syncTransferActive(progress)) return;
      fillSyncProgress(progress, direction);
      syncProgressDialog.open();
    };

    const lingerSyncProgress = () => new Promise(resolve => {
      window.setTimeout(() => {
        $('#ankiSyncProgressDialog').addClass(config.syncProgressClosing);
        window.setTimeout(resolve, config.timings.syncFadeMs);
      }, config.timings.syncLingerMs);
    });

    const closeSyncProgress = async () => {
      if (!syncProgressDialog.isOpen()) return;
      await lingerSyncProgress();
      syncProgressDialog.close();
    };

    const setSyncOutcome = completion => setSystemMessage($syncProgressText, syncOutcomeText(completion));

    const requireAnkiLogin = async () => {
      if (ankiAccount().loggedIn) return true;
      await openAnkiAccount();
      return false;
    };

    // A sync holds the Anki bridge for its whole duration, so Anki cannot be asked what it is doing: the
    // backend keeps a snapshot of the progress the bridge pushes and this reads that snapshot.
    const watchSyncProgress = onUpdate => {
      let reading = false;
      const read = async () => {
        if (reading) return;
        reading = true;
        const deadline = armDeadline(config.timings.requestTimeoutMs);
        try {
          const { ok, progress } = await (await fetch('/api/anki/sync-progress',
            { signal: deadline.signal })).json();
          if (ok) onUpdate(progress);
        } catch { /* the sync itself reports the real outcome */ } finally {
          deadline.clear();
          reading = false;
        }
      };
      read();
      const timer = window.setInterval(read, config.timings.syncProgressMs);
      return () => window.clearInterval(timer);
    };

    // A full sync replaces one whole collection, so the direction is never chosen for the user: the
    // first sync returns the requirement and the dialog asks.
    const runAnkiSync = async (direction = null) => {
      if (syncing || state.busy || state.pending) return false;
      try {
        if (!getAnkiSettingsState()) await loadAnkiSettings();
      } catch (error) { setStatus('error', error.message); return false; }
      if (!await requireAnkiLogin()) return false;
      syncing = true;
      const $controls = $('#syncAnki, #ankiFullUpload, #ankiFullDownload').prop('disabled', true);
      $('#syncAnki').addClass('is-syncing').attr('aria-busy', 'true');

      let stopWatching = () => {};
      const syncDeadline = armDeadline(config.timings.requestTimeoutMs);
      let settled = false;
      let completed = false;
      let completedSync = null;
      try {
        if (connectionStatus.needsSync) openSyncProgress(direction);
        stopWatching = watchSyncProgress(progress => {
          syncDeadline.arm();
          if (!settled && progress?.running) showSyncProgress(progress.update, direction);
        });

        const { sync } = await request('/api/anki/sync', {
          method: 'POST', body: JSON.stringify(direction ? { direction } : {}), deadline: syncDeadline,
        });

        settled = true;
        const outcome = syncResult(sync, syncSummary);
        if (outcome) setSyncOutcome(outcome[1]);
        if (sync.merged && !outcome) setSyncOutcome(MERGED_SYNC_COMPLETION);
        await closeSyncProgress();

        if (outcome) setStatus(...outcome);
        else setStatus('ok', CONNECTED_STATUS);

        const directions = FULL_SYNC_DIRECTIONS[sync.required];
        if (sync.fullSync) renderSyncStatus({ needsSync: false }, { render: false });
        else if (directions) {
          renderSyncStatus({ needsSync: true, required: sync.required });
          showSyncConflict(sync, directions);
        } else renderSyncStatus({ needsSync: false }, { render: false });
        if (sync.merged || sync.fullSync) completedSync = sync;
        completed = true;
      } catch (error) {
        setStatus('error', error.message);
        if (syncProgressDialog.isOpen()) {
          setSyncOutcome(error.message);
          await closeSyncProgress();
        }
      } finally {
        stopWatching();
        syncDeadline.clear();
        syncProgressDialog.close();
        syncing = false;
        $controls.prop('disabled', false);
        $('#syncAnki').removeClass('is-syncing').attr('aria-busy', 'false');
      }
      if (completedSync) $(document).trigger('anki-sync-finished', [completedSync]);
      return completed;
    };

    $('#syncAnki').on('click', () => { runAnkiSync(); });
    $('#ankiFullUpload').on('click', async () => {
      if (await runAnkiSync('upload')) syncConflictDialog.close();
    });
    $('#ankiFullDownload').on('click', async () => {
      if (await runAnkiSync('download')) syncConflictDialog.close();
    });

    return {
      ankiAccount,
      openAnkiAccount,
      refreshSyncStatus,
      renderAnkiAccountButton,
      renderAnkiAccountDialog,
      renderSyncStatus,
      runAnkiSync,
      setAnkiAccountStatus,
    };
  };

  return { createSyncController, FULL_SYNC_COMPLETIONS, FULL_SYNC_DIRECTIONS, syncButtonState, syncResult };
});
