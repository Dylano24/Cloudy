import { deleteFromDb, getFromDb, setInDb } from '../utils/database.js';

function asPlain(value, fallback) {
  const source = value?.toJSON ? value.toJSON() : value;
  if (source == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(source));
  } catch {
    return fallback;
  }
}

function normalizeIndex(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(id => String(id || '').trim())
    .filter(Boolean))];
}

async function loadIndexedRules(prefix, ids) {
  return Promise.all(ids.map(async originMessageId => ({
    originMessageId,
    config: await getFromDb(prefix + originMessageId, null),
  })));
}

export async function syncExistingEmbedReappearRule({
  guildId,
  channelId,
  messageId,
  embedIndex = 0,
  every = null,
  embed,
  components = [],
}) {
  const guild = String(guildId || '').trim();
  const channel = String(channelId || '').trim();
  const activeMessageId = String(messageId || '').trim();
  const index = Math.max(0, Number(embedIndex) || 0);
  const interval = every == null || every === '' ? null : Number(every);

  if (!guild || !channel || !activeMessageId) {
    return { ok: false, reason: 'missing-target' };
  }
  if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 100)) {
    return { ok: false, reason: 'invalid-every' };
  }

  const prefix = `cloudy:embed-reappear:${guild}:${channel}:`;
  const indexKey = `cloudy:embed-reappear-index:${guild}:${channel}`;
  const indexedIds = normalizeIndex(await getFromDb(indexKey, []));
  const indexedRules = await loadIndexedRules(prefix, indexedIds);

  const existing = indexedRules.find(({ originMessageId, config }) =>
    originMessageId === activeMessageId
    || String(config?.messageId || '') === activeMessageId
    || String(config?.originMessageId || '') === activeMessageId
  ) || null;

  const originMessageId = existing?.originMessageId || activeMessageId;
  const key = prefix + originMessageId;
  const disableKey = `cloudy:embed-reappear-disabled:${guild}:${channel}:${originMessageId}:${index}`;

  if (interval === null) {
    if (!existing) return { ok: true, disabled: true, originMessageId: null };

    const nextIndex = indexedIds.filter(id => id !== originMessageId);
    const [ruleDeleted, indexSaved] = await Promise.all([
      deleteFromDb(key),
      setInDb(indexKey, nextIndex),
      deleteFromDb(disableKey),
    ]);
    return {
      ok: Boolean(ruleDeleted && indexSaved),
      disabled: true,
      originMessageId,
    };
  }

  const embedData = asPlain(embed, null);
  if (!embedData || typeof embedData !== 'object') {
    return { ok: false, reason: 'missing-embed' };
  }

  const componentRows = asPlain(components, []);
  const nextIndex = indexedIds.includes(originMessageId)
    ? indexedIds
    : [...indexedIds, originMessageId];

  const rule = {
    ...(existing?.config || {}),
    guildId: guild,
    channelId: channel,
    messageId: activeMessageId,
    originMessageId,
    embedIndex: index,
    every: interval,
    count: 0,
    embed: embedData,
    components: Array.isArray(componentRows) ? componentRows : [],
    updatedAt: new Date().toISOString(),
  };

  const [ruleSaved, indexSaved] = await Promise.all([
    setInDb(key, rule),
    setInDb(indexKey, nextIndex),
    deleteFromDb(disableKey),
  ]);

  return {
    ok: Boolean(ruleSaved && indexSaved),
    originMessageId,
    rule,
  };
}
