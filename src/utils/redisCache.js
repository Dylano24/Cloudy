import net from 'node:net';
import tls from 'node:tls';
import { logger } from './logger.js';

const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const COMMAND_TIMEOUT_MS = 800;
const CACHE_PREFIX = 'cloudy:cache:';

let socket = null;
let connected = false;
let connectingPromise = null;
let inputBuffer = Buffer.alloc(0);
const pending = [];
let lastWarningAt = 0;

function warnOnce(message) {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  logger.warn(`[REDIS_CACHE] ${message}`);
}

function encodeCommand(parts) {
  const chunks = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.from(String(part));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

function findCrLf(buffer, start) {
  for (let i = start; i + 1 < buffer.length; i += 1) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  return -1;
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = findCrLf(buffer, offset + 1);
  if (lineEnd < 0) return null;

  const line = buffer.subarray(offset + 1, lineEnd).toString('utf8');
  if (type === '+' || type === '-' || type === ':') {
    const value = type === ':' ? Number(line) : line;
    return { value, error: type === '-', next: lineEnd + 2 };
  }

  if (type === '$') {
    const length = Number(line);
    if (length === -1) return { value: null, next: lineEnd + 2 };
    if (!Number.isInteger(length) || length < 0) throw new Error('Invalid Redis bulk length');
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(start, end).toString('utf8'), next: end + 2 };
  }

  if (type === '*') {
    const count = Number(line);
    if (count === -1) return { value: null, next: lineEnd + 2 };
    if (!Number.isInteger(count) || count < 0) throw new Error('Invalid Redis array length');
    const values = [];
    let next = lineEnd + 2;
    for (let i = 0; i < count; i += 1) {
      const parsed = parseResp(buffer, next);
      if (!parsed) return null;
      if (parsed.error) return parsed;
      values.push(parsed.value);
      next = parsed.next;
    }
    return { value: values, next };
  }

  throw new Error('Unsupported Redis response type');
}

function rejectPending(error) {
  while (pending.length) {
    const entry = pending.shift();
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

function resetConnection(error = new Error('Redis connection reset')) {
  connected = false;
  inputBuffer = Buffer.alloc(0);
  const current = socket;
  socket = null;
  if (current && !current.destroyed) current.destroy();
  rejectPending(error);
}

function handleData(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  try {
    while (pending.length) {
      const parsed = parseResp(inputBuffer, 0);
      if (!parsed) break;
      inputBuffer = inputBuffer.subarray(parsed.next);
      const entry = pending.shift();
      clearTimeout(entry.timer);
      if (parsed.error) entry.reject(new Error(parsed.value));
      else entry.resolve(parsed.value);
    }
  } catch (error) {
    resetConnection(error);
  }
}

function issue(parts) {
  if (!socket || !connected) return Promise.reject(new Error('Redis is not connected'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resetConnection(new Error('Redis command timeout'));
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    pending.push({ resolve, reject, timer });
    socket.write(encodeCommand(parts), error => {
      if (error) resetConnection(error);
    });
  });
}

async function ensureConnected() {
  if (!REDIS_URL) return false;
  if (connected && socket && !socket.destroyed) return true;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    let parsed;
    try {
      parsed = new URL(REDIS_URL);
    } catch {
      warnOnce('REDIS_URL is invalid; using PostgreSQL/memory fallback.');
      return false;
    }

    const host = parsed.hostname;
    const port = Number(parsed.port || 6379);
    const password = decodeURIComponent(parsed.password || '');
    const username = decodeURIComponent(parsed.username || '');

    await new Promise((resolve, reject) => {
      const options = { host, port };
      const nextSocket = parsed.protocol === 'rediss:'
        ? tls.connect(options, resolve)
        : net.createConnection(options, resolve);

      const onInitialError = error => {
        nextSocket.off('connect', resolve);
        nextSocket.off('secureConnect', resolve);
        reject(error);
      };
      nextSocket.once('error', onInitialError);

      const event = parsed.protocol === 'rediss:' ? 'secureConnect' : 'connect';
      nextSocket.once(event, () => {
        nextSocket.off('error', onInitialError);
        socket = nextSocket;
        connected = true;
        inputBuffer = Buffer.alloc(0);
        nextSocket.on('data', handleData);
        nextSocket.on('error', error => {
          warnOnce(`connection error: ${error.message}`);
          resetConnection(error);
        });
        nextSocket.on('close', () => {
          if (socket === nextSocket) resetConnection(new Error('Redis connection closed'));
        });
        resolve();
      });
    });

    if (password) {
      const auth = username
        ? ['AUTH', username, password]
        : ['AUTH', password];
      await issue(auth);
    }
    await issue(['PING']);
    return true;
  })()
    .catch(error => {
      warnOnce(`unavailable: ${error.message}; using fallback.`);
      resetConnection(error);
      return false;
    })
    .finally(() => {
      connectingPromise = null;
    });

  return connectingPromise;
}

async function command(parts) {
  const ready = await ensureConnected();
  if (!ready) return null;
  try {
    return await issue(parts);
  } catch (error) {
    warnOnce(`command failed: ${error.message}; using fallback.`);
    return null;
  }
}

function key(name) {
  return CACHE_PREFIX + String(name || '');
}

export function isRedisConfigured() {
  return Boolean(REDIS_URL);
}

export async function redisGetJson(name) {
  const raw = await command(['GET', key(name)]);
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function redisSetJson(name, value, ttlMs = 60_000) {
  const ttl = Math.max(1_000, Number(ttlMs) || 60_000);
  const result = await command(['SET', key(name), JSON.stringify(value), 'PX', ttl]);
  return result === 'OK';
}

export async function redisDelete(name) {
  const result = await command(['DEL', key(name)]);
  return Number(result) >= 0;
}

export async function redisAcquireLock(name, ttlMs = 30_000) {
  const ttl = Math.max(1_000, Number(ttlMs) || 30_000);
  const result = await command(['SET', key('lock:' + name), '1', 'NX', 'PX', ttl]);
  return result === 'OK';
}

export async function redisPing() {
  return (await command(['PING'])) === 'PONG';
}
