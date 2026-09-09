const BACKUP_FIELDS = ['daily', 'weekly', 'monthly', 'minimumIntervalMins'];
const MAX_BACKUP_VALUE = 100_000;

const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

const asBackupValue = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BACKUP_VALUE) {
    fail(`${name} must be an integer from 0 to ${MAX_BACKUP_VALUE}`);
  }
  return value;
};

const normalizeBackups = values => Object.fromEntries(BACKUP_FIELDS.map(name => [name,
  asBackupValue(values?.[name], name),
]));

class AnkiMaintenance {
  constructor ({ client }) { this.client = client; }

  async backups () {
    return normalizeBackups(await this.client.invoke('backupSettings', {}));
  }

  async updateBackups (input) {
    const current = await this.backups();
    const backups = normalizeBackups({ ...current, ...input });
    return normalizeBackups(await this.client.invoke('updateBackupSettings', backups));
  }

  createBackup () {
    return this.client.invoke('createBackup', { force: true });
  }

  async checkDatabase () {
    const backup = await this.createBackup();
    return { backupCreated: backup.created, ...(await this.client.invoke('checkDatabase', {})) };
  }

  checkMedia () {
    return this.client.invoke('checkMedia', {});
  }
}

module.exports = { AnkiMaintenance, BACKUP_FIELDS, MAX_BACKUP_VALUE, normalizeBackups };
