import { Events } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findGamblingChannel(guild) {
  return [...guild.channels.cache.values()]
    .filter(channel => channel?.isTextBased?.())
    .find(channel => compact(channel.name).includes('gambling')) || null;
}

function summarizeTitles(records) {
  const counts = new Map();
  for (const record of records) {
    const title = String(record?.title || record?.name || 'Untitled').replace(/\s+/g, ' ').trim() || 'Untitled';
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 80)
    .map(([title, count]) => ({ title, count }));
}

async function cleanupOrphanCatalogRegistry(guild) {
  const registryKey = `${REGISTRY_PREFIX}${guild.id}`;
  const catalogKey = `${CATALOG_PREFIX}${guild.id}`;
  const registry = await getFromDb(registryKey, []);
  const catalogIds = await getFromDb(catalogKey, []);
  const records = Array.isArray(registry) ? registry : [];
  const ids = Array.isArray(catalogIds) ? catalogIds.map(String).filter(Boolean) : [];

  // Never prune if the canonical catalog id list itself is unavailable. This
  // cleanup is allowed to remove only proven orphan system-catalog references.
  if (!ids.length) {
    logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-skipped guild=${guild.id} reason=no-active-catalog-ids`);
    return;
  }

  const activeIds = new Set(ids);
  const removed = records.filter(record =>
    String(record?.source || '') === 'system-catalog'
    && !activeIds.has(String(record?.messageId || '')));
  const next = records.filter(record =>
    String(record?.source || '') !== 'system-catalog'
    || activeIds.has(String(record?.messageId || '')));

  if (!removed.length) {
    logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-complete guild=${guild.id} removed=0 kept=${next.length}`);
    return;
  }

  const saved = await setInDb(registryKey, next);
  logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-complete guild=${guild.id} removed=${removed.length} kept=${next.length} saved=${Boolean(saved)}`);
}

async function inspectGuild(guild, phase) {
  const registry = await getFromDb(`${REGISTRY_PREFIX}${guild.id}`, []);
  const records = Array.isArray(registry) ? registry : [];
  const catalogIds = await getFromDb(`${CATALOG_PREFIX}${guild.id}`, []);
  const ids = Array.isArray(catalogIds) ? catalogIds.map(String) : [];
  const idSet = new Set(ids);

  const catalogRecords = records.filter(record => String(record?.source || '') === 'system-catalog');
  const gamblingChannel = findGamblingChannel(guild);
  const gamblingChannelId = String(gamblingChannel?.id || '');
  const gamblingRecords = gamblingChannelId
    ? catalogRecords.filter(record => String(record?.channelId || '') === gamblingChannelId)
    : [];
  const activeGamblingRecords = gamblingRecords.filter(record => idSet.has(String(record?.messageId || '')));
  const orphanGamblingRecords = gamblingRecords.filter(record => !idSet.has(String(record?.messageId || '')));

  const catalogMessageIds = new Set(catalogRecords.map(record => String(record?.messageId || '')).filter(Boolean));
  const orphanCatalogMessageIds = [...catalogMessageIds].filter(id => !idSet.has(id));
  const activeCatalogMessageIds = [...catalogMessageIds].filter(id => idSet.has(id));

  const gameNameRecords = catalogRecords.filter(record =>
    /blackjack|baccarat|roulette/i.test(`${record?.title || ''} ${record?.name || ''}`));
  const activeGameNameRecords = gameNameRecords.filter(record => idSet.has(String(record?.messageId || '')));
  const orphanGameNameRecords = gameNameRecords.filter(record => !idSet.has(String(record?.messageId || '')));

  logger.warn([
    `[GAMING_CATALOG_DIAGNOSTIC] phase=${phase}`,
    `guild=${guild.id}`,
    `registry=${records.length}`,
    `systemCatalogRecords=${catalogRecords.length}`,
    `storedCatalogIds=${ids.length}`,
    `registryCatalogMessageIds=${catalogMessageIds.size}`,
    `activeRegistryCatalogMessageIds=${activeCatalogMessageIds.length}`,
    `orphanRegistryCatalogMessageIds=${orphanCatalogMessageIds.length}`,
    `gamblingChannel=${gamblingChannelId || 'not-found'}`,
    `gamblingRecords=${gamblingRecords.length}`,
    `activeGamblingRecords=${activeGamblingRecords.length}`,
    `orphanGamblingRecords=${orphanGamblingRecords.length}`,
    `namedGameRecords=${gameNameRecords.length}`,
    `activeNamedGameRecords=${activeGameNameRecords.length}`,
    `orphanNamedGameRecords=${orphanGameNameRecords.length}`,
  ].join(' '));

  logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] phase=${phase} activeGamblingTitles=${JSON.stringify(summarizeTitles(activeGamblingRecords))}`);
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    logger.warn('[GAMING_CATALOG_DIAGNOSTIC] event-armed');

    const cleanupTimer = setTimeout(() => {
      for (const guild of client.guilds.cache.values()) {
        void cleanupOrphanCatalogRegistry(guild).catch(error => {
          logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-failed guild=${guild.id}: ${error?.message || error}`);
        });
      }
    }, 1000);
    cleanupTimer.unref?.();

    for (const [phase, delay] of [['early', 8000], ['settled', 35000]]) {
      const timer = setTimeout(() => {
        for (const guild of client.guilds.cache.values()) {
          void inspectGuild(guild, phase).catch(error => {
            logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] phase=${phase} failed for ${guild.id}: ${error?.message || error}`);
          });
        }
      }, delay);
      timer.unref?.();
    }
  },
};
