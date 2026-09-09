const profileRouteFromPath = pathname => {
  const match = pathname.match(/^\/api\/profiles\/([^/]+)\/(rename|activate)$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : null;
};

const createProfileRoutes = ({ profileManager, isCrossOrigin, isJsonRequest, readJson, sendError, sendJson }) =>
  async ({ req, res, url }) => {
    if (req.method === 'GET' && url.pathname === '/api/profiles') {
      sendJson(res, 200, { ok: true, ...profileManager.list() });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/profiles') {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin profile requests are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else sendJson(res, 201, { ok: true, ...(await profileManager.create(await readJson(req))) });
      return true;
    }
    const route = profileRouteFromPath(url.pathname);
    if (req.method === 'POST' && route) {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin profile requests are not allowed');
      else if (!isJsonRequest(req)) sendError(res, 415, 'Content-Type must be application/json');
      else {
        const body = await readJson(req);
        const result = route.action === 'rename'
          ? await profileManager.rename({ id: route.id, ...body })
          : await profileManager.activate({ id: route.id });
        sendJson(res, 200, { ok: true, ...result });
      }
      return true;
    }
    const id = url.pathname.match(/^\/api\/profiles\/([^/]+)$/)?.[1];
    if (req.method === 'DELETE' && id) {
      if (isCrossOrigin(req)) sendError(res, 403, 'Cross-origin profile requests are not allowed');
      else sendJson(res, 200, { ok: true, ...(await profileManager.remove({ id: decodeURIComponent(id) })) });
      return true;
    }
    return false;
  };

module.exports = { createProfileRoutes };
