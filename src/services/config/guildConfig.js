// guildConfig.js — the only module that should read/write guild configuration.

import { GUILD_CONFIG_DEFAULTS } from '../../config/guild/guildConfigDefaults.js';
import { readGuildConfig, writeGuildConfig } from '../../utils/database/guildConfigStorage.js';
import { normalizeGuildConfig, validateGuildConfigOrThrow } from '../../utils/schemas.js';
import { createError, ErrorTypes, wrapServiceBoundary } from '../../utils/errorHandler.js';

export { GUILD_CONFIG_DEFAULTS };

// Keep active guild settings hot for dashboard/admin interactions. The service
// runs one production replica, and every successful write refreshes this cache,
// so repeatedly re-reading PostgreSQL during one dashboard session only adds
// avoidable latency.
const CONFIG_CACHE_TTL_MS = 5 * 60_000;
const guildConfigCache = new Map();
const guildWriteQueues = new Map();

function cloneConfig(value) {
    if (!value || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function normalizeCloudyGuildConfig(config) {
    const normalized = normalizeGuildConfig(config, GUILD_CONFIG_DEFAULTS);

    normalized.dmOnClose = false;

    const rawTicketLimit = normalized.maxTicketsPerUser;
    const hasValidTicketLimitType =
        typeof rawTicketLimit === 'number'
        || (typeof rawTicketLimit === 'string' && rawTicketLimit.trim().length > 0);
    const configuredTicketLimit = hasValidTicketLimitType ? Number(rawTicketLimit) : Number.NaN;
    normalized.maxTicketsPerUser = Number.isFinite(configuredTicketLimit)
        ? Math.min(10, Math.max(1, Math.trunc(configuredTicketLimit)))
        : 3;

    return normalized;
}

function cacheGuildConfig(guildId, config) {
    const normalized = normalizeCloudyGuildConfig(config);
    guildConfigCache.set(String(guildId), {
        value: cloneConfig(normalized),
        expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
    });
    return normalized;
}

function getCachedGuildConfig(guildId) {
    const key = String(guildId);
    const cached = guildConfigCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        guildConfigCache.delete(key);
        return null;
    }
    return cloneConfig(cached.value);
}

export function peekGuildConfigCache(guildId) {
    return getCachedGuildConfig(guildId);
}

function enqueueGuildWrite(guildId, operation) {
    const key = String(guildId);
    const previous = guildWriteQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);

    guildWriteQueues.set(key, current);
    current.finally(() => {
        if (guildWriteQueues.get(key) === current) {
            guildWriteQueues.delete(key);
        }
    }).catch(() => {});

    return current;
}

async function readLatestGuildConfig(client, guildId, context = {}) {
    const raw = await readGuildConfig(client, guildId, context);
    return normalizeCloudyGuildConfig(raw);
}

export const getGuildConfig = wrapServiceBoundary(async function getGuildConfig(client, guildId, context = {}) {
    const cached = getCachedGuildConfig(guildId);
    if (cached) return cached;

    const config = await readLatestGuildConfig(client, guildId, context);
    cacheGuildConfig(guildId, config);
    return cloneConfig(config);
}, {
    service: 'guildConfigService',
    operation: 'getGuildConfig',
    message: 'Failed to fetch guild configuration',
    userMessage: 'Failed to load server configuration. Please try again.',
});

export const setGuildConfig = wrapServiceBoundary(async function setGuildConfig(client, guildId, config, context = {}) {
    return await enqueueGuildWrite(guildId, async () => {
        const normalized = normalizeCloudyGuildConfig(config);
        const saved = await writeGuildConfig(client, guildId, normalized, context);
        cacheGuildConfig(guildId, saved);
        return cloneConfig(saved);
    });
}, {
    service: 'guildConfigService',
    operation: 'setGuildConfig',
    message: 'Failed to save guild configuration',
    userMessage: 'Failed to save server configuration. Please try again.',
});

export const updateGuildConfig = wrapServiceBoundary(async function updateGuildConfig(client, guildId, updates, context = {}) {
    return await enqueueGuildWrite(guildId, async () => {
        // Writes are serialized per guild. Reuse the hot config when available
        // instead of doing a PostgreSQL read before every PostgreSQL write.
        const currentConfig = getCachedGuildConfig(guildId)
            || await readLatestGuildConfig(client, guildId, context);
        const merged = { ...currentConfig, ...updates };
        const normalized = normalizeCloudyGuildConfig(merged);
        const saved = await writeGuildConfig(client, guildId, normalized, context);
        cacheGuildConfig(guildId, saved);
        return cloneConfig(saved);
    });
}, {
    service: 'guildConfigService',
    operation: 'updateGuildConfig',
    message: 'Failed to update guild configuration',
    userMessage: 'Failed to update server configuration. Please try again.',
});

export const getConfigValue = wrapServiceBoundary(async function getConfigValue(client, guildId, key, defaultValue = null, context = {}) {
    const config = await getGuildConfig(client, guildId, context);
    return config[key] !== undefined ? config[key] : defaultValue;
}, {
    service: 'guildConfigService',
    operation: 'getConfigValue',
    message: 'Failed to read guild configuration value',
    userMessage: 'Failed to read a server setting. Please try again.',
});

export const setConfigValue = wrapServiceBoundary(async function setConfigValue(client, guildId, key, value, context = {}) {
    return await updateGuildConfig(client, guildId, { [key]: value }, context);
}, {
    service: 'guildConfigService',
    operation: 'setConfigValue',
    message: 'Failed to update guild configuration value',
    userMessage: 'Failed to update a server setting. Please try again.',
});

export const patchGuildConfig = wrapServiceBoundary(async function patchGuildConfig(client, guildId, patch, context = {}) {
    if (!patch || typeof patch !== 'object') {
        throw createError(
            'Invalid guild config patch',
            ErrorTypes.VALIDATION,
            'Invalid configuration update.',
            { guildId, ...context },
        );
    }

    return await enqueueGuildWrite(guildId, async () => {
        const currentConfig = getCachedGuildConfig(guildId)
            || await readLatestGuildConfig(client, guildId, context);
        const merged = deepMergeGuildConfig(currentConfig, patch);
        const normalized = normalizeCloudyGuildConfig(merged);
        validateGuildConfigOrThrow(normalized, { guildId, ...context });
        const saved = await writeGuildConfig(client, guildId, normalized, context);
        cacheGuildConfig(guildId, saved);
        return cloneConfig(saved);
    });
}, {
    service: 'guildConfigService',
    operation: 'patchGuildConfig',
    message: 'Failed to patch guild configuration',
    userMessage: 'Failed to update server configuration. Please try again.',
});

function deepMergeGuildConfig(base, patch) {
    const result = { ...base };

    for (const [key, value] of Object.entries(patch)) {
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            base[key] &&
            typeof base[key] === 'object' &&
            !Array.isArray(base[key])
        ) {
            result[key] = { ...base[key], ...value };
        } else {
            result[key] = value;
        }
    }

    return result;
}
