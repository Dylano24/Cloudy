import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { CloudyError, ErrorTypes } from '../utils/errorHandler.js';
import { Mutex } from '../utils/mutex.js';
import { getEndedGiveaways } from '../utils/database.js';
import { getGuildGiveaways, saveGiveaway, deleteGiveaway } from '../utils/giveaways.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { rememberMessageDeleter } from './deletionAttributionService.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import {
    createGiveawayButtons,
    createGiveawayEmbed,
    createWinnerAnnouncement,
    customEmoji,
    MANAGE_EMOJI_NAME,
    giveawayEndTime,
    giveawayParticipants,
    giveawayPing,
    giveawayText,
    isGiveawayFinished,
    selectWinners,
    validatePrize,
    validateWinnerCount,
} from './giveawayService.js';

const lockKey = messageId => `giveaway:${messageId}`;

// Staff = server owner, Owner role, Administrator or Manage Server.
export function canManageGiveaways(member, guild) {
    return Boolean(member && (member.id === guild?.ownerId || hasCloudyOwnerMember(member)
        || member.permissions?.has?.(PermissionFlagsBits.Administrator)
        || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)));
}

function giveawayError(message, userMessage, type = ErrorTypes.VALIDATION, context = {}) {
    return new CloudyError(message, type, userMessage, { expected: true, ...context });
}

async function persist(client, guildId, giveaway) {
    if (!await saveGiveaway(client, guildId, giveaway)) {
        throw giveawayError('Giveaway persistence failed', 'The giveaway could not be saved. Please try again.', ErrorTypes.DATABASE);
    }
    return giveaway;
}

export async function loadGiveaway(client, guildId, messageId) {
    const giveaways = await getGuildGiveaways(client, guildId, { strict: true });
    return giveaways.find(giveaway => giveaway?.messageId === messageId) || null;
}

async function requireGiveaway(client, guildId, messageId) {
    const giveaway = await loadGiveaway(client, guildId, messageId);
    if (!giveaway) {
        throw giveawayError(`Giveaway ${messageId} not found`, 'This giveaway could not be found.', ErrorTypes.VALIDATION, { messageId });
    }
    return giveaway;
}

// Lookups that may be missing on some objects never throw.
const attempt = async lookup => {
    try { return (await lookup()) || null; } catch { return null; }
};

async function fetchGiveawayChannel(client, guild, channelId) {
    if (!channelId) return null;
    return guild?.channels?.cache?.get?.(channelId)
        || await attempt(() => guild?.channels?.fetch?.(channelId))
        || await attempt(() => client?.channels?.fetch?.(channelId));
}

async function fetchGiveawayMessage(channel, messageId) {
    return attempt(() => channel?.messages?.fetch?.(messageId));
}

function giveawayMessagePayload(giveaway, status, client = null) {
    return {
        embeds: [createGiveawayEmbed(giveaway, status, giveaway.winnerIds || [])],
        components: createGiveawayButtons(giveaway, { ended: status !== 'active', manageIcon: customEmoji(client, MANAGE_EMOJI_NAME) }),
    };
}

export function activeGiveawayPayload(giveaway, client = null) {
    return giveawayMessagePayload(giveaway, isGiveawayFinished(giveaway) ? 'ended' : 'active', client);
}

function hasTimedOut(giveaway) {
    const endsAt = giveawayEndTime(giveaway);
    return Boolean(endsAt) && Date.now() >= endsAt;
}

// Enter/Leave: one change per giveaway at a time, saved before the button
// count changes.
async function changeEntry(client, guildId, messageId, userId, enter) {
    return Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await loadGiveaway(client, guildId, messageId);
        if (!giveaway) return { status: 'missing' };
        if (isGiveawayFinished(giveaway) || hasTimedOut(giveaway)) return { status: 'ended', giveaway };
        const participants = giveawayParticipants(giveaway);
        const entered = participants.includes(userId);
        if (enter && entered) return { status: 'already', giveaway };
        if (!enter && !entered) return { status: 'not-entered', giveaway };
        const updated = {
            ...giveaway,
            participants: enter ? [...participants, userId] : participants.filter(id => id !== userId),
        };
        await persist(client, guildId, updated);
        return { status: enter ? 'entered' : 'left', giveaway: updated };
    });
}

export const enterGiveaway = (client, guildId, messageId, userId) => changeEntry(client, guildId, messageId, userId, true);
export const leaveGiveaway = (client, guildId, messageId, userId) => changeEntry(client, guildId, messageId, userId, false);

async function logGiveaway(client, guildId, eventType, description, giveaway, extraFields = [], userId = null) {
    try {
        await logEvent({
            client,
            guildId,
            eventType,
            data: {
                description,
                channelId: giveaway.channelId,
                ...(userId ? { userId } : {}),
                fields: [
                    { name: 'Prize', value: giveaway.prize || 'Mystery prize', inline: true },
                    { name: 'Entries', value: String(giveawayParticipants(giveaway).length), inline: true },
                    ...extraFields,
                ],
            },
        });
    } catch (error) {
        logger.debug('Error logging giveaway event:', error);
    }
}

// Posts a new giveaway (with its tag) and saves it. A giveaway that cannot be
// saved is removed again, so no button ever points at a missing record.
export async function postGiveaway(client, guild, channel, draft) {
    const prize = validatePrize(draft.prize);
    const winnerCount = Number(draft.winnerCount);
    validateWinnerCount(winnerCount);
    const ping = draft.ping?.type === 'everyone' ? { id: guild.id }
        : draft.ping?.type === 'role' && draft.ping.roleId ? { id: draft.ping.roleId } : null;
    const tag = giveawayPing(ping, guild.id);
    const endsAt = Date.now() + Number(draft.durationMs);
    const giveaway = {
        messageId: 'placeholder',
        channelId: channel.id,
        guildId: guild.id,
        prize,
        description: giveawayText(draft.description, 1000),
        requirements: giveawayText(draft.requirements, 500),
        claim: giveawayText(draft.claim, 500),
        pingRoleId: draft.ping?.type === 'role' ? draft.ping.roleId : null,
        pingEveryone: draft.ping?.type === 'everyone',
        hostId: draft.hostId,
        endTime: endsAt,
        endsAt,
        winnerCount,
        participants: [],
        isEnded: false,
        ended: false,
        createdAt: new Date().toISOString(),
    };
    const message = await channel.send({
        ...(tag.content ? { content: tag.content } : {}),
        embeds: [createGiveawayEmbed(giveaway, 'active')],
        components: createGiveawayButtons(giveaway, { ended: false, manageIcon: customEmoji(client, MANAGE_EMOJI_NAME) }),
        allowedMentions: tag.allowedMentions,
    });
    giveaway.messageId = message.id;
    if (!await saveGiveaway(client, guild.id, giveaway)) {
        logger.warn(`Failed to save giveaway to database: ${message.id}`);
        await message.delete().catch(() => {});
        throw giveawayError('Giveaway persistence failed', 'The giveaway could not be saved. Please try again.', ErrorTypes.DATABASE);
    }
    return giveaway;
}

// Draws the winners, marks the giveaway ended, and announces the winners.
// The result is saved before anything is shown, so a failed save never
// announces winners that were not stored.
export async function finishGiveaway(client, guild, messageId, { endedBy = 'automatic' } = {}) {
    const guildId = guild?.id;
    const result = await Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await requireGiveaway(client, guildId, messageId);
        if (isGiveawayFinished(giveaway)) {
            throw giveawayError(`Giveaway ${messageId} already ended`, 'This giveaway has already ended.', ErrorTypes.VALIDATION, { status: 'already_ended' });
        }
        const participants = giveawayParticipants(giveaway);
        const winners = selectWinners(participants, giveaway.winnerCount || 1);
        const ended = {
            ...giveaway,
            participants,
            ended: true,
            isEnded: true,
            winnerIds: winners,
            endedAt: new Date().toISOString(),
            endedBy,
            participantCount: participants.length,
        };
        await persist(client, guildId, ended);

        const channel = await fetchGiveawayChannel(client, guild, ended.channelId);
        const message = await fetchGiveawayMessage(channel, messageId);
        // A giveaway message someone removed is closed silently: nobody is
        // tagged for a giveaway that is no longer visible.
        if (!message) return { giveaway: ended, winners, announced: false };

        await message.edit(giveawayMessagePayload(ended, 'ended', client));
        const announcement = await channel.send({
            ...createWinnerAnnouncement(ended, winners),
            reply: { messageReference: messageId, failIfNotExists: false },
        });
        ended.announcementIds = [...(ended.announcementIds || []), announcement.id];
        ended.winnerPingMessageId = announcement.id;
        await persist(client, guildId, ended);
        return { giveaway: ended, winners, announced: true };
    });
    await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_WINNER,
        `Giveaway ended with ${result.winners.length} winner(s)`, result.giveaway,
        [{ name: 'Winners', value: result.winners.length ? result.winners.map(id => `<@${id}>`).join(', ') : 'No valid entries', inline: false }],
        endedBy === 'automatic' ? null : endedBy);
    return result;
}

// Draws new winners for an ended giveaway; earlier winners are not drawn again.
export async function rerollGiveaway(client, guild, messageId, { rerolledBy } = {}) {
    const guildId = guild?.id;
    const result = await Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await requireGiveaway(client, guildId, messageId);
        if (!isGiveawayFinished(giveaway)) {
            throw giveawayError('Giveaway still active', 'This giveaway has not ended yet. End it first.');
        }
        const participants = giveawayParticipants(giveaway);
        if (!participants.length) {
            throw giveawayError('No participants to reroll', 'There are no entries to reroll from.');
        }
        const previousWinners = [...new Set([...(giveaway.previousWinnerIds || []), ...(giveaway.winnerIds || [])])];
        const pool = participants.filter(id => !previousWinners.includes(id));
        if (!pool.length) {
            throw giveawayError('No new participants to reroll', 'Everyone who entered has already won. There is nobody new to draw.');
        }
        const winners = selectWinners(pool, giveaway.winnerCount || 1);
        const rerolled = {
            ...giveaway,
            winnerIds: winners,
            previousWinnerIds: previousWinners,
            rerolledAt: new Date().toISOString(),
            rerolledBy,
        };
        await persist(client, guildId, rerolled);

        const channel = await fetchGiveawayChannel(client, guild, rerolled.channelId);
        const message = await fetchGiveawayMessage(channel, messageId);
        if (!message) {
            throw giveawayError('Giveaway message missing', 'The giveaway message no longer exists, so no new winner was announced.');
        }
        await message.edit(giveawayMessagePayload(rerolled, 'reroll', client));
        const announcement = await channel.send({
            ...createWinnerAnnouncement(rerolled, winners, { reroll: true }),
            reply: { messageReference: messageId, failIfNotExists: false },
        });
        rerolled.announcementIds = [...(rerolled.announcementIds || []), announcement.id];
        rerolled.winnerPingMessageId = announcement.id;
        await persist(client, guildId, rerolled);
        return { giveaway: rerolled, winners };
    });
    await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_REROLL, 'Giveaway rerolled', result.giveaway,
        [{ name: 'New winners', value: result.winners.map(id => `<@${id}>`).join(', '), inline: false }], rerolledBy);
    return result;
}

// Update text on the same physical message; do not change timers or participants.
export async function setGiveawayText(client, guild, messageId, fields) {
    const guildId = guild?.id;
    return Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await requireGiveaway(client, guildId, messageId);
        if (isGiveawayFinished(giveaway)) {
            throw giveawayError('Giveaway already ended', 'This giveaway has already ended.');
        }
        const updated = {
            ...giveaway,
            prize: validatePrize(fields.prize),
            description: giveawayText(fields.description, 1000),
            requirements: giveawayText(fields.requirements, 500),
            claim: giveawayText(fields.claim, 500),
        };
        if (['prize', 'description', 'requirements', 'claim'].every(key => updated[key] === giveaway[key])) {
            return updated;
        }
        const channel = await fetchGiveawayChannel(client, guild, giveaway.channelId);
        const message = await fetchGiveawayMessage(channel, messageId);
        if (!message) throw giveawayError('Giveaway message missing', 'The giveaway message no longer exists.');
        await persist(client, guildId, updated);
        try {
            await message.edit(giveawayMessagePayload(updated, 'active', client));
        } catch (error) {
            await persist(client, guildId, giveaway).catch(restoreError =>
                logger.error('Could not restore giveaway after edit failure:', restoreError));
            throw error;
        }
        return updated;
    });
}

// Edit timer: the giveaway now ends this long from now.
export async function setGiveawayTimer(client, guild, messageId, durationMs) {
    const guildId = guild?.id;
    return Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await requireGiveaway(client, guildId, messageId);
        if (isGiveawayFinished(giveaway)) {
            throw giveawayError('Giveaway already ended', 'This giveaway has already ended.');
        }
        const endsAt = Date.now() + durationMs;
        const updated = { ...giveaway, endsAt, endTime: endsAt };
        await persist(client, guildId, updated);
        const channel = await fetchGiveawayChannel(client, guild, updated.channelId);
        const message = await fetchGiveawayMessage(channel, messageId);
        if (message) await message.edit(giveawayMessagePayload(updated, 'active', client));
        return updated;
    });
}

// Delete: the record first (so the automatic end never announces it), then
// the giveaway message and its winner announcements.
export async function removeGiveaway(client, guild, messageId, { deletedBy } = {}) {
    const guildId = guild?.id;
    const giveaway = await Mutex.runExclusive(lockKey(messageId), async () => {
        const current = await requireGiveaway(client, guildId, messageId);
        if (!await deleteGiveaway(client, guildId, messageId)) {
            throw giveawayError('Failed to delete giveaway from database', 'Failed to delete giveaway from database. Please try again.', ErrorTypes.DATABASE);
        }
        const channel = await fetchGiveawayChannel(client, guild, current.channelId);
        const ids = [messageId, ...new Set([...(current.announcementIds || []), current.winnerPingMessageId].filter(Boolean))];
        for (const id of ids) {
            const message = await fetchGiveawayMessage(channel, id);
            if (!message) continue;
            if (deletedBy) rememberMessageDeleter(message, deletedBy);
            await message.delete().catch(() => {});
        }
        return current;
    });
    await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_DELETE, 'Giveaway deleted', giveaway, [], deletedBy?.id || null);
    return giveaway;
}

// Runs every minute: ends giveaways whose time is up.
export async function checkGiveaways(client) {
    try {
        if (!client?.db) return;
        const due = await getEndedGiveaways(client);
        for (const record of due) {
            const guildId = record.guild_id || record.guildId;
            const messageId = record.message_id || record.messageId;
            const guild = client.guilds?.cache?.get?.(guildId);
            if (!guild || !messageId) continue;
            try {
                await finishGiveaway(client, guild, messageId, { endedBy: 'automatic' });
                logger.info(`Ended giveaway ${messageId} in guild ${guildId}`);
            } catch (error) {
                if (error?.context?.status === 'already_ended') continue;
                logger.error(`Error ending giveaway ${messageId}:`, error);
            }
        }
    } catch (error) {
        logger.error('Error checking giveaways:', error);
    }
}
