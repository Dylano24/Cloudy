import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCredentialVariable, withoutCredentials } from '../src/utils/childProcessEnvironment.js';
import { runFeedExtractor } from '../src/services/cloudyFeedExtractorService.js';
import { runLocalCommand } from '../src/services/cloudyFeedVideoClip.js';

// Media tools work on files and pages from outside Cloudy. They must never be
// handed Cloudy's own credentials through their environment.

// The variable names configured for Cloudy in production (names only).
const CREDENTIALS = [
  'DISCORD_TOKEN', 'TOKEN', 'BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'POPULATION_BOT_TOKENS',
  'CLOUDY_ASSISTANT_SHARED_SECRET', 'CLOUDY_DASHBOARD_API_SECRET', 'CLOUDY_GAME_FEED_SECRET',
  'GIVEAWAY_CLAIM_ENCRYPTION_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
  'POSTGRES_URL', 'POSTGRES_PASSWORD', 'POSTGRES_USER', 'POSTGRES_HOST', 'POSTGRES_DB', 'DATABASE_URL',
  'DATABASE_PRIVATE_URL', 'REDIS_URL', 'REDIS_PASSWORD', 'REDIS_HOST',
];
const NEEDED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'PYTHONPATH', 'PYTHONIOENCODING', 'LD_LIBRARY_PATH', 'NODE_ENV', 'CLOUDY_EMBED_MEDIA_DIR', 'XDG_CACHE_HOME'];

test('credentials are dropped by name; what a tool needs to run is kept', () => {
  for (const name of CREDENTIALS) assert.equal(isCredentialVariable(name), true, name);
  for (const name of NEEDED) assert.equal(isCredentialVariable(name), false, name);
  const source = Object.fromEntries([...CREDENTIALS, ...NEEDED].map(name => [name, `value-of-${name}`]));
  assert.deepEqual(Object.keys(withoutCredentials(source)).sort(), [...NEEDED].sort());
  assert.equal(source.DISCORD_TOKEN, 'value-of-DISCORD_TOKEN', 'the given environment itself is not changed');
});

test('a real extractor process does not receive Cloudy credentials', async t => {
  const saved = {};
  const planted = { DISCORD_TOKEN: 'planted-bot-token', POSTGRES_URL: 'postgresql://planted', OPENAI_API_KEY: 'planted-key' };
  for (const [name, value] of Object.entries(planted)) { saved[name] = process.env[name]; process.env[name] = value; }
  t.after(() => {
    for (const name of Object.keys(planted)) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  });
  // The launcher adds "--proxy <address>" after these arguments; node passes them to the script.
  const printed = await runFeedExtractor(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.env))', '--']);
  const seen = JSON.parse(printed);
  for (const name of Object.keys(planted)) assert.equal(seen[name], undefined, `${name} must not reach the extractor`);
  assert.ok(seen.PATH, 'PATH is kept so the tool can run');
  assert.equal(seen.HTTPS_PROXY, '', 'user-configured proxies stay cleared');
});

test('ffmpeg and ffprobe are started without Cloudy credentials', async t => {
  const previous = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = 'planted-bot-token';
  t.after(() => { if (previous === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = previous; });
  const printed = await runLocalCommand(process.execPath,
    ['-e', 'process.stdout.write(String(process.env.DISCORD_TOKEN) + "|" + Boolean(process.env.PATH))'], 10_000);
  assert.equal(printed, 'undefined|true');
});

test('every media tool launch in the bot uses the credential-free environment', () => {
  for (const file of ['src/services/cloudyFeedExtractorService.js', 'src/services/cloudyFeedVideoClip.js', 'src/services/videoGifService.js']) {
    const source = readFileSync(file, 'utf8');
    const launches = source.match(/\bspawn\([^;]*;/gs) || [];
    assert.ok(launches.length > 0, `${file} launches a tool`);
    for (const launch of launches) assert.match(launch, /withoutCredentials\(\)/, `${file}: ${launch.slice(0, 60)}`);
  }
});
