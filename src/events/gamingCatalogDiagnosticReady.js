import { Events } from 'discord.js';
import { getFromDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { pruneGoneSystemCatalogRecords } from '../services/embedRegistryService.js';
import { warmSavedEmbedTemplateScopes } from '../services/embedTemplateService.js';
import { savedOverlayMatch } from '../services/builderCatalogAdmission.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';
const ENABLE_CATALOG_DIAGNOSTICS = process.env.CLOUDY_CATALOG_DIAGNOSTICS === '1';

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

// At most this many Discord look-ups per start; the rest waits for the next start.
const MAX_ORPHAN_CHECKS = 50;

// The owner's saved work is never removed: an explicit or old Save, or a saved
// Builder change for the family (also while those changes cannot be read).
function isProtectedCatalogRow(row) {
  if (row?.explicitSave === true || row?.manualSaved === true || row?.authoritative === true) return true;
  return savedOverlayMatch(row) !== 'none';
}

/**
 * A stored catalog row whose message is no longer in the catalog list is
 * removed only when Discord proves the message is gone (Unknown Message);
 * a timeout or missing permission proves nothing. Protected rows stay as
 * detached templates. Exported for tests.
 */
export async function cleanupOrphanCatalogRegistry(guild) {
  const registryKey = `${REGISTRY_PREFIX}${guild.id}`;
  const catalogKey = `${CATALOG_PREFIX}${guild.id}`;
  const registry = await getFromDb(registryKey, null, { strict: true }).catch(() => null);
  const catalogIds = await getFromDb(catalogKey, null, { strict: true }).catch(() => null);
  if (!Array.isArray(registry) || !Array.isArray(catalogIds)) {
    logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-skipped guild=${guild.id} reason=storage-unreadable`);
    return { removed: 0, detached: 0 };
  }
  const ids = catalogIds.map(String).filter(Boolean);
  // Never prune if the canonical catalog id list itself is unavailable.
  if (!ids.length) {
    logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-skipped guild=${guild.id} reason=no-active-catalog-ids`);
    return { removed: 0, detached: 0 };
  }

  const activeIds = new Set(ids);
  const orphans = registry.filter(record =>
    String(record?.source || '') === 'system-catalog' && !record?.detached
    && !activeIds.has(String(record?.messageId || '')));
  if (!orphans.length) return { removed: 0, detached: 0 };

  const gone = new Set();
  for (const row of orphans.slice(0, MAX_ORPHAN_CHECKS)) {
    const channel = guild.channels?.cache?.get?.(String(row.backingChannelId || row.channelId || ''));
    if (!channel?.messages?.fetch) continue;
    try {
      await channel.messages.fetch(String(row.messageId));
    } catch (error) {
      if (Number(error?.code) === 10008) gone.add(String(row.messageId));
    }
  }
  if (!gone.size) {
    logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-complete guild=${guild.id} removed=0 orphans=${orphans.length} proven-gone=0`);
    return { removed: 0, detached: 0 };
  }

  await warmSavedEmbedTemplateScopes(guild.id, [...new Set(orphans.map(row => String(row.channelId || '')))]);
  const result = await pruneGoneSystemCatalogRecords(guild.id, gone, isProtectedCatalogRow);
  logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] cleanup-complete guild=${guild.id} removed=${result.removed} kept-as-template=${result.detached} orphans=${orphans.length}`);
  return result;
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

    // Orphan cleanup remains automatic because it is corrective. The two
    // full-registry inspection passes are diagnostics only and are disabled in
    // normal production to avoid duplicate DB reads, array scans and large logs.
    if (!ENABLE_CATALOG_DIAGNOSTICS) return;

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
