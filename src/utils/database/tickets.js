import { logger } from '../logger.js';
import { db, getFromDb } from './wrapper.js';
import { getTicketCounterKey, getTicketKey } from './keys.js';

export { getTicketKey, getTicketCounterKey } from './keys.js';

const TICKET_STATS_TIMEOUT_MS = 1000;
const TICKET_CACHE_TTL_MS = 5000;
const ticketCache = new Map();
const ticketWriteQueues = new Map();
const ticketCounterQueues = new Map();
const ticketBaselines = new WeakMap();

function cloneValue(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function valuesEqual(a, b) {
    if (a === b) return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

function ticketQueueKey(guildId, channelId) {
    return `${guildId}:${channelId}`;
}

function cacheTicket(guildId, channelId, data) {
    const key = ticketQueueKey(guildId, channelId);
    ticketCache.set(key, {
        value: cloneValue(data),
        expiresAt: Date.now() + TICKET_CACHE_TTL_MS,
    });
}

function readCachedTicket(guildId, channelId) {
    const key = ticketQueueKey(guildId, channelId);
    const cached = ticketCache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
        ticketCache.delete(key);
        return undefined;
    }
    return cloneValue(cached.value);
}

function rememberBaseline(data) {
    if (!data || typeof data !== 'object') return data;
    ticketBaselines.set(data, cloneValue(data));
    return data;
}

function enqueue(map, key, operation) {
    const previous = map.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    map.set(key, current);
    current.finally(() => {
        if (map.get(key) === current) map.delete(key);
    }).catch(() => {});
    return current;
}

function deriveTicketPatch(data, baseline) {
    if (!baseline || typeof baseline !== 'object') {
        return { fullReplace: true, value: cloneValue(data), patch: null, removed: [] };
    }

    const patch = {};
    const removed = [];
    const keys = new Set([...Object.keys(baseline), ...Object.keys(data || {})]);

    for (const key of keys) {
        const hasNow = Object.prototype.hasOwnProperty.call(data, key);
        const hadBefore = Object.prototype.hasOwnProperty.call(baseline, key);

        if (!hasNow && hadBefore) {
            removed.push(key);
            continue;
        }

        if (hasNow && (!hadBefore || !valuesEqual(data[key], baseline[key]))) {
            patch[key] = cloneValue(data[key]);
        }
    }

    return { fullReplace: false, value: null, patch, removed };
}

export async function getTicketData(guildId, channelId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const cached = readCachedTicket(guildId, channelId);
    if (cached !== undefined) {
        return rememberBaseline(cached);
    }

    const key = getTicketKey(guildId, channelId);
    const value = await db.get(key, null);
    if (value === null || value === undefined) return value;

    cacheTicket(guildId, channelId, value);
    return rememberBaseline(cloneValue(value));
}

export async function getOpenTicketCountForUser(guildId, userId) {
    try {
        if (!db.initialized) {
            await db.initialize();
        }

        if (db.db?.pool && typeof db.db.isAvailable === 'function' && db.db.isAvailable()) {
            const { pgConfig } = await import('../../config/database/postgres.js');
            const result = await db.db.pool.query(
                `SELECT COUNT(*)::int AS count FROM ${pgConfig.tables.tickets}
                 WHERE guild_id = $1
                   AND data->>'userId' = $2
                   AND data->>'status' = 'open'`,
                [guildId, userId],
            );

            return Number(result.rows?.[0]?.count || 0);
        }

        if (typeof db.list === 'function') {
            const ticketKeys = await db.list(`guild:${guildId}:ticket:`);
            let count = 0;

            for (const key of ticketKeys) {
                if (key.endsWith(':counter')) continue;
                const ticket = await getFromDb(key, null);
                if (ticket && ticket.userId === userId && ticket.status === 'open') {
                    count += 1;
                }
            }

            return count;
        }

        return 0;
    } catch (error) {
        logger.error(`Error counting open tickets for user ${userId} in guild ${guildId}:`, error);
        return 0;
    }
}

export async function saveTicketData(guildId, channelId, data) {
    if (!db.initialized) {
        await db.initialize();
    }

    const queueKey = ticketQueueKey(guildId, channelId);
    const storageKey = getTicketKey(guildId, channelId);
    const baseline = ticketBaselines.get(data);
    const change = deriveTicketPatch(data, baseline);

    const saved = await enqueue(ticketWriteQueues, queueKey, async () => {
        let nextData;

        if (change.fullReplace) {
            nextData = cloneValue(change.value);
        } else {
            const latest = await db.get(storageKey, null);
            const latestObject = latest && typeof latest === 'object' ? latest : {};
            nextData = { ...latestObject, ...change.patch };
            for (const key of change.removed) delete nextData[key];
        }

        const result = await db.set(storageKey, nextData);
        if (result === false) {
            const error = new Error(`Ticket database rejected write for ${storageKey}`);
            error.code = 'TICKET_DATABASE_WRITE_FAILED';
            throw error;
        }

        cacheTicket(guildId, channelId, nextData);
        return cloneValue(nextData);
    });

    if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, cloneValue(saved));
        ticketBaselines.set(data, cloneValue(saved));
    }

    return saved;
}

export async function deleteTicketData(guildId, channelId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const queueKey = ticketQueueKey(guildId, channelId);
    const storageKey = getTicketKey(guildId, channelId);

    return await enqueue(ticketWriteQueues, queueKey, async () => {
        const result = await db.delete(storageKey);
        if (result === false) {
            const error = new Error(`Ticket database rejected delete for ${storageKey}`);
            error.code = 'TICKET_DATABASE_DELETE_FAILED';
            throw error;
        }
        ticketCache.delete(queueKey);
        return true;
    });
}

export async function getTicketCounter(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketCounterKey(guildId);
    const counter = await db.get(key, 0);
    return Number(counter) || 0;
}

export async function incrementTicketCounter(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketCounterKey(guildId);
    const queueKey = String(guildId);

    const nextCounter = await enqueue(ticketCounterQueues, queueKey, async () => {
        const currentCounter = Number(await db.get(key, 0)) || 0;
        const next = currentCounter + 1;
        const result = await db.set(key, next);
        if (result === false) {
            const error = new Error(`Ticket counter write failed for guild ${guildId}`);
            error.code = 'TICKET_COUNTER_WRITE_FAILED';
            throw error;
        }
        return next;
    });

    return nextCounter.toString().padStart(3, '0');
}

async function listGuildTickets(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (db.db?.pool && typeof db.db.isAvailable === 'function' && db.db.isAvailable()) {
        const { pgConfig } = await import('../../config/database/postgres.js');
        const result = await db.db.pool.query(
            `SELECT data FROM ${pgConfig.tables.tickets} WHERE guild_id = $1`,
            [guildId],
        );
        return result.rows.map((row) => row.data).filter(Boolean);
    }

    if (typeof db.list !== 'function') {
        return [];
    }

    const ticketKeys = await db.list(`guild:${guildId}:ticket:`);
    const tickets = [];

    for (const key of ticketKeys) {
        if (key.endsWith(':counter')) continue;
        const ticket = await getFromDb(key, null);
        if (ticket) tickets.push(ticket);
    }

    return tickets;
}

export async function getGuildTicketStats(guildId) {
    try {
        let timer;
        const tickets = await Promise.race([
            listGuildTickets(guildId),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), TICKET_STATS_TIMEOUT_MS);
            }),
        ]).finally(() => {
            if (timer) clearTimeout(timer);
        });

        if (!tickets) {
            logger.warn(`Ticket stats timed out for guild ${guildId}; opening dashboard without stats.`);
            return null;
        }

        let openCount = 0;
        let closedCount = 0;
        let totalCloseMs = 0;
        let closeSamples = 0;
        let feedbackCount = 0;
        let ratingSum = 0;

        for (const ticket of tickets) {
            if (ticket.status === 'open') {
                openCount += 1;
            } else if (ticket.status === 'closed') {
                closedCount += 1;
                if (ticket.createdAt && ticket.closedAt) {
                    const duration = new Date(ticket.closedAt) - new Date(ticket.createdAt);
                    if (Number.isFinite(duration) && duration >= 0) {
                        totalCloseMs += duration;
                        closeSamples += 1;
                    }
                }
            }

            const rating = ticket.feedback?.rating;
            if (rating != null && Number.isFinite(Number(rating))) {
                feedbackCount += 1;
                ratingSum += Number(rating);
            }
        }

        return {
            openCount,
            closedCount,
            avgCloseTimeMs: closeSamples > 0 ? Math.round(totalCloseMs / closeSamples) : null,
            feedbackCount,
            avgRating: feedbackCount > 0 ? Math.round((ratingSum / feedbackCount) * 10) / 10 : null,
        };
    } catch (error) {
        logger.error(`Error computing ticket stats for guild ${guildId}:`, error);
        return null;
    }
}
