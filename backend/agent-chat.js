class AgentChat {
  constructor ({ db, repository, agent, getAgent, getProfileId = null }) {
    Object.assign(this, { db, repository, agent, getAgent, getProfileId, busy: false, current: null });
  }

  // A refusal carries a code, because the caller's question is never "which status" but "did this turn
  // start": a request the backend never began may be sent again as it stands, while an unfinished run has to
  // be inspected first. Both answers are a 409, so the status alone cannot tell them apart.
  async send (sessionId, { content, requestId, selectionNoteIds = [], retry = false, reasoningEffort, onEvent = () => {} }) {
    const fail = (message, code) => { throw Object.assign(new Error(message), { statusCode: 409, code }); };
    const profileId = this.getProfileId?.() || null;
    if (!this.repository.getSession(sessionId, profileId)) {
      throw Object.assign(new Error('Session not found'), { statusCode: 404 });
    }
    const existing = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(requestId);
    if (existing) {
      if (existing.session_id !== sessionId || existing.content !== content) fail('Request ID already used', 'request_reused');
      if (existing.result_json) return JSON.parse(existing.result_json);
      fail('Operation pending or interrupted; inspect the collection and history before retrying', 'run_pending');
    }
    // The reservation is taken before this method's first `await`: a caller that only set the flag after one
    // let a second turn start beside the first, and this flag is the whole of "one collection write at a
    // time". `finally` covers a failing agent lookup too, so the slot is never held by a turn that never ran.
    if (this.busy) fail('Another AI operation is running', 'not_started');
    this.busy = true;
    // The run that holds the slot is the only thing cancel can name, and the token is what makes that
    // explicit: a stop for any other request is a stop for a turn that already ended, which is not an
    // error to report back. The slot is released in `finally`, so a stopped run frees it like any other.
    const cancel = new AbortController();
    this.current = { requestId, cancel };
    try {
      const agent = this.getAgent ? await this.getAgent() : this.agent;
      this.db.prepare('INSERT INTO agent_runs (id, session_id, content) VALUES (?, ?, ?)')
        .run(requestId, sessionId, content);
      return await this.run(sessionId, {
        content, requestId, selectionNoteIds, retry, reasoningEffort, agent, onEvent, signal: cancel.signal,
      }, profileId);
    } finally {
      this.current = null;
      this.busy = false;
    }
  }

  // Stopping a run is a request, not a kill: the run reads it at its next step boundary, so a write already
  // in flight finishes and nothing is left half-applied. `false` means the run was already over — the one
  // answer that needs no sentence.
  cancel (requestId) {
    if (this.current?.requestId !== requestId) return false;
    this.current.cancel.abort();
    return true;
  }

  async run (sessionId, { content, requestId, selectionNoteIds = [], retry = false, reasoningEffort, agent,
    onEvent = () => {}, signal }, profileId = null) {
    const newConversation = this.repository.listMessages(sessionId, profileId).length === 0;
    const userMessage = this.repository.addMessage({
      sessionId, role: 'user', content, payload: { requestId, selectionNoteIds, retry, reasoningEffort }, profileId,
    });
    let failed = false;
    let result;
    try {
      result = await agent.respond({
        messages: this.repository.listMessages(sessionId, profileId),
        selectionNoteIds,
        retry,
        reasoningEffort,
        signal,
        onEvent,
        record: operation => {
          const message = this.repository.addMessage({
            sessionId, role: 'tool', content: JSON.stringify(operation), payload: operation, profileId,
          });
          onEvent({ type: 'tool', operation, message });
          return message;
        },
      });
    } catch (error) {
      failed = true;
      result = {
        content: error.userMessage
          || `Run stopped: ${error.message}. The result of a write may be uncertain; check Anki's actual state before retrying.`,
        operations: [],
      };
    }
    const assistantMessage = this.repository.addMessage({
      sessionId, role: 'assistant', content: result.content,
      // A stopped run says so in the reply's payload: its steps ran to their end like any other run's, so the
      // record of why the run ended early has to be the reply itself and not the steps it managed first.
      payload: failed ? { failed: true, retry: { content, selectionNoteIds, reasoningEffort } }
        : result.cancelled ? { cancelled: true }
          : result.stepLimitReached ? { stepLimitReached: true, stepLimit: result.stepLimit } : null, profileId,
    });
    if (newConversation && typeof agent.summarizeTitle === 'function') {
      try {
        const title = await agent.summarizeTitle({ content, answer: result.content, signal });
        this.repository.updateSessionTitle(sessionId, title, profileId);
      } catch {}
    }
    const payload = { ok: true, userMessage, assistantMessage, ...result, failed };
    this.db.prepare("UPDATE agent_runs SET status = 'completed', result_json = ? WHERE id = ?")
      .run(JSON.stringify(payload), requestId);
    return payload;
  }
}

module.exports = { AgentChat };
