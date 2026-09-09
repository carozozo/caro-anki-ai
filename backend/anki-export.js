const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const serializeExport = row => ({
  id: row.id,
  sessionId: row.session_id,
  cardVersionId: row.card_version_id,
  cardIndex: row.card_index,
  status: row.status,
  notes: JSON.parse(row.notes_json),
  noteIds: JSON.parse(row.note_ids_json),
  error: row.error_json ? JSON.parse(row.error_json) : null,
  createdAt: row.created_at,
});

class AnkiExport {
  constructor ({ repository, client, config, cardProfiles = null, getProfileId = null }) {
    Object.assign(this, { repository, client, config, cardProfiles, getProfileId });
  }

  // A card is stored as its note type's own fields, so there is nothing to export it AS without the profile
  // that says what those fields are. Naming the profile to write is the whole fix, so that is the answer.
  contract () {
    const contract = this.cardProfiles?.get(this.config.modelName) ?? null;
    if (!contract) fail(503, `No card profile is configured for the ${this.config.modelName} note type`);
    return contract;
  }

  async preview (sessionId, cardVersionId, cardIndex = 0, deck) {
    const profileId = this.getProfileId?.() || null;
    if (!this.repository.getSession(sessionId, profileId)) fail(404, 'Session not found');
    const version = this.repository.getCardVersion(sessionId, cardVersionId, profileId);
    if (!version) fail(404, 'Card version not found');
    const contract = this.contract();
    const validation = contract.validateCards(JSON.parse(version.cards_json));
    if (!validation.valid) fail(422, validation.errors.join('; '));
    if (!Number.isSafeInteger(cardIndex) || cardIndex < 0 || cardIndex >= validation.cards.length) {
      fail(400, 'cardIndex is not valid');
    }
    const deckName = typeof deck === 'string' ? deck.trim() : await this.client.invoke('currentDeckName', {});
    if (!deckName) fail(400, 'deck must be a non-empty string');
    const { modelName, allowDuplicate } = this.config;
    const notes = [validation.cards[cardIndex]].map(card => ({
      deckName, modelName, fields: contract.toAnkiFields(card), options: { allowDuplicate }, tags: [],
    }));
    return serializeExport(this.repository.createAnkiPreview({ sessionId, cardVersionId, cardIndex, notes, profileId }));
  }

  async add (sessionId, { exportId, confirmed }) {
    const profileId = this.getProfileId?.() || null;
    if (confirmed !== true) fail(400, 'Explicit confirmation is required');
    if (!Number.isSafeInteger(exportId) || exportId <= 0) fail(400, 'exportId must be a positive integer');
    const row = this.repository.getAnkiExport(sessionId, exportId, profileId);
    if (!row) fail(404, 'Anki preview not found');
    if (row.status === 'completed') return serializeExport(row);
    if (row.status !== 'preview') fail(409, 'Export already attempted; inspect the collection before another export');
    if (!JSON.parse(row.notes_json).length) fail(409, 'Preview again to create an export snapshot');
    if (!this.repository.claimAnkiExport(sessionId, exportId, profileId)) {
      fail(409, 'This version was already submitted');
    }
    let noteIds = [];
    let error = null;
    try {
      noteIds = await this.client.addNotes(JSON.parse(row.notes_json));
      if (noteIds.includes(null)) error = {
        message: 'Some notes were rejected; inspect the collection before another export',
      };
    } catch (failure) {
      error = { message: failure.message, outcomeUnknown: true };
    }
    return serializeExport(this.repository.finishAnkiExport(sessionId, exportId, noteIds, error, profileId));
  }
}

module.exports = { AnkiExport, serializeExport };
