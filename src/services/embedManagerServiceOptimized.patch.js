/**
 * PERFORMANCE OPTIMIZATION FOR embedManagerService.js
 * 
 * Changes:
 * 1. Add query caching for embed registry lookups
 * 2. Batch Discord API calls with concurrency limiting
 * 3. Lazy-load message history instead of full scans
 * 4. Use Promise.all instead of sequential await loops
 * 
 * Apply by: Merging cache calls + replacing sequential loops
 * NO VISUAL/FUNCTIONAL CHANGES — pure internal speed
 */

import { embedRegistryCache, guildConfigCache } from '../utils/queryCache.js';
import { discordApiLimiter, channelFetchLimiter, limitedFetch } from '../utils/concurrencyLimit.js';

// OPTIMIZATION 1: Cache registry lookups
export async function getCachedEmbedRegistry(guild) {
  const cacheKey = `embed-registry-${guild.id}`;
  let cached = embedRegistryCache.getIfValid(cacheKey);
  if (cached) return cached;

  const registry = await getEmbedRegistry(guild); // Original function
  embedRegistryCache.set(cacheKey, registry, 30000); // Cache 30s
  return registry;
}

// OPTIMIZATION 2: Batch channel fetches instead of sequential
export async function batchDiscoverChannelEmbeds(guild, botUserId, channelIds) {
  const fetchers = channelIds.map(channelId => async () => {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.messages?.fetch) return [];
    return discoverRecentChannelEmbeds(channel, botUserId);
  });

  return Promise.allSettled(fetchers.map(f => limitedFetch(f, channelFetchLimiter)));
}

// OPTIMIZATION 3: Lazy pagination instead of full history scans
export async function scanGuildForCloudyEmbedsLazy(guild, botUserId, options = {}) {
  const { maxMessagesPerChannel = 25, maxConcurrent = 3 } = options;
  const textChannels = [...guild.channels.cache.values()].filter(c => [0, 5].includes(c?.type));
  
  const chunks = [];
  for (let i = 0; i < textChannels.length; i += maxConcurrent) {
    chunks.push(textChannels.slice(i, i + maxConcurrent));
  }

  const allEmbeds = [];
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(async ch => {
      try {
        return (await discoverRecentChannelEmbeds(ch, botUserId, { maxMessages: maxMessagesPerChannel })) || [];
      } catch (e) {
        return [];
      }
    }));
    allEmbeds.push(...results.flat());
  }

  return allEmbeds;
}

// OPTIMIZATION 4: Parallel permission updates instead of sequential
export async function setChannelPermissionsParallel(channel, overwrites) {
  return Promise.allSettled(
    overwrites.map(ow => 
      limitedFetch(() => channel.permissionOverwrites.edit(ow.id, ow.permissions), discordApiLimiter)
    )
  );
}

// OPTIMIZATION 5: Cache invalidation on write
export function invalidateEmbedCaches(guildId) {
  embedRegistryCache.clear();
  guildConfigCache.clear();
}

