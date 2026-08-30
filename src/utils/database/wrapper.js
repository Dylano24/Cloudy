import { pgDb } from '../postgresDatabase.js';
import { MemoryStorage } from '../memoryStorage.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

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

class DatabaseWrapper {
    constructor() {
        this.initialized = false;
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

    async get(key, defaultValue = null) {
        return this.db.get(key, defaultValue);
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

        if (error.code === 'SCHEMA_VERSION_MISMATCH') {
            throw error;
        }

        return { db };
    }
}

export async function getFromDb(key, defaultValue = null) {
    try {
        const value = await db.get(key);
        return value === null ? defaultValue : value;
    } catch (error) {
        logger.error(`Error getting value for key ${key}:`, error);
        return defaultValue;
    }
}

export async function setInDb(key, value, ttl = null) {
    try {
        const result = await db.set(key, value, ttl);
        return result !== false;
    } catch (error) {
        logger.error(`Error setting value for key ${key}:`, error);
        return false;
    }
}

export async function deleteFromDb(key) {
    try {
        const result = await db.delete(key);
        return result !== false;
    } catch (error) {
        logger.error(`Error deleting key ${key}:`, error);
        return false;
    }
}
