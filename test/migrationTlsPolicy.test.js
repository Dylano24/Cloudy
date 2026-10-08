import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const script of ['migrate.js', 'migrate-keys.js']) {
  for (const urlMode of ['disable', 'require']) {
    test(`${script} honors explicit certificate verification over URL sslmode=${urlMode}`, () => {
      const preload = `
        import pg from ${JSON.stringify(import.meta.resolve('pg'))};
        pg.Pool = class {
          constructor(options) {
            const client = new pg.Client(options);
            console.log('__SSL_POLICY__' + JSON.stringify(client.connectionParameters.ssl));
            process.exit(0);
          }
        };
      `;
      const result = spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        `scripts/${script}`,
      ], { cwd: new URL('../', import.meta.url), encoding: 'utf8', env: {
        ...process.env, NODE_ENV: 'test', POSTGRES_SSL: 'verify-full',
        POSTGRES_URL: `postgresql://test:test@localhost/test?sslmode=${urlMode}`,
      } });
      assert.equal(result.status, 0, result.stderr);
      const output = result.stdout.split('\n').find(line => line.startsWith('__SSL_POLICY__'));
      assert.ok(output, result.stdout);
      const policy = JSON.parse(output.slice('__SSL_POLICY__'.length));
      assert.equal(policy.rejectUnauthorized, true);
    });
  }
}
