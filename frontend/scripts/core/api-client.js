((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroApiClient = api;
})(globalThis, () => {
  // A wait this app starts has to end, a request included: a deadline measures silence here exactly like it
  // does on the backend (the bridge's 504 after 30s of nothing, the provider's idle deadline), so whatever
  // proves a request is still alive re-arms it — the sync does that from its progress poll, the chat stream
  // from each event — and the request disarms it the moment it settles. A plain route has no progress to
  // watch, so it arms once and the deadline is its whole duration.
  const armDeadline = idleMs => {
    const controller = new AbortController();
    let live = true;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = live ? setTimeout(() => controller.abort(), idleMs) : null;
    };
    arm();
    return { signal: controller.signal, idleMs, arm, clear: () => { live = false; clearTimeout(timer); } };
  };

  // An abort is this side's own deadline rather than anything the backend said, so it is renamed to what it
  // means; every other failure is reported exactly as the transport reported it.
  const deadlineError = (error, deadline) => (['AbortError', 'TimeoutError'].includes(error.name)
    ? new Error(`The backend stopped answering for ${Math.round(deadline.idleMs / 1000)}s`)
    : error);

  const createClient = ({ config, onAnkiMutation, readEvents }) => {
    // A caller that passes its own `deadline` owns the arming: the sync re-arms it from its progress poll, so a
    // request whose length is Anki's to decide is still bounded by silence instead of by a duration.
    const request = async (url, options = {}) => {
      const { deadline = armDeadline(config.timings.requestTimeoutMs), ...init } = options;
      const startedAt = performance.now();
      let response;
      let payload;
      try {
        response = await fetch(url, {
          headers: { 'Content-Type': 'application/json' }, ...init, signal: deadline.signal,
        });
        payload = await response.json();
      } catch (error) {
        throw deadlineError(error, deadline);
      } finally {
        deadline.clear();
      }
      const totalMs = performance.now() - startedAt;
      const serverMs = Number(response.headers.get('Server-Timing')?.match(/dur=([\d.]+)/)?.[1]) || 0;
      const timing = { url, totalMs, serverMs, clientMs: Math.max(0, totalMs - serverMs) };
      Object.defineProperty(payload, '_timing', { value: timing });
      console.debug('[performance] request', timing);
      if (!response.ok || !payload.ok) {
        throw Object.assign(new Error(payload.error || `Request failed: ${response.status}`),
          { status: response.status, code: payload.code });
      }
      // Every write this app performs reaches Anki through a non-GET /api/anki route, which is this UI's
      // equivalent of the collection change Anki re-checks on. Announcing it here keeps a new route covered.
      if ((options.method || 'GET') !== 'GET' && url.startsWith('/api/anki/') && typeof onAnkiMutation === 'function') {
        onAnkiMutation();
      }
      return payload;
    };

    // A chat request streams the agent's steps back as newline-delimited JSON, so the reply is read event by
    // event instead of as one body at the end. A request that never became a stream (no Agent configured,
    // another run in flight, an unknown request id) still answers with plain JSON and its real status code,
    // so it fails exactly like `request` does. Every event is also the run saying it is still working, which is
    // what keeps this deadline armed while the backend keeps reporting and lets it go when it stops.
    const streamChatRequest = async (url, pending, { onEvent } = {}) => {
      const deadline = armDeadline(config.timings.streamIdleMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...pending, stream: true }),
          signal: deadline.signal,
        });
        if (!(response.headers.get('content-type') || '').startsWith('application/x-ndjson')) {
          const payload = await response.json();
          throw Object.assign(new Error(payload.error || `Request failed: ${response.status}`),
            { status: response.status, code: payload.code });
        }
        let payload = null;
        await readEvents(response, event => {
          deadline.arm();
          if (event.type === 'result') payload = event.payload;
          else if (event.type === 'error') {
            throw Object.assign(new Error(event.error), { status: event.statusCode, code: event.code });
          } else if (typeof onEvent === 'function') onEvent(event);
        });
        if (!payload) throw Object.assign(new Error('The AI stream ended without a result'), { status: 502 });
        return payload;
      } catch (error) {
        throw deadlineError(error, deadline);
      } finally {
        deadline.clear();
      }
    };

    return { armDeadline, deadlineError, request, streamChatRequest };
  };

  return { armDeadline, createClient, deadlineError };
});
