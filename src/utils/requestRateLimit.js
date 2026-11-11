// The web server's request limits.
//
// One shared limit used to cover everything. Two things were wrong with it:
// behind Railway's proxy every visitor had the proxy's address, so all
// visitors shared one budget, and that budget (100 requests per 15 minutes)
// is far below what one person editing in the Embed Builder's browser editor
// sends (a heartbeat every 20 seconds and one request per edit).
//
// Now each visitor has their own budget per kind of request, and the health
// checks Railway and the monitor depend on are never limited.

const MINUTE = 60_000;

/** GET /health and GET /ready are answered from memory and never limited. */
export function isHealthCheck(method, path) {
  return method === 'GET' && (path === '/health' || path === '/ready');
}

/**
 * The limit for one request path: { name, windowMs, max }.
 * `fallback` is the configured general limit ({ windowMs, max }).
 */
export function requestLimitFor(path, fallback) {
  const route = String(path || '');
  // The Embed Builder's browser editor: page, heartbeat and every edit.
  if (route === '/embed-color' || route.startsWith('/api/embed-color/')) {
    return { name: 'editor', windowMs: MINUTE, max: 1_200 };
  }
  // Pictures and videos Cloudy hosts for Discord (banners, deleted videos).
  // Discord fetches these through a small set of its own addresses.
  if (route.startsWith('/cloudy-embed-media/') || route.startsWith('/deleted-media/')) {
    return { name: 'media', windowMs: MINUTE, max: 600 };
  }
  return { name: 'general', windowMs: fallback.windowMs, max: fallback.max };
}

/**
 * Express "trust proxy" setting. On Railway exactly one proxy stands in front
 * of the container, so the last address it adds is the visitor's own; without
 * this every visitor looks like the proxy. Elsewhere nothing is trusted unless
 * TRUST_PROXY_HOPS says how many proxies there are (0 turns it off).
 */
export function trustProxySetting(env = process.env) {
  const configured = String(env.TRUST_PROXY_HOPS ?? '').trim();
  if (/^\d{1,2}$/.test(configured)) return Number(configured) || false;
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  return onRailway ? 1 : false;
}
