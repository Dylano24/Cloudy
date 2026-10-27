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
  const values = await reads;
  assert.deepEqual(values, Array.from({ length: 20 }, () => ({ count: 1 })));
  assert.equal(connections, 1);
  assert.equal(commands.filter(command => command === 'PING').length, 1);
  assert.equal(commands.filter(command => command === 'GET').length, 1,
    'simultaneous reads of one key must share one Redis GET');
  values[0].count = 999;
  assert.equal(values[1].count, 1, 'callers must not share a mutable result');
  await cache.redisGetJson('safe-key');
  assert.equal(commands.filter(command => command === 'GET').length, 2,
    'completed reads are not a TTL cache and the next read must be fresh');
});

for (const operation of ['set', 'delete']) {
  test(`a ${operation} separates pending reads and subsequent reads see the new state`, async t => {
    const previousUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://cache.invalid:6379';
    t.after(() => { if (previousUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousUrl; });
    const socket = new EventEmitter();
    socket.destroy = () => { socket.destroyed = true; };
    let value = '{"count":1}', gets = 0;
    const replies = [];
    socket.write = buffer => {
      const parts = buffer.toString().split('\r\n');
      const command = parts[2];
      if (command === 'PING') queueMicrotask(() => socket.emit('data', Buffer.from('+PONG\r\n')));
      if (command === 'GET') {
        gets++;
        replies.push(value === null ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`);
      }
      if (command === 'SET') { value = parts[6]; replies.push('+OK\r\n'); }
      if (command === 'DEL') { value = null; replies.push(':1\r\n'); }
    };
    t.mock.method(net, 'createConnection', () => { queueMicrotask(() => socket.emit('connect')); return socket; });
    const cache = await import(`../src/utils/redisCache.js?write-boundary-${operation}`);
    await cache.redisPing();
    const oldRead = cache.redisGetJson('key');
    await Promise.resolve();
    const write = operation === 'set' ? cache.redisSetJson('key', { count: 2 }) : cache.redisDelete('key');
    const newRead = cache.redisGetJson('key');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(gets, 2, 'post-write read cannot reuse a pre-write request');
    socket.emit('data', Buffer.from(replies.splice(0).join('')));
    assert.deepEqual(await oldRead, { count: 1 });
    assert.equal(await write, true);
    assert.deepEqual(await newRead, operation === 'set' ? { count: 2 } : null);
    const fresh = cache.redisGetJson('key');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    socket.emit('data', Buffer.from(replies.splice(0).join('')));
    assert.deepEqual(await fresh, operation === 'set' ? { count: 2 } : null);
    assert.equal(gets, 3);
  });
}
