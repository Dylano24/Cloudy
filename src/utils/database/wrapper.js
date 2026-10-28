import { pgDb } from '../postgresDatabase.js';
import { MemoryStorage } from '../memoryStorage.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';
import { redisDelete, redisGetJson, redisSetJson } from '../redisCache.js';

function redisCacheTtlForKey(key) {
    if (typeof key !== 'string') return 0;
    if (key.startsWith('cloudy:builder-button-action:')) return 6 * 60 * 60_000;
    if (key.startsWith('cloudy:embed-reappear-index:')) return 60_000;
    if (key.startsWith('cloudy:embed-reappear:')) return 30_000;
    return 0;
}

// Redis-cached keys are read on hot paths: the Reappear index is read for
// every user message in a channel. Most channels have no rule, so the key is
// simply absent and every message cost a PostgreSQL query. Remember "absent"
// for the same TTL. Every write/delete through setInDb/deleteFromDb clears it
// at once, and a read that raced with a write never records "absent".
const knownMissing = new Map();
const keyWriteCounts = new Map();
const MAX_KNOWN_MISSING = 10_000;

function isKnownMissing(key) {
    const expiresAt = knownMissing.get(key);
    if (!expiresAt) return false;
    if (Date.now() < expiresAt) return true;
    knownMissing.delete(key);
    return false;
}

function rememberMissing(key, ttl) {
    knownMissing.delete(key);
    knownMissing.set(key, Date.now() + ttl);
    while (knownMissing.size > MAX_KNOWN_MISSING) knownMissing.delete(knownMissing.keys().next().value);
}

function noteKeyWrite(key) {
    knownMissing.delete(key);
    keyWriteCounts.set(key, (keyWriteCounts.get(key) || 0) + 1);
    if (keyWriteCounts.size > MAX_KNOWN_MISSING) keyWriteCounts.delete(keyWriteCounts.keys().next().value);
}

// Test helper.
export function clearKnownMissingKeys() {
    knownMissing.clear();
    keyWriteCounts.clear();
}

function requiresPersistentStorage(key) {
    if (typeof key !== 'string') return false;
    return /^guild:[^:]+:config$/.test(key) || /^guild:[^:]+:ticket:/.test(key);
}

function persistentStorageError(key, operation) {
    const error = new Error(`Persistent PostgreSQL storage is required to ${operation} ${key}`);
    error.code = 'PERSISTENT_STORAGE_REQUIRED';
    error.userMessage = 'The persistent database is currently unavailable. Please try again once PostgreSQL is connected.';
    return error;
}

function assertStorageOperationSucceeded(result, key, operation) {
    if (result !== false) return result;

    const error = new Error(`Database ${operation} failed for key ${key}`);
    error.code = 'DATABASE_OPERATION_FAILED';
    throw error;
}

export class DatabaseWrapper {
    constructor() {
        this.initialized = false;
        this.initializationPromise = null;
        this.db = null;
        this.useFallback = false;
        this.connectionType = 'none';
        this.degradedModeWarningShown = false;
        this.degradedReason = null;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        if (!this.initializationPromise) {
            this.initializationPromise = this.initializeStorage().finally(() => {
                this.initializationPromise = null;
            });
        }
        return this.initializationPromise;
    }

    async initializeStorage() {
        try {
            logger.info('Attempting to connect to PostgreSQL...');
            const pgConnected = await pgDb.connect();
            if (pgConnected) {
                this.db = pgDb;
                this.connectionType = 'postgresql';
                this.degradedReason = null;
                logger.info('✅ PostgreSQL Database initialized - using persistent database');
                this.initialized = true;
                return;
            }

            const pgFailure = pgDb.getLastFailure?.();
            if (pgFailure?.reason === 'SCHEMA_VERSION_MISMATCH') {
                const schemaError = new Error(
                    `Schema version mismatch detected (${pgFailure.message}). Run migrations before startup.`,
                );
                schemaError.code = 'SCHEMA_VERSION_MISMATCH';
                throw schemaError;
            }
        } catch (error) {
            logger.warn('PostgreSQL connection failed:', error.message);

            if (error.code === 'SCHEMA_VERSION_MISMATCH') {
                throw error;
            }
        }

        if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
            this.degradedReason = 'POSTGRES_UNAVAILABLE';
            throw persistentStorageError('production database', 'initialize');
        }

        this.db = new MemoryStorage();
        this.useFallback = true;
        this.connectionType = 'memory';
        this.degradedReason = 'POSTGRES_UNAVAILABLE';
        logger.warn('⚠️ DATABASE DEGRADED MODE ENABLED - Using in-memory storage (data will be lost on restart)');
        logger.warn('⚠️ Please check PostgreSQL connection and restart the bot when fixed');
        this.initialized = true;
        this.degradedModeWarningShown = true;
    }

    async set(key, value, ttl = null) {
        if (this.useFallback && requiresPersistentStorage(key)) {
            throw persistentStorageError(key, 'write');
        }

        if (this.useFallback) {
            logger.debug(`[DEGRADED] Writing to memory: ${key}`);
        }

        if (typeof key === 'string' && /^guild:[^:]+:config$/.test(key)) {
            const guildId = key.split(':')[1];
            validateGuildConfigOrThrow(value, {
                guildId,
                errorCode: 'VALIDATION_FAILED',
            });
        }

        const result = await this.db.set(key, value, ttl);
        return assertStorageOperationSucceeded(result, key, 'write');
    }

    async get(key, defaultValue = null, options = {}) {
        return this.db.get(key, defaultValue, options);
    }

    async delete(key) {
        if (this.useFallback && requiresPersistentStorage(key)) {
            throw persistentStorageError(key, 'delete');
        }

        if (this.useFallback) {
            logger.debug(`[DEGRADED] Deleting from memory: ${key}`);
        }

        const result = await this.db.delete(key);
        return assertStorageOperationSucceeded(result, key, 'delete');
    }

    async list(prefix) {
        return this.db.list(prefix);
    }

    async mutateEconomyAccount(guildId, userId, initialData, mutate) {
        if (!this.db || typeof this.db.mutateEconomyAccount !== 'function') {
            throw new Error('Atomic economy mutation requires PostgreSQL');
        }
        return this.db.mutateEconomyAccount(guildId, userId, initialData, mutate);
    }

    async mutateEconomyAccounts(guildId, userIds, initialData, mutate) {
        if (!this.db || typeof this.db.mutateEconomyAccounts !== 'function') {
            throw new Error('Atomic multi-account economy mutation requires PostgreSQL');
        }
        return this.db.mutateEconomyAccounts(guildId, userIds, initialData, mutate);
    }

    // null when the storage backend has no bulk read; callers then use get().
    async getGuildEconomyAccounts(guildId) {
        if (!this.db || typeof this.db.getGuildEconomyAccounts !== 'function') return null;
        return this.db.getGuildEconomyAccounts(guildId);
    }

    async transferEconomyFunds(guildId, senderId, receiverId, amount, initialData) {
        if (!this.db || typeof this.db.transferEconomyFunds !== 'function') {
            throw new Error('Atomic economy transfers require PostgreSQL');
        }
        return this.db.transferEconomyFunds(guildId, senderId, receiverId, amount, initialData);
    }

    async exists(key) {
        if (this.db.exists) {
            return this.db.exists(key);
        }
        const value = await this.db.get(key);
        return value !== null;
    }

    async increment(key, amount = 1) {
        if (this.useFallback && requiresPersistentStorage(key)) {
            throw persistentStorageError(key, 'increment');
        }

        if (this.useFallback) {
            logger.debug(`[DEGRADED] Incrementing in memory: ${key}`);
        }
        if (this.db.increment) {
            return this.db.increment(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current + amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    async decrement(key, amount = 1) {
        if (this.useFallback && requiresPersistentStorage(key)) {
            throw persistentStorageError(key, 'decrement');
        }

        if (this.useFallback) {
            logger.debug(`[DEGRADED] Decrementing in memory: ${key}`);
        }
        if (this.db.decrement) {
            return this.db.decrement(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current - amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    isDegraded() {
        return this.useFallback;
    }

    isAvailable() {
        return this.db && !this.useFallback;
    }

    getStatus() {
        return {
            initialized: this.initialized,
            connectionType: this.connectionType,
            isDegraded: this.useFallback,
            isAvailable: this.isAvailable(),
            degradedReason: this.degradedReason,
        };
    }

    getConnectionType() {
        return this.connectionType;
    }
}

export const db = new DatabaseWrapper();

export async function initializeDatabase() {
    try {
        logger.info('Initializing Database (PostgreSQL > Memory fallback)...');
        await db.initialize();
        logger.info('✅ Database initialized');
        return { db };
    } catch (error) {
        logger.error('❌ Database Initialization Error:', error);

        throw error;
    }
}

export async function getFromDb(key, defaultValue = null, options = {}) {
    try {
        const cacheTtl = redisCacheTtlForKey(key);
        if (cacheTtl > 0 && !options.strict && isKnownMissing(key)) return defaultValue;
        const writesBefore = cacheTtl > 0 ? keyWriteCounts.get(key) || 0 : 0;
        if (cacheTtl > 0) {
            const cached = await redisGetJson(key);
            if (cached !== null) return cached;
        }

        const value = await db.get(key, null, options);
        if (value !== null && cacheTtl > 0) {
            void redisSetJson(key, value, cacheTtl);
        } else if (value === null && cacheTtl > 0 && (keyWriteCounts.get(key) || 0) === writesBefore) {
            rememberMissing(key, cacheTtl);
        }
        return value === null ? defaultValue : value;
    } catch (error) {
        logger.error(`Error getting value for key ${key}:`, error);
        if (options.strict) throw error;
        return defaultValue;
    }
}

export async function setInDb(key, value, ttl = null) {
    try {
        const tracked = redisCacheTtlForKey(key) > 0;
        if (tracked) noteKeyWrite(key);
        const result = await Promise.resolve(db.set(key, value, ttl)).finally(() => {
            // A read that finished while this write was in flight may have
            // recorded "absent": clear it once the write has landed.
            if (tracked) noteKeyWrite(key);
        });
        const ok = result !== false;
        const cacheTtl = redisCacheTtlForKey(key);
        if (ok && cacheTtl > 0) {
            void redisSetJson(key, value, cacheTtl);
        }
        return ok;
    } catch (error) {
        logger.error(`Error setting value for key ${key}:`, error);
        return false;
    }
}

export async function deleteFromDb(key) {
    try {
        const tracked = redisCacheTtlForKey(key) > 0;
        if (tracked) noteKeyWrite(key);
        const result = await Promise.resolve(db.delete(key)).finally(() => {
            if (tracked) noteKeyWrite(key);
        });
        const ok = result !== false;
        if (redisCacheTtlForKey(key) > 0) {
            void redisDelete(key);
        }
        return ok;
    } catch (error) {
        logger.error(`Error deleting key ${key}:`, error);
        return false;
    }
}
