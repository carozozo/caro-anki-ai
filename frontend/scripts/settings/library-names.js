((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroSettingsLibraryNames = api;
})(globalThis, () => {
  // A library entry's identity is its type plus its stored name, and that name is a file (instructions and memories) or a
  // folder (skills), so the two name transforms live beside the identity check they belong to instead of inside
  // the editor that draws them.
  const displayLibraryName = entry => ['instructions', 'memories'].includes(entry.type)
    ? entry.name.replace(/\.md$/i, '') : entry.name;

  const normalizeLibraryName = (type, name) => {
    const value = String(name ?? '').trim();
    if (['instructions', 'memories'].includes(type)) return value && !/\.md$/i.test(value) ? `${value}.md` : value;
    return value.replace(/^\//, '').toLowerCase();
  };

  const sameLibraryEntry = (left, right) => left.type === right.type && left.name === right.name;

  return { displayLibraryName, normalizeLibraryName, sameLibraryEntry };
});
