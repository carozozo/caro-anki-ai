const RETRYABLE_STATUS = /^(429|5\d\d)$/;

// `max_tokens` is deliberately never sent: it bounds thinking AND the answer together, so any budget we
// picked ourselves would cap a thinking turn's deliberation and make it return `finish_reason: 'length'`
// with empty content — indistinguishable from a refusal, and only visible through `describeFailure`'s
// `reasoning_tokens`. DeepSeek's own default is the right size per mode (8K without thinking, 64K with it)
// and the model's context length already bounds the reply, so the field is not ours to set.

// DeepSeek's `reasoning_effort`: `none` disables thinking mode, the rest enable it. The API also accepts
// the legacy aliases `minimal` (→ low) and `medium`/`xhigh` (→ high); we deliberately do not offer them.
// `max` is deliberately not offered either: it buys a 128K thinking budget for work that is mostly
// vocabulary lookups and card writing, and that deliberation is what exhausts the reply budget in practice.
const REASONING_EFFORTS = ['none', 'low', 'high'];
// `auto` is not an API value: it asks the backend to pick one of REASONING_EFFORTS per request, and is a
// valid choice wherever a human picks the budget (the composer, an Agent profile).
const AUTO_REASONING_EFFORT = 'auto';
const EFFORT_CHOICES = [AUTO_REASONING_EFFORT, ...REASONING_EFFORTS];
const DEFAULT_REASONING_EFFORT = 'high';

// A call that goes quiet has to end the turn: the deadline measures silence, not the length of the work,
// so a thinking turn that keeps streaming stays alive while a socket that stopped answering does not. The
// default is generous because one long deliberation can legitimately pause between events.
const DEFAULT_IDLE_TIMEOUT_MS = 120000;

// Anything unresolved that reaches a request body has to become a real API value.
const apiEffort = effort => effort === AUTO_REASONING_EFFORT ? DEFAULT_REASONING_EFFORT : effort;

// An aborted request reports its reason as `cause`, which is the message worth showing.
const failureMessage = error => error.cause?.message ?? error.message;

class DeepSeekError extends Error {
  constructor (message, retryable) {
    super(message);
    this.retryable = retryable;
  }
}

class DeepSeekProvider {
  constructor ({
    apiKey,
    model = 'deepseek-v4-flash',
    baseUrl = 'https://api.deepseek.com',
    attempts = 2,
    reasoningEffort = DEFAULT_REASONING_EFFORT,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  } = {}) {
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.attempts = attempts;
    this.reasoningEffort = reasoningEffort;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  // One deadline per attempt, armed before every wait for bytes and re-armed by each arrival, so the
  // abort can only ever mean silence. Aborting cancels the request, and `expired` is the same failure as a
  // promise: the transport may not honor the abort mid-read, so the deadline answers the wait itself.
  // A caller's own `signal` is the same wait ended on purpose, so it settles the deadline the same way
  // rather than outliving the decision — a completion writes nothing, which is why it can be stopped
  // between two waits at all.
  #deadline (signal) {
    const controller = new AbortController();
    let timer = null;
    let stopped = false;
    let fail = () => {};
    const expired = new Promise((_, reject) => { fail = reject; });
    const stop = () => {
      stopped = true;
      const reason = new Error('DeepSeek request stopped');
      controller.abort(reason);
      fail(reason);
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    return {
      controller,
      expired,
      stopped: () => stopped,
      arm: () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const reason = new Error(`DeepSeek stopped answering for ${this.idleTimeoutMs}ms`);
          controller.abort(reason);
          fail(reason);
        }, this.idleTimeoutMs);
      },
      clear: () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); },
    };
  }

  // A stop is not a transport failure: the caller asked for it, so it is never retried — retrying is
  // exactly what a stop says no to — and it is named for what it is.
  #stopped (deadline) {
    if (!deadline.stopped()) return null;
    return Object.assign(new DeepSeekError('DeepSeek request stopped', false), { cancelled: true });
  }

  // Waits for `work` under the deadline: whichever settles first is the answer.
  #within (deadline, work) {
    deadline.arm();
    return Promise.race([work, deadline.expired]);
  }

  // JSON mode: the model answers one JSON object, returned already parsed. `model` and `reasoningEffort`
  // override the provider defaults for this call only (a cheap side call such as effort classification),
  // and `attempts` overrides how often a malformed reply is retried.
  async completeJson ({ messages, model, reasoningEffort, attempts, signal } = {}) {
    return this.#run(async () => {
      const choice = await this.request({ messages, model, reasoningEffort, signal });
      return this.#parse(choice, ({ message }) => parseJsonResponse(message?.content));
    }, attempts);
  }

  // Tool mode: the model calls native functions, so no envelope has to be hand-written.
  // Resolves to { content, toolCalls: [{ id, name, args }] }; content may be empty.
  // `reasoningEffort` overrides the provider default for this call only. `onDelta({ delta, reset })`
  // receives the reply text as it is generated; `reset` is set at the start of every attempt, so a
  // retry after a partially streamed failure tells the client to drop what it already rendered.
  async completeWithTools ({ messages, tools, toolChoice, reasoningEffort, signal, onDelta } = {}) {
    return this.#run(async attempt => {
      if (attempt > 1) onDelta?.({ delta: '', reset: true });
      const choice = await this.request({
        messages, tools, toolChoice, reasoningEffort, signal,
        onDelta: onDelta && (delta => onDelta({ delta })),
      });
      return this.#parse(choice, ({ message }) => {
        const content = typeof message?.content === 'string' ? message.content : '';
        const toolCalls = (message?.tool_calls ?? []).map(call => ({
          id: call.id,
          name: call.function?.name,
          args: parseJsonResponse(call.function?.arguments ?? ''),
        }));
        if (!toolCalls.length && !content.trim()) {
          throw new Error('DeepSeek returned neither a tool call nor content');
        }
        return { content, toolCalls };
      });
    });
  }

  async #run (produce, attempts = this.attempts) {
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await produce(attempt);
      } catch (error) {
        if (!(error instanceof DeepSeekError) || !error.retryable) throw error;
        failure = error;
      }
    }
    throw failure;
  }

  // A completion never performs a write, so a malformed reply is always safe to retry.
  #parse (choice, read) {
    try {
      return read(choice);
    } catch (error) {
      throw new DeepSeekError(describeFailure(error.message, choice), true);
    }
  }

  async request ({ messages, tools, toolChoice, model, reasoningEffort, signal, onDelta }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages are required');
    const body = {
      model: model ?? this.model,
      messages,
      reasoning_effort: apiEffort(reasoningEffort ?? this.reasoningEffort),
    };
    if (tools?.length) {
      // DeepSeek currently ignores parallel_tool_calls, so callers must still handle a batch.
      Object.assign(body, { tools, parallel_tool_calls: false });
      if (toolChoice) body.tool_choice = toolChoice;
    } else {
      body.response_format = { type: 'json_object' };
    }
    // `include_usage` is the only way a streamed reply reports its reasoning tokens, which the failure
    // message needs to tell a budget exhaustion apart from a refusal.
    if (onDelta) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
    const deadline = this.#deadline(signal);
    let response;
    try {
      response = await this.#within(deadline, fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: deadline.controller.signal,
      }));
    } catch (error) {
      deadline.clear();
      throw this.#stopped(deadline) || new DeepSeekError(`DeepSeek request failed: ${failureMessage(error)}`, true);
    }
    if (!response.ok) {
      deadline.clear();
      const stopped = this.#stopped(deadline);
      if (stopped) throw stopped;
      const status = response.status;
      throw new DeepSeekError(`DeepSeek API error: ${status} ${await response.text()}`, RETRYABLE_STATUS.test(String(status)));
    }
    if (onDelta) return this.#readStream(response, onDelta, deadline);
    let payload;
    try {
      payload = await this.#within(deadline, response.json());
    } catch (error) {
      throw this.#stopped(deadline) || new DeepSeekError(`DeepSeek response failed: ${failureMessage(error)}`, true);
    } finally {
      deadline.clear();
    }
    const choice = payload.choices?.[0];
    if (!choice) throw new DeepSeekError('DeepSeek returned no completion choice', true);
    return { ...choice, usage: payload.usage };
  }

  // Rebuilds the same choice shape a non-streaming request returns, so callers cannot tell the two
  // apart. Text deltas are forwarded as they arrive; tool-call fragments are concatenated per `index`
  // because DeepSeek splits both the function name and its JSON arguments across events. A malformed
  // event is retryable: the caller resets the client's rendering before the next attempt.
  async #readStream (response, onDelta, deadline) {
    if (!response.body) throw new DeepSeekError('DeepSeek returned no response body', true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map();
    const choice = { finish_reason: null, usage: undefined, message: { content: '', tool_calls: [] } };
    const handleLine = line => {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') return;
      let event;
      try { event = JSON.parse(data); } catch { throw new DeepSeekError('DeepSeek streamed an unreadable event', true); }
      if (event.usage) choice.usage = event.usage;
      const delta = event.choices?.[0];
      if (!delta) return;
      if (delta.finish_reason) choice.finish_reason = delta.finish_reason;
      const { content, tool_calls: fragments } = delta.delta ?? {};
      if (content) {
        choice.message.content += content;
        onDelta(content);
      }
      (fragments ?? []).forEach(fragment => {
        const index = fragment.index ?? 0;
        const call = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.function.name += fragment.function.name;
        if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
        calls.set(index, call);
      });
    };
    let buffer = '';
    try {
      for (;;) {
        // Every chunk of a streamed reply re-arms the deadline, so only a stalled stream expires.
        const { value, done } = await this.#within(deadline, reader.read());
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(handleLine);
      }
      handleLine(buffer);
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      throw this.#stopped(deadline) || new DeepSeekError(`DeepSeek stream failed: ${failureMessage(error)}`, true);
    } finally {
      deadline.clear();
    }
    choice.message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (!choice.finish_reason) choice.finish_reason = 'stop';
    return choice;
  }
}

function describeFailure (message, choice) {
  const reasoning = choice.usage?.completion_tokens_details?.reasoning_tokens ?? 'unknown';
  return `${message} (finish_reason: ${choice.finish_reason ?? 'unknown'}, reasoning_tokens: ${reasoning})`;
}

const CLOSERS = { '{': '}', '[': ']' };

// DeepSeek composes nested JSON (a JSON-mode object, or a tool call's arguments) and occasionally slips
// by a single token: a truncated final brace, a fenced code block, junk after the object, or a stray
// duplicate top-level key that JSON.parse would silently collapse. Repairing the text keeps a one-token
// slip from discarding an otherwise valid reply.
function parseJsonResponse (content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek returned empty content');
  const text = stripCodeFence(content);
  const repaired = repairJson(text);
  const parsed = tryParse(repaired === null ? text : repaired) ?? tryParse(text);
  if (parsed === undefined) throw new Error('DeepSeek returned invalid JSON');
  return parsed;
}

function tryParse (text) {
  if (typeof text !== 'string' || !text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function stripCodeFence (text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
}

// Rebuilds the outermost JSON value from `text`: it stops at the first balanced close, drops anything
// after it, appends the braces a truncated response dropped, and cuts a duplicate top-level `action`
// key so the model's real action is not overwritten by a later `,"action":null`.
function repairJson (text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastComma = -1;
  let seenAction = false;
  let cut = -1;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        if (stack.length === 1 && stack[0] === '{' && nextIsColon(text, i + 1)) {
          const key = text.slice(stringStart, i);
          if (key !== 'action') continue;
          if (seenAction) { cut = lastComma > start ? lastComma : stringStart; break; }
          seenAction = true;
        }
      }
      continue;
    }
    if (ch === '"') { inString = true; stringStart = i + 1; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) { end = i + 1; break; } }
    else if (ch === ',' && stack.length === 1) lastComma = i;
  }
  const stop = cut >= 0 ? cut : end >= 0 ? end : text.length;
  const closers = stack.map(open => CLOSERS[open]).reverse().join('');
  return text.slice(start, stop) + closers;
}

function nextIsColon (text, from) {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index++;
  return text[index] === ':';
}

module.exports = {
  DeepSeekProvider, parseJsonResponse, apiEffort,
  REASONING_EFFORTS, EFFORT_CHOICES, AUTO_REASONING_EFFORT, DEFAULT_REASONING_EFFORT,
};
