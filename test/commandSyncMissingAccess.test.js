import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A Discord that knows the bot but answers 403 Missing Access for the main
// server (Cloudy was removed from it): the sync must skip that server and
// exit cleanly, so the bot still starts for every other server.
const FAKE_DISCORD = `
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const method = options.method || 'GET';
  if (target.endsWith('/users/@me')) return json(200, { id: '123456789012345678' });
  if (target.includes('/users/@me/guilds')) return json(200, []);
  if (/\\/applications\\/\\d+\\/commands$/.test(target)) return method === 'GET' ? json(200, []) : json(201, {});
  if (target.includes('/guilds/')) return json(403, { message: 'Missing Access', code: 50001 });
  return json(404, {});
};
`;

test('a main server Cloudy has no access to is skipped instead of stopping the bot start', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cloudy-sync-'));
  try {
    const mock = path.join(directory, 'fake-discord.mjs');
    writeFileSync(mock, FAKE_DISCORD);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, 'scripts/register-cloudy-guild-commands.js'], {
      env: { ...process.env, DISCORD_TOKEN: 'test-token', GUILD_ID: '111111111111111111', COMMAND_SYNC_START_DELAY_MS: '0', COMMAND_SYNC_ONLY_GUILD: '' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /SKIPPED: no access to guild 111111111111111111/);
    assert.doesNotMatch(output, /FATAL/);
    assert.equal(result.status, 0, output.slice(-2000));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
