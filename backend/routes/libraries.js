const skillMarkdown = ({ name, description, body = '' }) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

const createLibraryRoutes = ({
  agentMemory,
  instructionLibrary,
  isCrossOrigin,
  isJsonRequest,
  readJson,
  sendError,
  sendJson,
  skillLibrary,
}) => async ({ req, res, url }) => {
  const { method, pathname } = req.method ? { method: req.method, pathname: url.pathname } : {};
  if (method === 'GET' && pathname === '/api/skills') {
    skillLibrary.refresh();
    sendJson(res, 200, { ok: true, skills: skillLibrary.entries(), errors: skillLibrary.errors() });
    return true;
  }
  if (method === 'GET' && pathname === '/api/instructions') {
    instructionLibrary.refresh();
    sendJson(res, 200, { ok: true, instructions: instructionLibrary.entries(), errors: instructionLibrary.errors() });
    return true;
  }
  if (method === 'GET' && pathname === '/api/memories') {
    agentMemory.refresh();
    sendJson(res, 200, { ok: true, memories: agentMemory.entries(), errors: agentMemory.errors() });
    return true;
  }

  const libraryRoute = (prefix, library, singular) => pathname.startsWith(prefix) && ({
    name: decodeURIComponent(pathname.slice(prefix.length)), library, singular,
  });
  const markdownRoute = libraryRoute('/api/instructions/', instructionLibrary, 'instruction')
    || libraryRoute('/api/memories/', agentMemory, 'memory');
  if (markdownRoute && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
    else if (method !== 'DELETE' && !isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else if (method === 'PUT') {
      sendJson(res, 200, { ok: true, [markdownRoute.singular]: markdownRoute.library.save(
        markdownRoute.name, (await readJson(req)).content,
      ) });
    } else if (method === 'PATCH') {
      sendJson(res, 200, { ok: true, [markdownRoute.singular]: markdownRoute.library.rename(
        markdownRoute.name, (await readJson(req)).to,
      ) });
    } else {
      sendJson(res, 200, { ok: true, [markdownRoute.singular]: markdownRoute.library.remove(markdownRoute.name) });
    }
    return true;
  }
  const markdownCollection = {
    '/api/instructions': [instructionLibrary, 'instruction'],
    '/api/memories': [agentMemory, 'memory'],
  }[pathname];
  if (method === 'POST' && markdownCollection) {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const [library, singular] = markdownCollection;
      const { name, content } = await readJson(req);
      const plan = library.check(name, content);
      if (!plan.created) sendError(res, 409, `${singular} already exists: ${plan.name}`);
      else sendJson(res, 201, { ok: true, [singular]: library.save(name, content) });
    }
    return true;
  }

  if (pathname.startsWith('/api/skills/') && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
    else if (method !== 'DELETE' && !isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
      if (method === 'PUT') {
        const skill = skillLibrary.resolve(name);
        const content = String((await readJson(req)).body ?? '');
        sendJson(res, 200, { ok: true, skill: skillLibrary.save(name, [{ path: 'SKILL.md',
          content: skillMarkdown({ name: skill.name, description: skill.description, body: content }) }]) });
      } else if (method === 'PATCH') {
        sendJson(res, 200, { ok: true, skill: skillLibrary.rename(name, (await readJson(req)).to) });
      } else {
        sendJson(res, 200, { ok: true, skill: skillLibrary.remove(name) });
      }
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/skills') {
    if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin settings requests are not allowed');
    else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
    else {
      const { name, description, body } = await readJson(req);
      const files = [{ path: 'SKILL.md', content: skillMarkdown({ name, description, body }) }];
      const plan = skillLibrary.check(name, files);
      if (!plan.created) sendError(res, 409, `skill already exists: ${plan.name}`);
      else sendJson(res, 201, { ok: true, skill: skillLibrary.save(name, files) });
    }
    return true;
  }
  return false;
};

module.exports = { createLibraryRoutes };
