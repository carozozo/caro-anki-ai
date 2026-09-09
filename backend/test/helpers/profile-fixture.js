// The card profile a test hands to whatever needs one, plus the three lookups every caller makes of the real
// `CardProfileLibrary`. A profile is the ONLY description of a card's shape in this app, so a fixture without
// one is the state a user who has never described their note type is in — spelled `profileLibrary({})`.
const { compileProfile } = require('../../card-profile');

const englishProfile = compileProfile(require('../fixtures/english-profile.json'));
const profileLibrary = profiles => ({
  dir: '/tmp/card-profiles',
  get: noteType => profiles[noteType] ?? null,
  list: () => Array.from(new Set(Object.values(profiles).map(profile => profile.noteType))),
  pathFor: noteType => `/tmp/card-profiles/${noteType}.json`,
  // A turn re-scans the directory before it reads it, and a fixture has no directory to scan: the profiles it
  // was handed are the ones a scan would find, so answering with them is the same thing.
  refresh: () => Object.keys(profiles),
  errors: () => [],
});
const englishProfiles = profileLibrary({ English: englishProfile });

module.exports = { englishProfile, englishProfiles, profileLibrary };
