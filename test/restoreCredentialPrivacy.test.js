import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('restore diagnostics never include database credentials and keep tool arguments literal', () => {
  const preload = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import winston from ${JSON.stringify(import.meta.resolve('winston'))};
    import { logger } from ${JSON.stringify(new URL('../src/utils/logger.js', import.meta.url).href)};
    childProcess.spawnSync = (command, args, options) => {
      if (options.shell) throw new Error('Database arguments would be interpreted by a shell');
      return { status: 0, stdout: '', stderr: '' };
    };
    syncBuiltinESMExports();
    logger.clear();
    logger.add(new winston.transports.Console({ format: winston.format.json() }));
  `;
  const url = 'postgresql://restore-user:dummy-secret-559@localhost:5432/test';
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    'scripts/restore.js', '--confirm', '--input', 'unused.dump', '--target-url', url,
  ], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'info' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout + result.stderr;
  assert.match(output, /restore\.completed/);
  assert.doesNotMatch(output, /dummy-secret-559|restore-user|postgresql:\/\//);
});
