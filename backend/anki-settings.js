const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

// The deck list is a whitelist: an empty one means every deck, which is how the UI stores "All decks".
const asVisibleDecks = value => {
  if (!Array.isArray(value)) fail('visibleDecks must be an array of deck names');
  return [...new Set(value.map(name => String(name).trim()).filter(Boolean))];
};

const deckAndChildren = (deck, parent) => deck === parent || deck.startsWith(`${parent}::`);

class AnkiSettings {
  constructor ({ repository, config, profileId = null }) {
    Object.assign(this, { repository, config, profileId });
    this.apply(repository.getAnkiSettings(profileId));
  }

  async renameVisibleDecks (oldName, name) {
    const { visibleDecks } = this.settings();
    return this.update({ visibleDecks: visibleDecks.map(deck =>
      deckAndChildren(deck, oldName) ? `${name}${deck.slice(oldName.length)}` : deck) });
  }

  async removeVisibleDecks (name) {
    const { visibleDecks } = this.settings();
    return this.update({ visibleDecks: visibleDecks.filter(deck => !deckAndChildren(deck, name)) });
  }

  apply ({ modelName, allowDuplicate, visibleDecks }) {
    Object.assign(this.config, { modelName, allowDuplicate, visibleDecks });
  }

  validate (input) {
    const settings = {
      modelName: String(input.modelName || '').trim(),
      allowDuplicate: input.allowDuplicate,
      visibleDecks: asVisibleDecks(input.visibleDecks),
    };
    if (!settings.modelName) fail('modelName is required');
    if (typeof settings.allowDuplicate !== 'boolean') fail('allowDuplicate must be a boolean');
    return settings;
  }

  activate (profileId) {
    this.profileId = profileId;
    const settings = this.repository.getAnkiSettings(profileId);
    this.apply(settings);
    return settings;
  }

  settings () { return this.repository.getAnkiSettings(this.profileId); }

  async update (input) {
    const current = this.settings();
    const next = this.validate({ ...current, ...input });
    const settings = this.repository.updateAnkiSettings(next, this.profileId);
    this.apply(settings);
    return this.settings();
  }
}

module.exports = { AnkiSettings };
