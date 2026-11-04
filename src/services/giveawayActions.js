import { normalizeDemoClaimCode } from './giveawayClaimPreview.js';
import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { CloudyError, ErrorTypes } from '../utils/errorHandler.js';
import { Mutex } from '../utils/mutex.js';
import { getEndedGiveaways, unwrapReplitData } from '../utils/database.js';
import { getGuildGiveaways, saveGiveaway, deleteGiveaway } from '../utils/giveaways.js';
import { getOrCreateGiveawayNumber } from './giveawayNumberService.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { rememberMessageDeleter } from './deletionAttributionService.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import {
    createGiveawayButtons,
    createGiveawayEmbed,
    createWinnerAnnouncement,
    DEFAULT_GIVEAWAY_CLAIM,
    DEFAULT_GIVEAWAY_FAILURE,
    LEGACY_GIVEAWAY_CLAIM,
    LEGACY_GIVEAWAY_FAILURE,
    PREVIOUS_GIVEAWAY_CLAIM,
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
// The winner-claim window begins only when a new winner announcement is sent.
export const GIVEAWAY_WINNER_CLAIM_WINDOW_MS = 24 * 60 * 60_000;
const claimRecordsKey = guildId => `guild:${guildId}:giveaway-claim:records`;
const newClaimDeadline = () => new Date(Date.now() + GIVEAWAY_WINNER_CLAIM_WINDOW_MS).toISOString();

// Staff = server owner, Owner role, Administrator or Manage Server.
export function canManageGiveaways(member, guild) {
    return Boolean(member && (member.id === guild?.ownerId || hasCloudyOwnerMember(member)
        || member.permissions?.has?.(PermissionFlagsBits.Administrator)
        || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)));
}

// Only the guild owner and members holding Cloudy's named Owner role may
// open or use the private giveaway management panel.
export function canManageGiveawaysAsOwner(member, guild) {
    return Boolean(member && (member.id === guild?.ownerId || hasCloudyOwnerMember(member)));
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

function giveawayMessagePayload(giveaway, status) {
    return {
        embeds: [createGiveawayEmbed(giveaway, status, giveaway.winnerIds || [])],
        components: createGiveawayButtons(giveaway, { ended: status !== 'active' }),
    };
}

export function activeGiveawayPayload(giveaway) {
    return giveawayMessagePayload(giveaway, isGiveawayFinished(giveaway) ? 'ended' : 'active');
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
        introTitle: giveawayText(draft.introTitle, 150),
        closingText: giveawayText(draft.closingText, 300),
        description: giveawayText(draft.description, 1000),
        requirements: giveawayText(draft.requirements, 500),
        claim: giveawayText(draft.claim, 500),
        claimDetails: giveawayText(draft.claimDetails, 1000),
        claimCodeInstructions: giveawayText(draft.claimCodeInstructions, 500),
        claimPanelTitle: giveawayText(draft.claimPanelTitle, 150),
        claimExpiryInstructions: giveawayText(draft.claimExpiryInstructions, 500),
        claimDemoCode: giveawayText(draft.claimDemoCode, 32),
        claimIntroduction: giveawayText(draft.claimIntroduction, 250),
        claimConditions: giveawayText(draft.claimConditions, 1000),
        claimHowToGet: giveawayText(draft.claimHowToGet, 500),
        claimReview: giveawayText(draft.claimReview, 1000),
        claimPleaseNote: giveawayText(draft.claimPleaseNote, 1000),
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
        components: createGiveawayButtons(giveaway, { ended: false }),
        allowedMentions: tag.allowedMentions,
    });
    giveaway.messageId = message.id;
    try {
        giveaway.giveawayNumber = await getOrCreateGiveawayNumber(client, guild.id, message.id);
    } catch (error) {
        logger.warn('Failed to assign giveaway number before publishing: ' + (error?.message || error));
        await message.delete().catch(() => {});
        throw giveawayError('Giveaway numbering persistence failed',
            'The giveaway could not be saved. Please try again.', ErrorTypes.DATABASE);
    }
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
        // Old giveaways have no claim deadline and are never retroactively
        // rerolled. Enable the 24h claim check only for announced winners.
        if (winners.length) ended.claimDeadlineAt = newClaimDeadline();
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
        if (winners.length) rerolled.claimDeadlineAt = newClaimDeadline();
        await persist(client, guildId, rerolled);
        return { giveaway: rerolled, winners };
    });
    await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_REROLL, 'Giveaway rerolled', result.giveaway,
        [{ name: 'New winners', value: result.winners.map(id => `<@${id}>`).join(', '), inline: false }], rerolledBy);
    return result;
}

// Update only the obsolete default instruction in already-posted winner
// announcements. Keep message IDs, mentions, buttons, thumbnails, styling and
// all other text unchanged. Custom claim instructions remain untouched.
export async function refreshExistingGiveawayClaimInstructions(client) {
    if (!client?.db) return;
    for (const guild of client.guilds?.cache?.values?.() || []) {
        let giveaways;
        try {
            giveaways = await getGuildGiveaways(client, guild.id, { strict: true });
        } catch (error) {
            logger.warn(`Could not load giveaway announcements for claim copy refresh in ${guild.id}:`, error);
            continue;
        }
        for (const giveaway of giveaways) {
            if (!isGiveawayFinished(giveaway)) continue;
            const announcementIds = [...new Set([
                ...(giveaway.announcementIds || []), giveaway.winnerPingMessageId,
            ].filter(Boolean))];
            if (!announcementIds.length) continue;
            const channel = await fetchGiveawayChannel(client, guild, giveaway.channelId);
            if (!channel) continue;
            for (const id of announcementIds) {
                try {
                    const message = await fetchGiveawayMessage(channel, id);
                    if (!message?.edit || !message.embeds?.length) continue;
                    let changed = false;
                    const embeds = message.embeds.map(embed => {
                        const data = embed.toJSON?.() || embed;
                        const description = data?.description;
                        if (!description) return data;
                        const outdated = [LEGACY_GIVEAWAY_CLAIM, PREVIOUS_GIVEAWAY_CLAIM]
                            .find(text => description.includes(text));
                        const updatedDescription = (outdated
                            ? description.replace(outdated, DEFAULT_GIVEAWAY_CLAIM)
                            : description
                        ).replace(LEGACY_GIVEAWAY_FAILURE, DEFAULT_GIVEAWAY_FAILURE);
                        if (updatedDescription === description) return data;
                        changed = true;
                        return { ...data, description: updatedDescription };
                    });
                    if (changed) await message.edit({ embeds });
                } catch (error) {
                    logger.warn(`Could not refresh claim instructions in announcement ${id}:`, error);
                }
            }
        }
    }
}

// Place the original final announcement immediately above the existing
// giveaway-ended date. Keep its exact wording and the date unchanged.
export function reorderEndedGiveawayDescription(description) {
    if (typeof description !== 'string') return description;
    const previous = /\n\n([^\n]*\*\*Giveaway ended\*\*\n<t:\d+:F>)\n\n(?:This giveaway has ended!|The winner\(s\) have been announced and tagged below!)$/;
    return description.replace(previous,
        (_, endedTimeBlock) => '\n\nThe winner(s) have been announced and tagged below!\n\n' + endedTimeBlock);
}

// Correct already-posted ended giveaways in place; change only the order of
// their last two blocks and restore the original sentence where necessary.
export async function refreshEndedGiveawayClosingCopy(client) {
    if (!client?.db?.get || !client?.db?.set) return;
    const since = Date.now() - 30 * 24 * 60 * 60_000;
    for (const guild of client.guilds?.cache?.values?.() || []) {
        const marker = 'guild:' + guild.id + ':giveaway:ended-copy-order-v2';
        try {
            if (await client.db.get(marker, false)) continue;
            const records = await getGuildGiveaways(client, guild.id, { strict: true });
            const ended = records
                .filter(item => isGiveawayFinished(item)
                    && /^\d{17,20}$/.test(String(item.messageId || ''))
                    && Date.parse(item.endedAt || '') >= since)
                .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
                .slice(0, 25);
            let failed = false;
            for (const giveaway of ended) {
                try {
                    const channel = await fetchGiveawayChannel(client, guild, giveaway.channelId);
                    if (!channel) continue;
                    const message = await fetchGiveawayMessage(channel, giveaway.messageId);
                    if (!message?.edit || !message.embeds?.length
                        || (message.author?.id && message.author.id !== client.user?.id)) continue;
                    let changed = false;
                    const embeds = message.embeds.map(embed => {
                        const data = embed.toJSON?.() || { ...embed };
                        const reordered = reorderEndedGiveawayDescription(data.description);
                        if (reordered === data.description) return data;
                        changed = true;
                        return { ...data, description: reordered };
                    });
                    if (changed) await message.edit({ embeds });
                } catch (error) {
                    failed = true;
                    logger.warn('Could not refresh ended giveaway copy for ' + giveaway.messageId, error);
                }
            }
            if (!failed) await client.db.set(marker, true);
        } catch (error) {
            logger.warn('Could not refresh ended giveaway copy in guild ' + guild.id, error);
        }
    }
}

// Replaces only winners who never opened their Claim channel within 24 hours.
// Claim and reroll both lock the same giveaway, so nobody can claim a slot
// concurrently with its replacement. An existing claim record (even if its
// channel was closed) counts as having claimed.
export async function rerollUnclaimedGiveaway(client, guild, messageId) {
    const guildId = guild?.id;
    const result = await Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await loadGiveaway(client, guildId, messageId);
        const deadline = Date.parse(giveaway?.claimDeadlineAt || '');
        if (!giveaway || !isGiveawayFinished(giveaway)
            || !Number.isFinite(deadline) || deadline > Date.now()) return null;

        const currentWinners = [...new Set(giveaway.winnerIds || [])];
        if (!currentWinners.length) {
            await persist(client, guildId, { ...giveaway, claimDeadlineAt: null });
            return null;
        }

        // Fail closed on storage errors: never mistake a DB outage for
        // "nobody claimed" and reroll someone's already-claimed prize.
        const claims = unwrapReplitData(await client.db.get(claimRecordsKey(guildId), {}, { strict: true })) || {};
        if (typeof claims !== 'object' || Array.isArray(claims)) {
            throw new Error('Giveaway claim records are unavailable');
        }
        const claimed = currentWinners.filter(userId =>
            Boolean(claims[`${messageId}:${userId}`]?.channelId));
        const missing = currentWinners.filter(userId => !claimed.includes(userId));
        if (!missing.length) {
            await persist(client, guildId, { ...giveaway, claimDeadlineAt: null });
            return { claimed, missing, newWinners: [], complete: true };
        }

        const channel = await fetchGiveawayChannel(client, guild, giveaway.channelId);
        const message = await fetchGiveawayMessage(channel, messageId);
        if (!message) {
            // Never announce a replacement for a giveaway removed in Discord.
            await persist(client, guildId, { ...giveaway, claimDeadlineAt: null });
            return null;
        }

        const excluded = new Set([...(giveaway.previousWinnerIds || []), ...currentWinners]);
        const pool = giveawayParticipants(giveaway).filter(id => !excluded.has(id));
        const newWinners = pool.length ? selectWinners(pool, Math.min(missing.length, pool.length)) : [];
        const rerolled = {
            ...giveaway,
            winnerIds: [...claimed, ...newWinners],
            previousWinnerIds: [...excluded],
            rerolledAt: new Date().toISOString(),
            rerolledBy: 'automatic',
            // Renew the 24h window only for genuinely new, unclaimed winners.
            // When the participant pool is exhausted, stop checking forever.
            claimDeadlineAt: newWinners.length ? newClaimDeadline() : null,
        };
        // Persist before changing Discord: no failed DB write may announce a
        // winner. The advanced deadline also prevents duplicate automatic
        // draws on subsequent sweeps or after restarting.
        await persist(client, guildId, rerolled);
        await message.edit(giveawayMessagePayload(rerolled, 'reroll'));
        if (newWinners.length) {
            const announcement = await channel.send({
                ...createWinnerAnnouncement(rerolled, newWinners, { reroll: true }),
                reply: { messageReference: messageId, failIfNotExists: false },
            });
            rerolled.announcementIds = [...(rerolled.announcementIds || []), announcement.id];
            rerolled.winnerPingMessageId = announcement.id;
            await persist(client, guildId, rerolled);
        }
        return { giveaway: rerolled, claimed, missing, newWinners, complete: !newWinners.length };
    });
    if (result?.newWinners?.length) {
        await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_REROLL,
            'Unclaimed giveaway prizes automatically rerolled', result.giveaway, [
                { name: 'Unclaimed slots', value: String(result.missing.length), inline: true },
                { name: 'New winners', value: result.newWinners.map(id => `<@${id}>`).join(', '), inline: false },
            ]);
    }
    return result;
}

// Runs with claim-channel cleanup every minute, including once on startup.
// Only giveaways with an explicit claimDeadlineAt are considered, so deploying
// this feature cannot unexpectedly reroll any historical giveaway.
export async function checkUnclaimedGiveawayWinners(client) {
    if (!client?.db) return;
    for (const guild of client.guilds?.cache?.values?.() || []) {
        try {
            const giveaways = await getGuildGiveaways(client, guild.id, { strict: true });
            for (const giveaway of giveaways) {
                const deadline = Date.parse(giveaway?.claimDeadlineAt || '');
                if (!Number.isFinite(deadline) || deadline > Date.now()) continue;
                try {
                    await rerollUnclaimedGiveaway(client, guild, giveaway.messageId);
                } catch (error) {
                    logger.error(`Automatic claim reroll failed for ${giveaway.messageId} in ${guild.id}:`, error);
                }
            }
        } catch (error) {
            logger.error(`Could not check unclaimed giveaways in guild ${guild.id}:`, error);
        }
    }
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
            ...(fields.prize !== undefined ? { prize: validatePrize(fields.prize) } : {}),
            ...(fields.introTitle !== undefined ? { introTitle: giveawayText(fields.introTitle, 150) } : {}),
            ...(fields.closingText !== undefined ? { closingText: giveawayText(fields.closingText, 300) } : {}),
            ...(fields.description !== undefined ? { description: giveawayText(fields.description, 1000) } : {}),
            ...(fields.requirements !== undefined ? { requirements: giveawayText(fields.requirements, 500) } : {}),
            ...(fields.claim !== undefined ? { claim: giveawayText(fields.claim, 500) } : {}),
            ...(fields.claimDetails !== undefined ? { claimDetails: giveawayText(fields.claimDetails, 1000) } : {}),
            ...(fields.claimCodeInstructions !== undefined ? { claimCodeInstructions: giveawayText(fields.claimCodeInstructions, 500) } : {}),
            ...(fields.claimPanelTitle !== undefined ? { claimPanelTitle: giveawayText(fields.claimPanelTitle, 150) } : {}),
            ...(fields.claimExpiryInstructions !== undefined ? { claimExpiryInstructions: giveawayText(fields.claimExpiryInstructions, 500) } : {}),
            ...(fields.claimDemoCode !== undefined ? { claimDemoCode: normalizeDemoClaimCode(fields.claimDemoCode) } : {}),
            ...(fields.claimIntroduction !== undefined ? { claimIntroduction: giveawayText(fields.claimIntroduction, 250) } : {}),
            ...(fields.claimConditions !== undefined ? { claimConditions: giveawayText(fields.claimConditions, 1000) } : {}),
            ...(fields.claimHowToGet !== undefined ? { claimHowToGet: giveawayText(fields.claimHowToGet, 500) } : {}),
            ...(fields.claimReview !== undefined ? { claimReview: giveawayText(fields.claimReview, 1000) } : {}),
            ...(fields.claimPleaseNote !== undefined ? { claimPleaseNote: giveawayText(fields.claimPleaseNote, 1000) } : {}),
        };
        if (['prize', 'introTitle', 'closingText', 'description', 'requirements', 'claim', 'claimDetails', 'claimCodeInstructions', 'claimPanelTitle', 'claimExpiryInstructions', 'claimDemoCode', 'claimIntroduction', 'claimConditions', 'claimHowToGet', 'claimReview', 'claimPleaseNote'].every(key => updated[key] === giveaway[key])) {
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
