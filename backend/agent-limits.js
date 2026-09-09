const DEFAULT_AGENT_STEP_LIMIT = 12;
const MIN_AGENT_STEP_LIMIT = 4;
const MAX_AGENT_STEP_LIMIT = 50;

const agentStepLimit = value => {
  const limit = Number(value ?? DEFAULT_AGENT_STEP_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < MIN_AGENT_STEP_LIMIT || limit > MAX_AGENT_STEP_LIMIT) {
    throw new Error(`stepLimit must be an integer from ${MIN_AGENT_STEP_LIMIT} to ${MAX_AGENT_STEP_LIMIT}`);
  }
  return limit;
};

module.exports = { agentStepLimit, DEFAULT_AGENT_STEP_LIMIT, MIN_AGENT_STEP_LIMIT, MAX_AGENT_STEP_LIMIT };
