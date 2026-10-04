/**
 * queryCache.js — High-speed LRU cache for frequent DB queries
 * Reduces redundant fetches for embeds, settings, configs
 * No UI changes, zero visual impact, pure performance
 */

class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.cache.set(key, this.cache.get(key));
      this.hits++;
      return this.cache.get(key);
    }
    this.misses++;
    return null;
  }

  set(key, value, ttlMs = 60000) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, { value, expires: Date.now() + ttlMs });
    
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  getIfValid(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  stats() {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 
        ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(2) + '%'
        : '0%'
    };
  }
}

// Global caches — one per data type
export const guildConfigCache = new LRUCache(1000);
export const embedRegistryCache = new LRUCache(500);
export const ticketDataCache = new LRUCache(300);
export const applicationSettingsCache = new LRUCache(500);
export const levelingConfigCache = new LRUCache(500);

export function invalidateGuildCache(guildId) {
  guildConfigCache.clear(); // Clear all configs on write
  embedRegistryCache.clear();
  ticketDataCache.clear();
  applicationSettingsCache.clear();
  levelingConfigCache.clear();
}

export function getCacheStats() {
  return {
    guildConfig: guildConfigCache.stats(),
    embedRegistry: embedRegistryCache.stats(),
    ticketData: ticketDataCache.stats(),
    applicationSettings: applicationSettingsCache.stats(),
    levelingConfig: levelingConfigCache.stats(),
  };
}

