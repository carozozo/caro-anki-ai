const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const sendJson = (res, statusCode, payload) => {
  const timing = res.apiStartedAt === undefined ? {} : {
    'Server-Timing': `app;dur=${(performance.now() - res.apiStartedAt).toFixed(1)}`,
  };
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...timing });
  res.end(JSON.stringify(payload));
};

const sendError = (res, statusCode, message, extra) =>
  sendJson(res, statusCode, { ok: false, error: message, ...extra });

const isCrossOrigin = req => {
  const { origin, 'sec-fetch-site': fetchSite } = req.headers;
  return Boolean(origin && origin !== `http://${req.headers.host}`) || fetchSite === 'cross-site';
};

const isJsonRequest = req => req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json';

const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) reject(new Error('Payload too large'));
  });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const readJson = async req => {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
};

const selectParams = url => ({ select: url.searchParams.get('select') });
const normalizeNoteIds = (value, limit = 50) => Array.isArray(value)
  ? [...new Set(value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, limit)
  : [];

const createStaticHandler = ({ frontendDir, appTitle }) => (req, res, pathname) => {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(frontendDir, `.${requestedPath}`);
  if (filePath !== frontendDir && !filePath.startsWith(`${frontendDir}${path.sep}`)) {
    return sendError(res, 400, 'Invalid path');
  }
  try {
    const source = fs.readFileSync(filePath);
    const content = filePath === path.join(frontendDir, 'index.html')
      ? source.toString().replace('{{APP_TITLE}}', appTitle)
      : source;
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendError(res, 404, 'Not found');
    throw error;
  }
};

module.exports = {
  createStaticHandler,
  isCrossOrigin,
  isJsonRequest,
  normalizeNoteIds,
  readJson,
  selectParams,
  sendError,
  sendJson,
};
