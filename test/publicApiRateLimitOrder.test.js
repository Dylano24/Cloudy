import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Order matters in Express: a route registered before this middleware
// is able to respond without ever reaching the global request limiter.
test('every public application API is registered after the shared request limiter', () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const limiterStart = source.indexOf('const requestCounts = new Map();');
  const limitResponse = source.indexOf(
    "return res.status(429).json({ error: 'Too many requests' });",
    limiterStart,
  );
  const limiterEnd = source.indexOf('    });', limitResponse);
  assert.ok(limiterStart >= 0, 'global request limiter must be present');
  assert.ok(limitResponse > limiterStart, 'limiter must enforce HTTP 429');
  assert.ok(limiterEnd > limitResponse, 'limiter middleware must be closed');

  const parserStart = source.indexOf("app.use('/api/appeals', express.json(");
  assert.ok(parserStart > limiterEnd, 'rate limiting must run before request body parsing');

  for (const registration of [
    'registerAppealsApi(app, this);',
    'registerWebsiteAssistantApi(app);',
    'registerEmbedMediaRoutes(app);',
  ]) {
    const index = source.indexOf(registration);
    assert.ok(index > limiterEnd, `${registration} must be protected by the limiter`);
    assert.equal(source.indexOf(registration, index + 1), -1, 'API must be registered exactly once');
  }
});
