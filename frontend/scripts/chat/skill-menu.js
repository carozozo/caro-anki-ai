((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SkillMenu = api;
})(globalThis, () => {
  const MAX_SUGGESTIONS = 8;
  // The command as typed: a leading `/` and everything up to the first whitespace or second slash, so the
  // menu only ever describes the command itself and never a slash inside the message.
  const COMMAND_PATTERN = /^\/([^\s/]*)/;
  // ...plus the whitespace that ended it, so accepting a suggestion rewrites the command without doubling
  // the separator in front of an argument the user already wrote.
  const COMMAND_SPAN_PATTERN = /^\/[^\s/]*\s*/;

  // The skill name being typed, lowercased, or null when the composer does not hold a command still being
  // typed. A bare `/` is a command with an empty query, which offers every skill; a space after the command
  // ends it, which is what keeps the menu out of the way while the argument is written.
  const skillToken = value => {
    const text = String(value ?? '');
    const match = text.match(COMMAND_PATTERN);
    if (!match || /^\s/.test(text.slice(match[0].length))) return null;
    return match[1].toLowerCase();
  };

  // Only a skill its author marked user-invocable is reachable from the composer; model-only skills stay
  // out of the menu while remaining available to the agent.
  const invocable = skills => (skills || [])
    .filter(skill => skill?.name && skill.userInvocable !== false)
    .sort((left, right) => left.name.localeCompare(right.name));

  // A name match always outranks a description match: someone typing `/audi` means `card-audit`, and a skill
  // whose description merely mentions "audit" must not push the real match off a capped list. Inside the name,
  // a prefix still outranks a match in the middle, so `/card` offers `card-audit` before `audit-extra`. The
  // list arrives alphabetical and `sort` is stable, so ties keep that order.
  const filterSkills = (skills, query, { limit = MAX_SUGGESTIONS } = {}) => {
    const needle = String(query ?? '').trim().toLowerCase();
    const usable = invocable(skills);
    if (!needle) return usable.slice(0, limit);
    const rank = skill => {
      const name = skill.name.toLowerCase();
      if (name.startsWith(needle)) return 0;
      if (name.includes(needle)) return 1;
      return String(skill.description ?? '').toLowerCase().includes(needle) ? 2 : -1;
    };
    return usable
      .map(skill => ({ rank: rank(skill), skill }))
      .filter(entry => entry.rank >= 0)
      .sort((left, right) => left.rank - right.rank)
      .slice(0, limit)
      .map(entry => entry.skill);
  };

  // Accepting replaces exactly the command and the whitespace that ended it: a half-typed name loses to the
  // picked one, an argument already written stays, and the command is closed with a single space.
  const acceptSkill = (value, name) =>
    String(value ?? '').replace(COMMAND_SPAN_PATTERN, `/${String(name ?? '').trim()} `);

  // The finished command a message carries, argument and all — the counterpart of `skillToken`, which stops
  // at the whitespace that ends the command while it is still being typed. This is what the composer renders
  // and what the message is sent as, so the same leading `/name` is readable on both sides of the request.
  const COMMAND_SPAN = /^\/([^\s/]*)(?=\s|$)/;
  const skillCommand = value => {
    const match = String(value ?? '').trim().match(COMMAND_SPAN);
    return match ? match[1].toLowerCase() : null;
  };

  // The installed skill a message pins, or null. Only an exact name counts: the menu is what helps while the
  // name is half-typed, and a command that matches nothing stays ordinary text the model may still act on by
  // itself. A skill its author kept out of the slash menu is not pinnable either.
  const pinnedSkill = (value, skills) => {
    const command = skillCommand(value);
    return command ? invocable(skills).find(skill => skill.name.toLowerCase() === command) || null : null;
  };

  // Dropping a pinned command leaves the argument behind, so the message can still be sent without the skill.
  const clearSkill = value => String(value ?? '').replace(COMMAND_SPAN_PATTERN, '');

  return { MAX_SUGGESTIONS, acceptSkill, clearSkill, filterSkills, pinnedSkill, skillCommand, skillToken };
});
