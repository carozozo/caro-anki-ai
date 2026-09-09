((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroAnkiMaintenance = api;
})(globalThis, () => {
  const createAnkiMaintenance = ({ $, CaroUI, request }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const $form = $('#ankiMaintenancePanel');
    const $buttons = $('#ankiCheckDatabase, #ankiCheckMedia, #ankiCreateBackup');
    let backups = null;
    let saving = false;
    let saveAgain = false;
    let busy = false;

    const setStatus = (text, kind = '') => setSystemMessage($('#ankiMaintenanceStatus'), text, kind);
    const report = text => $('#ankiMaintenanceReport').text(text).prop('hidden', !text);
    const backupInput = () => ({
      daily: Number($('#ankiBackupDaily').val()),
      weekly: Number($('#ankiBackupWeekly').val()),
      monthly: Number($('#ankiBackupMonthly').val()),
      minimumIntervalMins: Number($('#ankiBackupInterval').val()),
    });
    const render = () => {
      $('#ankiBackupDaily').val(backups?.daily ?? '');
      $('#ankiBackupWeekly').val(backups?.weekly ?? '');
      $('#ankiBackupMonthly').val(backups?.monthly ?? '');
      $('#ankiBackupInterval').val(backups?.minimumIntervalMins ?? '');
    };

    const load = async () => {
      ({ backups } = await request('/api/anki/maintenance/backups'));
      render();
      return backups;
    };

    const save = async () => {
      if (saving) { saveAgain = true; return; }
      if (!$form.find('input').toArray().every(input => input.reportValidity())) return;
      saving = true;
      setStatus('Saving backup settings…', 'pending');
      try {
        ({ backups } = await request('/api/anki/maintenance/backups', {
          method: 'PUT', body: JSON.stringify(backupInput()),
        }));
        render();
        setStatus('Backup settings saved.', 'ok');
      } catch (error) { setStatus(error.message, 'error'); }
      finally {
        saving = false;
        if (saveAgain) { saveAgain = false; save(); }
      }
    };

    const run = async ({ button, path, format }) => {
      if (busy) return;
      busy = true;
      $buttons.prop('disabled', true);
      report('');
      setStatus('Working…', 'pending');
      try {
        const response = await request(path, { method: 'POST' });
        const result = format(response);
        report(result.report);
        setStatus(result.status, result.kind);
      } catch (error) { setStatus(error.message, 'error'); }
      finally {
        busy = false;
        $buttons.prop('disabled', false);
        $(button).trigger('focus');
      }
    };

    $('#ankiCheckDatabase').on('click', event => run({
      button: event.currentTarget,
      path: '/api/anki/maintenance/database',
      format: ({ check }) => ({
        kind: check.healthy ? 'ok' : 'warn',
        status: check.healthy ? 'Database checked.' : 'Database check found problems.',
        report: `${check.backupCreated ? 'Backup created before the check.\n\n' : ''}${check.report}`,
      }),
    }));
    $('#ankiCheckMedia').on('click', event => run({
      button: event.currentTarget,
      path: '/api/anki/maintenance/media',
      format: ({ check }) => ({
        kind: check.missing.length || check.unused.length ? 'warn' : 'ok',
        status: `Media checked: ${check.missing.length} missing, ${check.unused.length} unused.`,
        report: check.report,
      }),
    }));
    $('#ankiCreateBackup').on('click', event => run({
      button: event.currentTarget,
      path: '/api/anki/maintenance/backup',
      format: ({ backup }) => ({
        kind: 'ok',
        status: backup.created ? 'Backup created.' : 'No collection changes since the latest backup.',
        report: '',
      }),
    }));
    $form.on('change', '#ankiBackupInterval, #ankiBackupDaily, #ankiBackupWeekly, #ankiBackupMonthly', save);

    return { load, setStatus };
  };

  return { createAnkiMaintenance };
});
