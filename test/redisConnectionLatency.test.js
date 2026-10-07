import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';

test('an unreachable Redis cache falls back promptly and does not reconnect on every read', async t => {
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://cache.invalid:6379';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connections = 0;
  let destroyed = 0;
  t.mock.method(net, 'createConnection', () => {
    connections += 1;
    const socket = new EventEmitter();
    socket.destroy = () => { destroyed += 1; socket.destroyed = true; };
    return socket;
  });
  const cache = await import('../src/utils/redisCache.js?connection-latency');
  let settled = false;
  const pending = cache.redisGetJson('test').then(value => {
    settled = true;
    return value;
  });
  t.mock.timers.tick(300);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(settled, true, 'cache connection must not hold a database read indefinitely');
  assert.equal(await pending, null);
  assert.equal(destroyed, 1);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => cache.redisGetJson('test'))), Array(20).fill(null));
  assert.equal(connections, 1, 'failed cache reads must bypass the cache during backoff');
});

test('TLS handshake timeout falls back as well as plain TCP', async t => {
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = 'rediss://cache.invalid:6379';
  t.after(() => { if (previousUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousUrl; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let destroyed = 0;
  const socket = new EventEmitter(); socket.destroy = () => { destroyed += 1; socket.destroyed = true; };
  t.mock.method(tls, 'connect', () => socket);
  const cache = await import('../src/utils/redisCache.js?tls-latency');
  const pending = cache.redisGetJson('tls-key');
  t.mock.timers.tick(251);
  assert.equal(await pending, null);
  assert.equal(destroyed, 1);
});

test('a stalled AUTH response is bounded and cannot leak unauthenticated GET commands', async t => {
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://:test-password@cache.invalid:6379';
  t.after(() => { if (previousUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousUrl; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const socket = new EventEmitter(); socket.destroy = () => { socket.destroyed = true; };
  socket.write = buffer => { commands.push(buffer.toString().split('\r\n')[2]); };
  t.mock.method(net, 'createConnection', () => { queueMicrotask(() => socket.emit('connect')); return socket; });
  const cache = await import('../src/utils/redisCache.js?stalled-auth-latency');
  const reads = Promise.all(Array.from({ length: 10 }, () => cache.redisGetJson('safe-key')));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  t.mock.timers.tick(801);
  assert.deepEqual(await reads, Array(10).fill(null));
  assert.deepEqual(commands, ['AUTH']);
  assert.equal(socket.destroyed, true);
});

test('concurrent cache reads wait for authentication and share one healthy connection', async t => {
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://cache-user:test-password@cache.invalid:6379';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
  });
  let connections = 0, releaseAuth;
  const commands = [];
  const socket = new EventEmitter();
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (buffer, callback) => {
    const command = buffer.toString().split('\r\n')[2];
    commands.push(command);
    callback?.();
    if (command === 'AUTH') releaseAuth = () => socket.emit('data', Buffer.from('+OK\r\n'));
    else if (command === 'PING') queueMicrotask(() => socket.emit('data', Buffer.from('+PONG\r\n')));
    else if (command === 'GET') {
      const json = '{"count":1}';
      queueMicrotask(() => socket.emit('data', Buffer.from(`$${Buffer.byteLength(json)}\r\n${json}\r\n`)));
    }
  };
  t.mock.method(net, 'createConnection', () => { connections += 1; queueMicrotask(() => socket.emit('connect')); return socket; });
  const cache = await import('../src/utils/redisCache.js?authenticated-latency');
  const reads = Promise.all(Array.from({ length: 20 }, () => cache.redisGetJson('safe-key')));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.deepEqual(commands, ['AUTH'], 'no GET may race authentication');
  releaseAuth();
  assert.deepEqual(await reads, Array.from({ length: 20 }, () => ({ count: 1 })));
  assert.equal(connections, 1);
  assert.equal(commands.filter(command => command === 'PING').length, 1);
});
