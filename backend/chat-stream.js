const STREAM_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

// Streams one agent run to the client as newline-delimited JSON events. Response headers are written
// lazily, on the first event: a request that fails before any work started (unknown request id, another
// run in flight, no Agent configured) must still answer with one JSON error and its real status code.
// A client that disconnects stops receiving events but never cancels the run, because a collection write
// in flight must finish rather than be replayed later.
async function streamChat (res, run) {
  let opened = false;
  let closed = false;
  res.on('close', () => { closed = true; });
  const emit = event => {
    if (closed || res.writableEnded) return;
    if (!opened) {
      opened = true;
      res.writeHead(200, { 'Content-Type': STREAM_CONTENT_TYPE, 'Cache-Control': 'no-store' });
    }
    res.write(`${JSON.stringify(event)}\n`);
  };
  const finish = () => { if (!closed && !res.writableEnded) res.end(); };
  try {
    const payload = await run(emit);
    if (!opened) return { payload, streamed: false };
    emit({ type: 'result', payload });
    finish();
    return { payload, streamed: true };
  } catch (error) {
    if (!opened) return { error, streamed: false };
    emit({ type: 'error', error: error.message, statusCode: error.statusCode || 500, code: error.code });
    finish();
    return { error, streamed: true };
  }
}

module.exports = { streamChat, STREAM_CONTENT_TYPE };
