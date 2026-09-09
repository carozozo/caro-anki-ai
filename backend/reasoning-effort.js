const { REASONING_EFFORTS } = require('./providers/deepseek-provider');

// The classifier runs on the profile's own model with thinking turned OFF, because a routing decision does
// not need to be deliberated — the point of `auto` is to spend the budget on the real turn instead. It also
// sends no `max_tokens`: its reply is one small JSON object, and the API's non-thinking default already
// bounds it.
const PROMPT = [
  'You route one request for an Anki card agent to a reasoning budget.',
  'Answer with JSON only: {"effort":"none"|"low"|"high"}.',
  'The agent can search and read notes, list decks, and create, edit, or delete notes.',
  'none: no deliberation is needed — a plain conversation turn, a question you can answer directly, or a'
  + ' restatement of what the user already said.',
  'low: one straightforward action on a known target — reading or listing notes, a simple search, a single'
  + ' field edit the user spelled out.',
  'high: everything that needs deliberation — writing or rewriting card content, several notes at once,'
  + ' judgement about senses, wording, or translations, and also ambiguous, multi-step, or destructive work'
  + ' where a mistake is expensive (batch edits, deletions, conflicting instructions, or a target that must'
  + ' be identified first).',
  'Choose the CHEAPEST budget that still gets the request right, but `none` and `low` are for requests with'
  + ' nothing to weigh: when in doubt between low and high, choose high.',
].join('\n');

const describe = ({ request, selection, history }) => [
  `Request: ${request || '(empty)'}`,
  selection ? `The user has ${selection} note(s) selected in the browser.` : null,
  history.length ? `Recent turns:\n${history.join('\n')}` : null,
].filter(Boolean).join('\n');

const readEffort = reply => {
  const value = typeof reply === 'string' ? reply : reply?.effort;
  const effort = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORTS.includes(effort)) throw new Error(`Unknown reasoning effort: ${JSON.stringify(value)}`);
  return effort;
};

// Resolves the `auto` choice. The answer is advisory: a classifier call that fails, answers prose, or names
// a level that does not exist must never fail the request, so the profile's own effort is used instead. It
// is called once per request (a retry re-decides, which is what the user asked for by leaving it on auto).
async function chooseReasoningEffort ({ provider, request, selection = 0, history = [], fallback, signal }) {
  try {
    const reply = await provider.completeJson({
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: describe({ request, selection, history }) },
      ],
      reasoningEffort: 'none',
      attempts: 1,
      signal,
    });
    return { effort: readEffort(reply), source: 'auto' };
  } catch (error) {
    return { effort: fallback, source: 'fallback', error: error.message };
  }
}

module.exports = { chooseReasoningEffort, readEffort, PROMPT };
