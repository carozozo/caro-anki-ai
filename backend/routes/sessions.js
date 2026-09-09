const sessionRouteFromPath = pathname => {
  const match = pathname.match(
    /^\/api\/sessions\/([^/]+)(?:\/(chat|messages|cards|anki-preview|anki-add|anki-exports))?$/,
  );
  return match ? { id: decodeURIComponent(match[1]), action: match[2] || null } : null;
};

const createSessionRoutes = ({
  EFFORT_CHOICES,
  agentChat,
  agentManager,
  ankiExport,
  cardContract,
  cardProfileLibrary,
  instructionLibrary,
  isCrossOrigin,
  isJsonRequest,
  modelName,
  normalizeNoteIds,
  readJson,
  reportCardProfileFailures,
  reportInstructionFailures,
  repository,
  sendError,
  sendJson,
  serializeExport,
  streamChat,
}) => {
  const serializeCardVersion = version => {
    if (!version) return null;
    const stored = JSON.parse(version.cards_json);
    const contract = cardContract();
    if (!contract) return { ...version, cards: stored, unchanged: Boolean(version.unchanged) };
    const validation = contract.validateCards(stored);
    return {
      ...version,
      cards: validation.cards.map(contract.orderCardFields),
      unchanged: Boolean(version.unchanged),
      validation_status: version.validation_status === 'invalid' || !validation.valid ? 'invalid' : 'valid',
      validationErrors: [...new Set([...JSON.parse(version.validation_errors_json), ...validation.errors])],
    };
  };

  return async ({ req, res, url, activeProfileId }) => {
    const { method, pathname } = req.method ? { method: req.method, pathname: url.pathname } : {};
    if (method === 'GET' && pathname === '/api/sessions') {
      sendJson(res, 200, { ok: true, sessions: repository.listSessions(activeProfileId) });
      return true;
    }
    if (method === 'GET' && pathname === '/api/agent-settings') {
      sendJson(res, 200, { ok: true, ...(await agentManager.settings()) });
      return true;
    }
    if (method === 'PUT' && pathname === '/api/agent-settings') {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else {
        const { enabled, activeProfileId: selectedProfileId } = await readJson(req);
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          sendError(res, 400, 'enabled must be a boolean');
        } else if (selectedProfileId !== undefined && typeof selectedProfileId !== 'string') {
          sendError(res, 400, 'activeProfileId must be a string');
        } else {
          repository.updateAgentSettings({ enabled, activeProfileId: selectedProfileId });
          sendJson(res, 200, { ok: true, ...(await agentManager.settings()) });
        }
      }
      return true;
    }
    if (method === 'POST' && pathname === '/api/agent-profiles') {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else sendJson(res, 201, { ok: true, profile: await agentManager.create(await readJson(req)) });
      return true;
    }
    const agentProfileId = pathname.match(/^\/api\/agent-profiles\/([^/]+)$/)?.[1];
    if (agentProfileId && ['PUT', 'DELETE'].includes(method)) {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
      else {
        const id = decodeURIComponent(agentProfileId);
        if (method === 'DELETE') {
          const deleted = await agentManager.delete(id);
          deleted ? sendJson(res, 200, { ok: true, deleted }) : sendError(res, 404, 'Agent profile not found');
        } else if (!isJsonRequest(req)) {
          sendError(res, 415, 'Content-Type must be application/json');
        } else {
          const profile = await agentManager.update(id, await readJson(req));
          profile ? sendJson(res, 200, { ok: true, profile }) : sendError(res, 404, 'Agent profile not found');
        }
      }
      return true;
    }
    if (method === 'POST' && pathname === '/api/agent/cancel') {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin AI requests are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else {
        const { requestId } = await readJson(req);
        if (typeof requestId !== 'string' || !requestId) sendError(res, 400, 'requestId is required');
        else sendJson(res, 200, { ok: true, cancelled: agentChat.cancel(requestId) });
      }
      return true;
    }
    if (method === 'POST' && pathname === '/api/sessions') {
      const { title } = await readJson(req);
      sendJson(res, 201, {
        ok: true,
        session: repository.createSession({
          title: typeof title === 'string' ? title : undefined,
          profileId: activeProfileId,
        }),
      });
      return true;
    }
    if (method === 'DELETE' && pathname === '/api/sessions') {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin clear requests are not allowed');
      else if (agentChat.busy) sendError(res, 409, 'An AI operation is running');
      else sendJson(res, 200, { ok: true, deleted: repository.clearSessions(activeProfileId) });
      return true;
    }

    const route = sessionRouteFromPath(pathname);
    const sessionId = route?.id;
    if (method === 'DELETE' && sessionId && !route.action) {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin delete requests are not allowed');
      else if (agentChat.busy) sendError(res, 409, 'An AI operation is running');
      else if (!repository.deleteSession(sessionId, activeProfileId)) sendError(res, 404, 'Session not found');
      else sendJson(res, 200, { ok: true, deleted: 1 });
      return true;
    }
    if (method === 'POST' && route?.action === 'chat') {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki writes are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else if (!repository.getSession(sessionId, activeProfileId)) sendError(res, 404, 'Session not found');
      else {
        instructionLibrary.refresh();
        reportInstructionFailures();
        cardProfileLibrary.refresh();
        reportCardProfileFailures();
        const { content, requestId, selectionNoteIds, retry, reasoningEffort, stream } = await readJson(req);
        if (typeof content !== 'string' || !content.trim() || typeof requestId !== 'string' || !requestId) {
          sendError(res, 400, 'content and requestId are required');
        } else if (reasoningEffort !== undefined && !EFFORT_CHOICES.includes(reasoningEffort)) {
          sendError(res, 400, `reasoningEffort must be one of: ${EFFORT_CHOICES.join(', ')}`);
        } else {
          const options = {
            content,
            requestId,
            retry: retry === true,
            reasoningEffort,
            selectionNoteIds: normalizeNoteIds(selectionNoteIds),
          };
          if (stream === true) {
            const outcome = await streamChat(res, emit => agentChat.send(sessionId, { ...options, onEvent: emit }));
            if (outcome.error) {
              sendError(res, outcome.error.statusCode || 500, outcome.error.message, { code: outcome.error.code });
            } else if (!outcome.streamed) {
              sendJson(res, 200, outcome.payload);
            }
          } else {
            sendJson(res, 200, await agentChat.send(sessionId, options));
          }
        }
      }
      return true;
    }
    if (method === 'POST' && ['anki-preview', 'anki-add'].includes(route?.action)) {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin export requests are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) sendError(res, 400, 'Expected JSON object');
        else {
          const result = route.action === 'anki-preview'
            ? await ankiExport.preview(sessionId, body.cardVersionId, body.cardIndex, body.deck)
            : await ankiExport.add(sessionId, body);
          sendJson(res, 200, { ok: true, export: result });
        }
      }
      return true;
    }
    if (method === 'GET' && route?.action === 'anki-exports') {
      if (!repository.getSession(sessionId, activeProfileId)) sendError(res, 404, 'Session not found');
      else sendJson(res, 200, {
        ok: true,
        exports: repository.listAnkiExports(sessionId, activeProfileId).map(serializeExport),
      });
      return true;
    }
    if (method === 'POST' && route?.action === 'messages') {
      sendError(res, 410, 'Use /api/sessions/:id/chat with an Agent profile configured in the app');
      return true;
    }
    if (method === 'PUT' && route?.action === 'cards') {
      if (!repository.getSession(sessionId, activeProfileId)) sendError(res, 404, 'Session not found');
      else {
        const contract = cardContract();
        if (!contract) {
          sendError(res, 503, `No card profile is configured for the ${modelName} note type`);
        } else {
          const validation = contract.validateCards((await readJson(req)).cards);
          const cardVersion = repository.createCardVersion({
            sessionId,
            cards: validation.cards,
            schemaVersion: contract.version,
            source: 'manual',
            validationStatus: validation.valid ? 'valid' : 'invalid',
            validationErrors: validation.errors,
            profileId: activeProfileId,
          });
          sendJson(res, validation.valid ? 200 : 422, {
            ok: validation.valid,
            error: validation.valid ? undefined : 'Card validation failed',
            cardVersion: serializeCardVersion(cardVersion),
          });
        }
      }
      return true;
    }
    if (method === 'GET' && sessionId && !route.action) {
      const session = repository.getSession(sessionId, activeProfileId);
      if (!session) sendError(res, 404, 'Session not found');
      else {
        const currentVersion = repository.getCurrentCardVersion(sessionId, activeProfileId);
        sendJson(res, 200, {
          ok: true,
          session,
          messages: repository.listMessages(sessionId, activeProfileId),
          currentCardVersion: serializeCardVersion(currentVersion),
          cardVersions: repository.listCardVersions(sessionId, activeProfileId).map(serializeCardVersion),
        });
      }
      return true;
    }
    return false;
  };
};

module.exports = { createSessionRoutes };
