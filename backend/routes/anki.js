const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

const createAnkiRoutes = ({
  ankiAccount,
  ankiBrowser,
  ankiMaintenance,
  ankiRuntimeStatus,
  ankiSettings,
  isCrossOrigin,
  isJsonRequest,
  readJson,
  selectParams,
  sendError,
  sendJson,
  syncProgress,
}) => async ({ req, res, url }) => {
  const { method, pathname } = req.method ? { method: req.method, pathname: url.pathname } : {};
  if (method === 'GET' && pathname === '/api/anki-settings') {
    sendJson(res, 200, {
      ok: true,
      ...(await ankiSettings.settings()),
      account: await ankiAccount.settings(),
      runtime: ankiRuntimeStatus(),
    });
    return true;
  }
  if (method === 'PUT' && pathname === '/api/anki-settings') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, { ok: true, ...(await ankiSettings.update(await readJson(req))) });
    return true;
  }
  if (method === 'GET' && pathname === '/api/anki/maintenance/backups') {
    sendJson(res, 200, { ok: true, backups: await ankiMaintenance.backups() });
    return true;
  }
  if (method === 'PUT' && pathname === '/api/anki/maintenance/backups') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin backup settings requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, { ok: true, backups: await ankiMaintenance.updateBackups(await readJson(req)) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/maintenance/backup') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin backup requests are not allowed');
    else sendJson(res, 200, { ok: true, backup: await ankiMaintenance.createBackup() });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/maintenance/database') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin database checks are not allowed');
    else sendJson(res, 200, { ok: true, check: await ankiMaintenance.checkDatabase() });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/maintenance/media') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin media checks are not allowed');
    else sendJson(res, 200, { ok: true, check: await ankiMaintenance.checkMedia() });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/account/login') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin account requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, { ok: true, account: await ankiAccount.login(await readJson(req)) });
    return true;
  }
  if (method === 'DELETE' && pathname === '/api/anki/account') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin account requests are not allowed');
    else sendJson(res, 200, { ok: true, account: await ankiAccount.logout() });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/sync') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin sync requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const { direction } = await readJson(req);
      sendJson(res, 200, { ok: true, sync: await ankiAccount.sync({ direction: direction ?? null }) });
    }
    return true;
  }
  if (method === 'GET' && pathname === '/api/anki/sync-progress') {
    sendJson(res, 200, { ok: true, progress: syncProgress.snapshot() });
    return true;
  }
  if (method === 'GET' && pathname === '/api/anki/sync-status') {
    sendJson(res, 200, { ok: true, ...(await ankiAccount.syncStatus()) });
    return true;
  }

  if (method === 'GET' && pathname === '/api/anki/decks') {
    sendJson(res, 200, { ok: true, ...(await ankiBrowser.meta(selectParams(url))) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/decks') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin deck requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 201, { ok: true, deck: await ankiBrowser.createDeck(await readJson(req)) });
    return true;
  }
  const deckRoute = pathname.match(/^\/api\/anki\/decks\/([^/]+)$/);
  if (deckRoute && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin deck requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const deck = await ankiBrowser.renameDeck(decodeURIComponent(deckRoute[1]), await readJson(req));
      await ankiSettings.renameVisibleDecks(deck.oldName, deck.name);
      sendJson(res, 200, { ok: true, deck });
    }
    return true;
  }
  if (deckRoute && method === 'DELETE') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin deck requests are not allowed');
    else {
      const result = await ankiBrowser.deleteDeck(decodeURIComponent(deckRoute[1]));
      await ankiSettings.removeVisibleDecks(result.deleted);
      sendJson(res, 200, { ok: true, ...result });
    }
    return true;
  }
  if (method === 'GET' && pathname === '/api/anki/study-options') {
    const presetId = url.searchParams.get('presetId');
    sendJson(res, 200, {
      ok: true,
      ...(await ankiBrowser.studyOptions({ ...selectParams(url), presetId: presetId || undefined })),
    });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/study-options') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin study option requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 201, { ok: true, preset: await ankiBrowser.createStudyOptions(await readJson(req)) });
    return true;
  }
  const studyOptionRoute = pathname.match(/^\/api\/anki\/study-options\/([^/]+)$/);
  if (studyOptionRoute && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin study option requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const id = decodeURIComponent(studyOptionRoute[1]);
      sendJson(res, 200, { ok: true, preset: await ankiBrowser.updateStudyOptions(id, await readJson(req)) });
    }
    return true;
  }
  if (studyOptionRoute && method === 'DELETE') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin study option requests are not allowed');
    else {
      const id = decodeURIComponent(studyOptionRoute[1]);
      sendJson(res, 200, { ok: true, ...(await ankiBrowser.deleteStudyOptions(id)) });
    }
    return true;
  }
  const deckStudyOptionRoute = pathname.match(/^\/api\/anki\/decks\/([^/]+)\/study-options$/);
  if (deckStudyOptionRoute && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin deck requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const deckName = decodeURIComponent(deckStudyOptionRoute[1]);
      sendJson(res, 200, { ok: true, ...(await ankiBrowser.setDeckStudyOptions(deckName, await readJson(req))) });
    }
    return true;
  }

  if (method === 'GET' && pathname === '/api/anki/models') {
    sendJson(res, 200, { ok: true, models: await ankiBrowser.models(selectParams(url)) });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/models') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 201, { ok: true, model: await ankiBrowser.createModel(await readJson(req)) });
    return true;
  }
  const modelRoute = pathname.match(/^\/api\/anki\/models\/([^/]+)$/);
  if (modelRoute && method === 'GET') {
    const model = await ankiBrowser.model(decodeURIComponent(modelRoute[1]), selectParams(url));
    sendJson(res, 200, { ok: true, model });
    return true;
  }
  if (modelRoute && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, {
      ok: true,
      model: await ankiBrowser.updateModel(decodeURIComponent(modelRoute[1]), await readJson(req)),
    });
    return true;
  }
  if (modelRoute && method === 'DELETE') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else sendJson(res, 200, { ok: true, ...(await ankiBrowser.deleteModel(decodeURIComponent(modelRoute[1]))) });
    return true;
  }
  const modelFields = pathname.match(/^\/api\/anki\/models\/([^/]+)\/fields$/);
  if (modelFields && method === 'POST') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 201, {
      ok: true,
      model: await ankiBrowser.addModelField(decodeURIComponent(modelFields[1]), await readJson(req)),
    });
    return true;
  }
  const modelField = pathname.match(/^\/api\/anki\/models\/([^/]+)\/fields\/([^/]+)$/);
  if (modelField && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, {
      ok: true,
      model: await ankiBrowser.updateModelField(
        decodeURIComponent(modelField[1]), decodeURIComponent(modelField[2]), await readJson(req),
      ),
    });
    return true;
  }
  if (modelField && method === 'DELETE') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else sendJson(res, 200, {
      ok: true,
      model: await ankiBrowser.deleteModelField(decodeURIComponent(modelField[1]), decodeURIComponent(modelField[2])),
    });
    return true;
  }
  const modelTemplates = pathname.match(/^\/api\/anki\/models\/([^/]+)\/templates$/);
  if (modelTemplates && method === 'POST') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 201, {
      ok: true,
      model: await ankiBrowser.addModelTemplate(decodeURIComponent(modelTemplates[1]), await readJson(req)),
    });
    return true;
  }
  const modelTemplate = pathname.match(/^\/api\/anki\/models\/([^/]+)\/templates\/([^/]+)$/);
  if (modelTemplate && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, {
      ok: true,
      model: await ankiBrowser.updateModelTemplate(
        decodeURIComponent(modelTemplate[1]), decodeURIComponent(modelTemplate[2]), await readJson(req),
      ),
    });
    return true;
  }
  if (modelTemplate && method === 'DELETE') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin note type requests are not allowed');
    else sendJson(res, 200, {
      ok: true,
      model: await ankiBrowser.deleteModelTemplate(
        decodeURIComponent(modelTemplate[1]), decodeURIComponent(modelTemplate[2]),
      ),
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/anki/tags') {
    sendJson(res, 200, {
      ok: true,
      ...(await ankiBrowser.tags({
        query: url.searchParams.get('query'),
        select: url.searchParams.get('select'),
        limit: url.searchParams.get('limit'),
        all: url.searchParams.get('all') === 'true',
      })),
    });
    return true;
  }
  if (method === 'DELETE' && pathname === '/api/anki/tags' && url.searchParams.get('unused') === 'true') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin tag requests are not allowed');
    else sendJson(res, 200, { ok: true, ...(await ankiBrowser.clearUnusedTags()) });
    return true;
  }
  const tagRoute = pathname.match(/^\/api\/anki\/tags\/([^/]+)$/);
  if (tagRoute && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin tag requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else sendJson(res, 200, {
      ok: true,
      tag: await ankiBrowser.renameTag(decodeURIComponent(tagRoute[1]), await readJson(req)),
    });
    return true;
  }
  if (tagRoute && method === 'DELETE') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin tag requests are not allowed');
    else sendJson(res, 200, { ok: true, ...(await ankiBrowser.deleteTag(decodeURIComponent(tagRoute[1]))) });
    return true;
  }

  if (method === 'GET' && pathname === '/api/anki/notes') {
    const result = await ankiBrowser.search({
      query: url.searchParams.get('query'),
      skip: url.searchParams.get('skip'),
      limit: Number(url.searchParams.get('limit')),
      all: url.searchParams.get('all') === 'true',
      includeIds: url.searchParams.get('includeIds') === 'true',
      sortField: url.searchParams.get('sortField'),
      sortDirection: url.searchParams.get('sortDirection'),
      select: url.searchParams.get('select'),
      fields: (url.searchParams.get('fields') || '').split(',').map(name => name.trim()).filter(Boolean),
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }
  if (method === 'GET' && pathname === '/api/anki/notes/new') {
    sendJson(res, 200, {
      ok: true,
      note: await ankiBrowser.newNoteTemplate({
        ...selectParams(url), modelName: url.searchParams.get('modelName') || undefined,
      }),
    });
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/notes') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const body = await readJson(req);
      if (!isObject(body)) sendError(res, 400, 'Expected JSON object');
      else sendJson(res, 201, { ok: true, note: await ankiBrowser.createNote(body) });
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/anki/notes/batch') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const body = await readJson(req);
      if (!isObject(body)) sendError(res, 400, 'Expected JSON object');
      else {
        const result = body.action === 'changeDeck'
          ? await ankiBrowser.batchChangeDeck(body)
          : body.action === 'setDueDate'
            ? await ankiBrowser.batchSetDueDate(body)
            : body.action === 'setFlag'
              ? await ankiBrowser.batchSetNoteFlag(body)
              : body.action === 'copy'
                ? await ankiBrowser.batchCopyNotes(body)
                : body.action === 'delete'
                  ? await ankiBrowser.batchDeleteNotes(body)
                  : body.action === 'findReplace'
                    ? await ankiBrowser.batchFindReplace(body)
                    : null;
        if (!result) sendError(res, 400, 'action must be changeDeck, setDueDate, setFlag, copy, delete or findReplace');
        else sendJson(res, 200, { ok: true, result });
      }
    }
    return true;
  }
  if (method === 'GET' && pathname === '/api/anki/undo-status') {
    sendJson(res, 200, { ok: true, status: await ankiBrowser.undoStatus() });
    return true;
  }
  if (method === 'POST' && (pathname === '/api/anki/undo' || pathname === '/api/anki/redo')) {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else {
      const status = pathname === '/api/anki/undo' ? await ankiBrowser.undo() : await ankiBrowser.redo();
      sendJson(res, 200, { ok: true, status });
    }
    return true;
  }
  const noteId = pathname.match(/^\/api\/anki\/notes\/([^/]+)$/)?.[1];
  if (noteId && ['GET', 'PUT', 'DELETE'].includes(method)) {
    if (method === 'GET') sendJson(res, 200, { ok: true, note: await ankiBrowser.getNote(noteId, selectParams(url)) });
    else if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else if (method === 'DELETE') {
      sendJson(res, 200, { ok: true, note: await ankiBrowser.deleteNote(decodeURIComponent(noteId)) });
    }
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const body = await readJson(req);
      if (!isObject(body)) sendError(res, 400, 'Expected JSON object');
      else sendJson(res, 200, { ok: true, note: await ankiBrowser.updateNote(decodeURIComponent(noteId), body) });
    }
    return true;
  }
  const previewId = pathname.match(/^\/api\/anki\/notes\/([^/]+)\/preview$/)?.[1];
  if (previewId && method === 'GET') {
    sendJson(res, 200, { ok: true, preview: await ankiBrowser.previewNote(decodeURIComponent(previewId)) });
    return true;
  }
  const copyId = pathname.match(/^\/api\/anki\/notes\/([^/]+)\/copy$/)?.[1];
  if (copyId && method === 'POST') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else sendJson(res, 201, { ok: true, note: await ankiBrowser.copyNote(decodeURIComponent(copyId)) });
    return true;
  }
  const tagsId = pathname.match(/^\/api\/anki\/notes\/([^/]+)\/tags$/)?.[1];
  if (tagsId && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const body = await readJson(req);
      if (!isObject(body)) sendError(res, 400, 'Expected JSON object');
      else sendJson(res, 200, { ok: true, note: await ankiBrowser.updateNoteTags(decodeURIComponent(tagsId), body) });
    }
    return true;
  }
  const dueId = pathname.match(/^\/api\/anki\/notes\/([^/]+)\/due$/)?.[1];
  if (dueId && method === 'PUT') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const body = await readJson(req);
      if (!isObject(body)) sendError(res, 400, 'Expected JSON object');
      else sendJson(res, 200, {
        ok: true,
        note: await ankiBrowser.changeNoteDueDate(decodeURIComponent(dueId), body),
      });
    }
    return true;
  }
  return false;
};

module.exports = { createAnkiRoutes };
