// giveaways.js

import { logger } from './logger.js';
import { CloudyError, ErrorTypes } from './errorHandler.js';
import { unwrapReplitData } from './database.js';
import { Mutex } from './mutex.js';

export function giveawayKey(guildId) {
    return `guild:${guildId}:giveaways`;
}

function arrayToGiveawayMap(giveaways) {
    const map = {};
    if (Array.isArray(giveaways)) {
        for (const giveaway of giveaways) {
            if (giveaway && giveaway.messageId) {
                map[giveaway.messageId] = giveaway;
            }
        }
    }
    return map;
}

export async function getGuildGiveaways(client, guildId, { strict = false } = {}) {
    try {
        if (!client.db) {
            if (strict) throw new Error('Giveaway storage is unavailable');
            logger.warn('Database not available for getGuildGiveaways');
            return [];
        }

        const key = giveawayKey(guildId);
        const giveaways = await client.db.get(key, {}, { strict });
        const unwrappedGiveaways = unwrapReplitData(giveaways);

        if (typeof unwrappedGiveaways === 'object' && !Array.isArray(unwrappedGiveaways)) {
            return Object.values(unwrappedGiveaways || {});
        }
        return Array.isArray(unwrappedGiveaways) ? unwrappedGiveaways : [];
    } catch (error) {
        logger.error(`Error getting giveaways for guild ${guildId}:`, error);
        if (strict) throw error;
        return [];
    }
}

export async function saveGiveaway(client, guildId, giveawayData) {
    try {
        if (!client.db) {
            logger.warn('Database not available for saveGiveaway');
            return false;
        }

        if (!giveawayData || !giveawayData.messageId) {
            throw new CloudyError(
                'Invalid giveaway data: missing messageId',
                ErrorTypes.VALIDATION,
                'Cannot save giveaway without a message ID.',
                { giveawayData }
            );
        }

        const key = giveawayKey(guildId);
        return await Mutex.runExclusive(key, async () => {
            const giveaways = await getGuildGiveaways(client, guildId, { strict: true });
            const giveawayMap = arrayToGiveawayMap(giveaways);
            giveawayMap[giveawayData.messageId] = giveawayData;

            if ((await client.db.set(key, giveawayMap)) === false) return false;

            logger.debug(`Saved giveaway ${giveawayData.messageId} in guild ${guildId}`);
            return true;
        });
    } catch (error) {
        logger.error(`Error saving giveaway in guild ${guildId}:`, error);
        if (error instanceof CloudyError) {
            throw error;
        }
        return false;
    }
}

export async function deleteGiveaway(client, guildId, messageId) {
    try {
        if (!client.db) {
            logger.warn('Database not available for deleteGiveaway');
            return false;
        }

        if (!messageId) {
            throw new CloudyError(
                'Missing messageId parameter',
                ErrorTypes.VALIDATION,
                'Cannot delete giveaway without a message ID.',
                { messageId }
            );
        }

        const key = giveawayKey(guildId);
        return await Mutex.runExclusive(key, async () => {
            const giveaways = await getGuildGiveaways(client, guildId, { strict: true });
            const giveawayMap = arrayToGiveawayMap(giveaways);

            if (!giveawayMap[messageId]) {
                logger.debug(`Giveaway not found for deletion: ${messageId} in guild ${guildId}`);
                return false;
            }

            delete giveawayMap[messageId];
            if ((await client.db.set(key, giveawayMap)) === false) return false;

            logger.debug(`Deleted giveaway ${messageId} from guild ${guildId}`);
            return true;
        });
    } catch (error) {
        logger.error(`Error deleting giveaway ${messageId} in guild ${guildId}:`, error);
        if (error instanceof CloudyError) {
            throw error;
        }
        return false;
    }
}
