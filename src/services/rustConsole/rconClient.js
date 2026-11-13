// WebSocket RCON client for Rust Console Edition community servers.
//
// Protocol (Rust Console Edition community server specification): connect to
// ws://<address>:<port>/<password>; send {"identifier": n, "name": "...",
// "message": "<command>"}; the server broadcasts {"identifier": n, "message":
// "..."} to every connected client, so replies are matched on the identifier.
// The server is chatty and never resends, so every command has a timeout.
// Field names are accepted in both cases (Rust PC WebRCON uses Identifier/Message).

const DEFAULT_TIMEOUT_MS = 10_000;

export class RconError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RconError';
    this.code = code;
  }
}

export function rconUrl({ host, port, password, tls = false }) {
  if (!host || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new RconError('Invalid RCON host.', 'invalid_config');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RconError('Invalid RCON port.', 'invalid_config');
  if (!password) throw new RconError('RCON password is missing.', 'invalid_config');
  return `${tls ? 'wss' : 'ws'}://${host}:${port}/${encodeURIComponent(password)}`;
}

export function parseRconFrame(data) {
  let frame;
  try { frame = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return null; }
  if (!frame || typeof frame !== 'object') return null;
  const identifier = Number(frame.identifier ?? frame.Identifier);
  const message = frame.message ?? frame.Message;
  return {
    identifier: Number.isFinite(identifier) ? identifier : null,
    message: typeof message === 'string' ? message : message == null ? '' : JSON.stringify(message),
    type: String(frame.type ?? frame.Type ?? ''),
  };
}

export function createRconClient({ host, port, password, tls = false, name = 'Cloudy', timeoutMs = DEFAULT_TIMEOUT_MS, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') throw new RconError('WebSocket is not available in this Node.js version.', 'unsupported');
  const url = rconUrl({ host, port, password, tls });
  const pending = new Map();
  const listeners = new Set();
  let socket = null;
  let opening = null;
  let nextId = 1000 + Math.floor(Math.random() * 100_000);

  function failAll(error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }

  function connect() {
    if (socket && socket.readyState === 1) return Promise.resolve();
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url);
      const timer = setTimeout(() => { reject(new RconError('RCON connection timed out.', 'timeout')); try { ws.close(); } catch { /* closed */ } }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); socket = ws; resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new RconError('RCON connection failed.', 'connect_failed')); };
      ws.onclose = () => {
        clearTimeout(timer);
        if (socket === ws) socket = null;
        failAll(new RconError('RCON connection closed.', 'closed'));
        reject(new RconError('RCON connection closed.', 'closed'));
      };
      ws.onmessage = event => {
        const frame = parseRconFrame(event?.data);
        if (!frame) return;
        const entry = frame.identifier !== null ? pending.get(frame.identifier) : null;
        if (entry) {
          pending.delete(frame.identifier);
          clearTimeout(entry.timer);
          entry.resolve(frame.message);
          return;
        }
        for (const listener of listeners) {
          try { listener(frame); } catch { /* a listener never breaks the connection */ }
        }
      };
    }).finally(() => { opening = null; });
    return opening;
  }

  async function send(command) {
    if (typeof command !== 'string' || !command || command.length > 500 || /[\r\n\0]/.test(command)) throw new RconError('Invalid command.', 'invalid_command');
    await connect();
    const identifier = nextId++;
    if (nextId > 2_000_000_000) nextId = 1000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(identifier); reject(new RconError('RCON command timed out.', 'timeout')); }, timeoutMs);
      pending.set(identifier, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ identifier, name, message: command }));
      } catch {
        clearTimeout(timer);
        pending.delete(identifier);
        reject(new RconError('RCON send failed.', 'send_failed'));
      }
    });
  }

  function onMessage(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function close() {
    failAll(new RconError('RCON connection closed.', 'closed'));
    try { socket?.close(); } catch { /* already closed */ }
    socket = null;
  }

  return { connect, send, onMessage, close };
}

/**
 * Stand-in for a server in mock mode and in tests: records every command and
 * answers like a server would. Nothing reaches a real game server.
 */
export function createMockRcon({ online = null, reply = () => 'OK', sent = [] } = {}) {
  const listeners = new Set();
  return {
    sent,
    async connect() {},
    async send(command) {
      sent.push(command);
      if (/^(playerlist|status|users)$/.test(command)) return (online ? [...online] : []).join('\n');
      return reply(command);
    },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(frame) { for (const listener of listeners) listener(frame); },
    close() {},
  };
}
