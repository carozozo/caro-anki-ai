const { createAnkiRoutes } = require('./anki');
const { createLibraryRoutes } = require('./libraries');
const { createProfileRoutes } = require('./profiles');
const { createSessionRoutes } = require('./sessions');

const createApiRoutes = ({ ankiRuntimeStatus, profileManager, sendError, sendJson, ...dependencies }) => {
  const profileRoutes = createProfileRoutes({ profileManager, sendError, sendJson, ...dependencies });
  const activeRoutes = [
    createLibraryRoutes({ sendError, sendJson, ...dependencies }),
    createAnkiRoutes({ ankiRuntimeStatus, sendError, sendJson, ...dependencies }),
    createSessionRoutes({ sendError, sendJson, ...dependencies }),
  ];

  return async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'caro-anki', anki: ankiRuntimeStatus() });
      return;
    }
    if (await profileRoutes({ req, res, url })) return;
    return profileManager.useActive(async ({ profileId }) => {
      for (const route of activeRoutes) {
        if (await route({ req, res, url, activeProfileId: profileId })) return;
      }
      sendError(res, 404, 'API route not found');
    });
  };
};

module.exports = { createApiRoutes };
