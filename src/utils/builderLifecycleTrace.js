import { createHash, randomUUID } from 'node:crypto';
import { REST } from '@discordjs/rest';

const bootId = randomUUID();
const known = new Map();
const aliases = new Map();
const endReasons = new Map();
const clients = new WeakSet();
const collectors = new WeakSet();
let snapshot = () => ({});
let installed = false;

// Editor hold IDs are bearer tokens. Correlate hashes, never log the token.
export function traceHoldId(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex').slice(0, 20) : null;
}

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > 5000) map.delete(map.keys().next().value);
}

export function traceBuilder(event, messageId, details = {}) {
  try {
    const id = String(messageId || '');
    console.log('[BUILDER_TRACE] ' + JSON.stringify({
      timestamp: new Date().toISOString(), bootId, pid: process.pid,
      event, messageId: id || null, knownBuilder: known.has(id),
      holdActive: false, holdIds: [], collectorEndReason: null,
      ...snapshot(id),
      ...(endReasons.has(id) ? { collectorEndReason: endReasons.get(id) } : {}),
      ...details,
    }));
  } catch { /* Diagnostics must never change the operation being observed. */ }
}

export function observeBuilder(message) {
  if (!message?.id) return;
  if (!known.has(String(message.id))) {
    remember(known, String(message.id), true);
    traceBuilder('builder_observed', message.id);
  }
  const client = message.client;
  if (!client?.on || clients.has(client)) return;
  clients.add(client);
  client.on('raw', packet => {
    if (packet.t === 'MESSAGE_DELETE' || packet.t === 'MESSAGE_DELETE_BULK') {
      for (const id of packet.d?.ids || [packet.d?.id]) {
        if (known.has(String(id))) traceBuilder('gateway_delete', id, { route: packet.t });
      }
    }
  });
}

export function observeBuilderCollector(message, collector) {
  observeBuilder(message);
  if (!collector?.on || collectors.has(collector)) return;
  collectors.add(collector);
  traceBuilder('collector_created', message.id, {
    collectorTime: collector.options?.time ?? null,
    collectorIdle: collector.options?.idle ?? null,
  });
  collector.prependListener('end', (_items, reason) => {
    remember(endReasons, String(message.id), reason);
    traceBuilder('collector_end', message.id, { collectorEndReason: reason });
  });
}

export function rememberBuilderWebhook(webhook, message, requestedId) {
  // Only a fetch/edit of @original proves the alias, a follow-up send does not.
  if (requestedId === '@original' && webhook?.token && message?.id) {
    remember(aliases, traceHoldId(webhook.token), String(message.id));
  }
}

function callSite() {
  // Keep file/line frames only, never arbitrary error text, request URLs or payloads.
  return (new Error().stack || '').split('\n').slice(2, 12)
    .map(line => line.match(/(?:file:\/\/)?([^\s()]+\.(?:js|mjs|cjs):\d+:\d+)/)?.[1])
    .filter(Boolean).filter(line => !line.includes('builderLifecycleTrace.js'));
}

export function traceDeleteAttempt(route, messageId, details = {}) {
  traceBuilder('delete_attempt', messageId, { route, callSite: callSite(), ...details });
}

export function installBuilderLifecycleTrace(getSnapshot) {
  snapshot = getSnapshot;
  if (installed) return;
  installed = true;
  const original = REST.prototype.request;
  REST.prototype.request = async function traceDiscordRequest(options) {
    const path = String(options?.fullRoute || '').split('?')[0];
    const match = path.match(/^\/(channels|webhooks)\/([^/]+)\/(?:([^/]+)\/)?messages(?:\/([^/]+))?$/);
    const bulk = path.match(/^\/channels\/\d+\/messages\/bulk-delete$/);
    const deleting = options?.method === 'DELETE' || (options?.method === 'POST' && bulk);
    if (!deleting || (!match && !bulk)) return original.call(this, options);
    const rawId = match?.[4];
    const id = rawId === '@original' ? aliases.get(traceHoldId(match?.[3])) : rawId;
    const ids = bulk ? options?.body?.messages || [] : [id || null];
    const requestId = randomUUID();
    const details = {
      requestId, route: bulk ? 'REST.bulk-delete' : `REST.${match[1]}.delete`,
      unresolvedOriginal: rawId === '@original' && !id,
    };
    for (const target of ids) traceDeleteAttempt(details.route, target, details);
    try {
      const result = await original.call(this, options);
      for (const target of ids) traceBuilder('delete_succeeded', target, details);
      return result;
    } catch (error) {
      for (const target of ids) traceBuilder('delete_failed', target, {
        ...details, errorCode: error?.code ?? null, httpStatus: error?.status ?? null,
      });
      throw error;
    }
  };
  traceBuilder('trace_installed', null);
}
