import { assertAllowlistedIdentifier } from '../../utils/sqlIdentifiers.js';
import { EXPECTED_SCHEMA_LABEL, EXPECTED_SCHEMA_VERSION } from './schemaVersion.js';

const configuredTables = {
    guilds: 'guilds',
    users: 'users',
    guild_users: 'guild_users',
    birthdays: 'birthdays',
    giveaways: 'giveaways',
    tickets: 'ticket_data',
    afk_status: 'afk_status',
    welcome_configs: 'welcome_configs',
    leveling_configs: 'leveling_configs',
    user_levels: 'user_levels',
    economy: 'economy',
    invite_tracking: 'invite_tracking',
    application_roles: 'application_roles',
    verification_audit: 'verification_audit',
    temp_data: 'temp_data',
    cache_data: 'cache_data',
};

const allowedTableIdentifiers = new Set([
    'guilds',
    'users',
    'guild_users',
    'birthdays',
    'giveaways',
    'ticket_data',
    'afk_status',
    'welcome_configs',
    'leveling_configs',
    'user_levels',
    'economy',
    'invite_tracking',
    'application_roles',
    'verification_audit',
    'temp_data',
    'cache_data',
]);

const validatedTables = Object.fromEntries(
    Object.entries(configuredTables).map(([key, value]) => [
        key,
        assertAllowlistedIdentifier(value, allowedTableIdentifiers, `PostgreSQL table identifier (${key})`),
    ])
);

const DEFAULT_POSTGRES_URL = 'postgresql://localhost:5432/titanbot';

function getPostgresUrl() {
    return (
        process.env.POSTGRES_URL ||
        process.env.DATABASE_URL ||
        process.env.DATABASE_PRIVATE_URL ||
        process.env.DATABASE_PUBLIC_URL ||
        ''
    ).trim();
}

function getPgHost() {
    return process.env.POSTGRES_HOST || process.env.PGHOST || 'localhost';
}

function getPgPort() {
    return parseInt(process.env.POSTGRES_PORT || process.env.PGPORT, 10) || 5432;
}

function getPgDatabase() {
    return process.env.POSTGRES_DB || process.env.PGDATABASE || 'titanbot';
}

function getPgUser() {
    return process.env.POSTGRES_USER || process.env.PGUSER || 'postgres';
}

function getPgPassword() {
    return (process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || '').toString();
}

export function resolveSslConfig() {
    const sslEnv = (process.env.POSTGRES_SSL || process.env.PGSSLMODE || '').toLowerCase();
    if (sslEnv === 'false' || sslEnv === '0' || sslEnv === 'disable') {
        return false;
    }
    if (
        sslEnv === 'true' ||
        sslEnv === '1' ||
        sslEnv === 'require' ||
        sslEnv === 'verify-ca' ||
        sslEnv === 'verify-full' ||
        sslEnv === 'prefer'
    ) {
        return { rejectUnauthorized: false };
    }

    const url = getPostgresUrl();
    if (/sslmode=(require|verify-ca|verify-full|prefer)/i.test(url)) {
        return { rejectUnauthorized: false };
    }

    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
        return { rejectUnauthorized: false };
    }

    if (process.env.NODE_ENV === 'production') {
        return { rejectUnauthorized: false };
    }

    return false;
}

export function resolvePostgresPoolConfig() {
    const ssl = resolveSslConfig();
    const url = getPostgresUrl();
    const sharedOptions = {
        max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS, 10) || 20,
        min: parseInt(process.env.POSTGRES_MIN_CONNECTIONS, 10) || 2,
        idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT, 10) || 30000,
        connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT, 10) || 10000,
        application_name: 'titanbot',
        statement_timeout: process.env.NODE_ENV === 'production' ? 30000 : 0,
        keepalives: 1,
        keepalives_idle: 30,
        ssl,
    };

    if (url && url !== DEFAULT_POSTGRES_URL) {
        return { connectionString: url, ...sharedOptions };
    }

    return {
        host: getPgHost(),
        port: getPgPort(),
        database: getPgDatabase(),
        user: getPgUser(),
        password: getPgPassword(),
        ...sharedOptions,
    };
}

export const pgConfig = {
    url: getPostgresUrl() || DEFAULT_POSTGRES_URL,

    options: {
        host: getPgHost(),
        port: getPgPort(),
        database: getPgDatabase(),
        user: getPgUser(),
        password: getPgPassword(),
        ssl: resolveSslConfig(),

        max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS, 10) || 20,
        min: parseInt(process.env.POSTGRES_MIN_CONNECTIONS, 10) || 2,
        idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT, 10) || 30000,
        connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT, 10) || 10000,

        application_name: 'titanbot',
        statement_timeout: process.env.NODE_ENV === 'production' ? 30000 : 0,
        keepalives: 1,
        keepalives_idle: 30,

        retries: parseInt(process.env.POSTGRES_RETRIES, 10) || 3,
        backoffBase: parseInt(process.env.POSTGRES_BACKOFF_BASE, 10) || 100,
        backoffMultiplier: parseInt(process.env.POSTGRES_BACKOFF_MULTIPLIER, 10) || 2,
    },

    tables: validatedTables,

    defaultTTL: {
        userSession: 86400,
        temp: 3600,
        cache: 1800,
        guildConfig: null,
        economy: null,
        leveling: null,
        giveaway: null,
        ticket: 604800,
        afk: 86400,
        welcome: null,
        birthday: null,
    },

    features: {
        pooling: true,
        ssl: process.env.NODE_ENV === 'production',
        metrics: true,
        debug: process.env.NODE_ENV === 'development',
        autoCreateTables: true,
        autoMigrate: process.env.AUTO_MIGRATE !== 'false',
    },

    healthCheck: {
        enabled: true,
        interval: 30000,
        maxFailures: 3,
        query: 'SELECT 1',
    },

    migration: {
        enabled: true,
        table: 'schema_migrations',
        directory: 'database/migrations',
        rollbackOnFailure: false,
        expectedVersion: EXPECTED_SCHEMA_VERSION,
        expectedLabel: EXPECTED_SCHEMA_LABEL,
    }
};

export default pgConfig;
