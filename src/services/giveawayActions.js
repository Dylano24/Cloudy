import { normalizeDemoClaimCode } from './giveawayClaimPreview.js';
import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { CloudyError, ErrorTypes } from '../utils/errorHandler.js';
import { Mutex } from '../utils/mutex.js';
import { getEndedGiveaways, getGiveawaysAwaitingResult, unwrapReplitData } from '../utils/database.js';
import { getGuildGiveaways, saveGiveaway, deleteGiveaway } from '../utils/giveaways.js';
import { getOrCreateGiveawayNumber } from './giveawayNumberService.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { rememberMessageDeleter } from './deletionAttributionService.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { sendGiveawayEndedLog, sendGiveawayWinnerCountryLog } from './giveawayLogService.js';
import { GIVEAWAY_CODE_TYPES, validDiscount, withAddedCodes } from './giveawayCodeService.js';
import {
    createGiveawayButtons,
    createGiveawayEmbed,
    endedGiveawayWinnerMessage,
    createWinnerAnnouncement,
    DEFAULT_GIVEAWAY_CLAIM,
    GIVEAWAY_CLAIM_BUTTON_EMOJI,
    DEFAULT_GIVEAWAY_FAILURE,
    LEGACY_GIVEAWAY_CLAIM,
    LEGACY_GIVEAWAY_FAILURE,
    PREVIOUS_GIVEAWAY_CLAIM,
    FORMER_GIVEAWAY_CLAIM,
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

// Unknown Channel / Unknown Message: the giveaway is really gone from Discord.
const GONE_CODES = new Set([10003, 10008]);
const isGone = error => GONE_CODES.has(error?.code);
// Discord answered with an error, so the request was certainly not carried out.
const wasRejected = error => Number.isInteger(error?.status) && error.status >= 400;

// Like the two lookups above, but it tells "gone" apart from "could not be
// checked right now" (Discord busy, a timeout, a restart in progress). A
// giveaway is never closed, and a winner never dropped, on a guess.
async function locateGiveawayMessage(client, guild, channelId, messageId) {
    let channel = (channelId && guild?.channels?.cache?.get?.(channelId)) || null;
    let failure = null;
    for (const lookup of [() => guild?.channels?.fetch?.(channelId), () => client?.channels?.fetch?.(channelId)]) {
        if (channel || !channelId) break;
        try {
            channel = (await lookup()) || null;
        } catch (error) {
            if (!isGone(error)) failure ||= error;
        }
    }
    if (!channel) return failure ? { status: 'unavailable', error: failure } : { status: 'gone' };
    try {
        const message = (await channel.messages?.fetch?.(messageId)) || null;
        return message ? { status: 'found', channel, message } : { status: 'gone' };
    } catch (error) {
        return isGone(error) ? { status: 'gone' } : { status: 'unavailable', error };
    }
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
async function changeEntry(client, guildId, messageId, userId, enter, { country = null } = {}) {
    return Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await loadGiveaway(client, guildId, messageId);
        if (!giveaway) return { status: 'missing' };
        if (isGiveawayFinished(giveaway) || hasTimedOut(giveaway)) return { status: 'ended', giveaway };
        const participants = giveawayParticipants(giveaway);
        const entered = participants.includes(userId);
        if (enter && entered) return { status: 'already', giveaway };
        if (!enter && !entered) return { status: 'not-entered', giveaway };
        // The country of a member who entered a giveaway without a code.
        const countries = { ...(giveaway.participantCountries || {}) };
        if (enter && country) countries[userId] = country;
        if (!enter) delete countries[userId];
        const updated = {
            ...giveaway,
            participants: enter ? [...participants, userId] : participants.filter(id => id !== userId),
            ...(giveaway.participantCountries || country ? { participantCountries: countries } : {}),
        };
        await persist(client, guildId, updated);
        return { status: enter ? 'entered' : 'left', giveaway: updated };
    });
}

export const enterGiveaway = (client, guildId, messageId, userId, options = {}) =>
    changeEntry(client, guildId, messageId, userId, true, options);
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
        // No code (default): hosted outside the website, members choose their
        // country. Otherwise Cloudy generates a code for every winner.
        codeType: Object.hasOwn(GIVEAWAY_CODE_TYPES, draft.codeType || '') ? draft.codeType : 'none',
        codeDiscount: draft.codeType === 'discount' ? validDiscount(draft.codeDiscount) || 10 : null,
        // Staff's own existing codes: each winner takes the next unused one.
        addedCodes: draft.codeType === 'added' ? withAddedCodes({}, draft.plainAddedCodes || []) : [],
        participantCountries: {},
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

// A drawn result is saved before anything is shown. Until Discord shows it,
// the giveaway carries `resultPending` ({ kind, winners, attempts }), so a
// restart or a Discord outage at exactly that moment is picked up again by
// the next minute's check instead of leaving winners unannounced for good.
export const GIVEAWAY_RESULT_MAX_ATTEMPTS = 30;
const pendingResult = (kind, winners) => ({ kind, winners: [...winners], attempts: 0 });

function withoutPendingResult(giveaway) {
    const { resultPending: _pending, ...rest } = giveaway;
    return rest;
}

// The result could not be shown yet: keep it for the next check, at most
// GIVEAWAY_RESULT_MAX_ATTEMPTS times (then it is closed and logged as an error).
async function deferGiveawayResult(client, guildId, giveaway, error) {
    const pending = giveaway.resultPending;
    const attempts = (Number(pending.attempts) || 0) + 1;
    const abandoned = attempts >= GIVEAWAY_RESULT_MAX_ATTEMPTS;
    const next = abandoned
        ? { ...withoutPendingResult(giveaway), resultAbandonedAt: new Date().toISOString() }
        : { ...giveaway, resultPending: { ...pending, attempts } };
    await persist(client, guildId, next);
    const text = `Giveaway ${giveaway.messageId}: the result could not be shown in Discord `
        + `(attempt ${attempts}/${GIVEAWAY_RESULT_MAX_ATTEMPTS}): ${error?.message || error}`;
    if (abandoned) logger.error(`${text}. Giving up.`);
    else logger.warn(text);
    return { giveaway: next, winners: pending.winners || [], announced: false, pending: !abandoned };
}

// Shows a saved result: the giveaway message becomes "ended" and the winners
// are announced. Runs under the giveaway lock. `located` is a lookup the
// caller already did.
async function deliverGiveawayResult(client, guild, giveaway, located = null) {
    const guildId = guild?.id;
    const pending = giveaway.resultPending;
    const reroll = pending.kind === 'reroll';
    const winners = pending.winners || [];
    const closeSilently = async () => {
        // A giveaway message someone removed is closed silently: nobody is
        // tagged for a giveaway that is no longer visible.
        const closed = { ...withoutPendingResult(giveaway), ...(reroll ? { claimDeadlineAt: null } : {}) };
        await persist(client, guildId, closed);
        return { giveaway: closed, winners, announced: false };
    };
    const found = located || await locateGiveawayMessage(client, guild, giveaway.channelId, giveaway.messageId);
    if (found.status === 'gone') return closeSilently();
    if (found.status === 'unavailable') return deferGiveawayResult(client, guildId, giveaway, found.error);
    const { channel, message } = found;
    try {
        await message.edit(giveawayMessagePayload(giveaway, reroll ? 'reroll' : 'ended'));
    } catch (error) {
        if (isGone(error)) return closeSilently();
        return deferGiveawayResult(client, guildId, giveaway, error);
    }
    // The announcement is sent at most once: that it is being sent is saved
    // first, so an answer lost after Discord accepted it never tags the
    // winners a second time.
    const shown = withoutPendingResult(giveaway);
    await persist(client, guildId, shown);
    // An automatic reroll without anyone left to draw has nothing to announce.
    if (!reroll || winners.length) {
        let announcement;
        try {
            announcement = await channel.send({
                ...createWinnerAnnouncement(shown, winners, { reroll }),
                reply: { messageReference: giveaway.messageId, failIfNotExists: false },
            });
        } catch (error) {
            // Discord refused it, so it was certainly not posted: try again.
            if (wasRejected(error)) return deferGiveawayResult(client, guildId, giveaway, error);
            throw error;
        }
        shown.announcementIds = [...(shown.announcementIds || []), announcement.id];
        shown.winnerPingMessageId = announcement.id;
        // Old giveaways have no claim deadline and are never retroactively
        // rerolled. The 24h claim window starts when winners are announced.
        if (winners.length) shown.claimDeadlineAt = newClaimDeadline();
        await persist(client, guildId, shown);
    }
    return { giveaway: shown, winners, announced: true };
}

async function rememberEndedLog(client, guildId, messageId) {
    await Mutex.runExclusive(lockKey(messageId), async () => {
        const current = await loadGiveaway(client, guildId, messageId);
        if (current && !current.endedLogSent) await persist(client, guildId, { ...current, endedLogSent: true });
    }).catch(error => logger.warn(`Could not note the ended log of giveaway ${messageId}: ${error?.message || error}`));
}

// "Giveaway ended" is logged once, also when the result is only shown later.
async function logEndedGiveaway(client, guild, result) {
    if (!result.giveaway.endedLogSent) {
        await sendGiveawayEndedLog(client, guild, result.giveaway, result.winners);
        if (result.pending) await rememberEndedLog(client, guild?.id, result.giveaway.messageId);
    }
    if (result.announced) await sendGiveawayWinnerCountryLog(client, guild, result.giveaway, result.winners);
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
            resultPending: pendingResult('ended', winners),
        };
        await persist(client, guildId, ended);
        return deliverGiveawayResult(client, guild, ended);
    });
    // Ended log in #giveaway-logs; for a giveaway without a code also the
    // winners' countries (Owners tagged).
    await logEndedGiveaway(client, guild, result);
    return result;
}

// Shows the saved result of an ended giveaway that could not be shown yet
// (Discord was unavailable, or Cloudy restarted at that moment).
export async function resumeGiveawayResult(client, guild, messageId) {
    const guildId = guild?.id;
    const result = await Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await loadGiveaway(client, guildId, messageId);
        if (!giveaway?.resultPending || !isGiveawayFinished(giveaway)) return null;
        const { kind } = giveaway.resultPending;
        return { ...await deliverGiveawayResult(client, guild, giveaway), kind };
    });
    if (!result) return null;
    if (result.kind === 'ended') await logEndedGiveaway(client, guild, result);
    else if (result.announced) await sendGiveawayWinnerCountryLog(client, guild, result.giveaway, result.winners);
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
        if (giveaway.resultPending) {
            throw giveawayError('Giveaway result pending', 'The winners of this giveaway are still being announced. Please try again in a minute.');
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
        // Looked up before anyone is drawn: a reroll that cannot be announced
        // never uses up a winner.
        const located = await locateGiveawayMessage(client, guild, giveaway.channelId, messageId);
        if (located.status === 'gone') {
            throw giveawayError('Giveaway message missing', 'The giveaway message no longer exists, so no new winner was announced.');
        }
        if (located.status === 'unavailable') {
            throw giveawayError('Giveaway message unavailable', 'Discord could not be reached, so no new winner was drawn. Please try again.');
        }
        const winners = selectWinners(pool, giveaway.winnerCount || 1);
        const rerolled = {
            ...giveaway,
            winnerIds: winners,
            previousWinnerIds: previousWinners,
            rerolledAt: new Date().toISOString(),
            rerolledBy,
            resultPending: pendingResult('reroll', winners),
        };
        await persist(client, guildId, rerolled);
        return deliverGiveawayResult(client, guild, rerolled, located);
    });
    await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_REROLL, 'Giveaway rerolled', result.giveaway,
        [{ name: 'New winners', value: result.winners.map(id => `<@${id}>`).join(', '), inline: false }], rerolledBy);
    if (result.announced) await sendGiveawayWinnerCountryLog(client, guild, result.giveaway, result.winners);
    return result;
}

// Update obsolete default copy and the Claim button emoji on existing winner
// announcements. Preserve message IDs, mentions, button IDs/styles/disabled
// state, thumbnail, footer and any owner-authored claim instructions.
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
                        const outdated = [LEGACY_GIVEAWAY_CLAIM, PREVIOUS_GIVEAWAY_CLAIM, FORMER_GIVEAWAY_CLAIM]
                            .find(text => description.includes(text));
                        const updatedDescription = (outdated
                            ? description.replace(outdated, DEFAULT_GIVEAWAY_CLAIM)
                            : description
                        ).replace(LEGACY_GIVEAWAY_FAILURE, DEFAULT_GIVEAWAY_FAILURE);
                        if (updatedDescription === description) return data;
                        changed = true;
                        return { ...data, description: updatedDescription };
                    });
                    // Change only the emoji on this giveaway's Claim button.
                    // Discord controls the rendered size; retain custom ID,
                    // style, disabled state, layout and every other button.
                    let changedEmoji = false;
                    const components = (message.components || []).map(row => {
                        const data = row.toJSON?.() || row;
                        if (!Array.isArray(data?.components)) return data;
                        let rowChanged = false;
                        const buttons = data.components.map(component => {
                            const button = component.toJSON?.() || component;
                            if (button.custom_id !== `gclaim:open:${giveaway.messageId}`
                                || button.emoji?.id === GIVEAWAY_CLAIM_BUTTON_EMOJI.id) return button;
                            rowChanged = true;
                            changedEmoji = true;
                            return { ...button, emoji: { ...GIVEAWAY_CLAIM_BUTTON_EMOJI } };
                        });
                        return rowChanged ? { ...data, components: buttons } : data;
                    });
                    if (changed || changedEmoji) {
                        await message.edit({
                            ...(changed ? { embeds } : {}),
                            ...(changedEmoji ? { components } : {}),
                        });
                    }
                } catch (error) {
                    logger.warn(`Could not refresh claim instructions in announcement ${id}:`, error);
                }
            }
        }
    }
}

// Keep the ended-giveaway sentence immediately above the end date.
// Adjust only that line to bold singular/plural (or the no-winner case),
// preserving everything else in the already-posted message.
export function reorderEndedGiveawayDescription(description, winners = []) {
    if (typeof description !== 'string') return description;
    const newCopy = endedGiveawayWinnerMessage(winners);
    const oldLine = /(?:This giveaway has ended!|\*{0,2}The winner\(s\) have been announced and tagged(?: below)?!\*{0,2}|\*{0,2}The winners? ha(?:s|ve) been announced and tagged!\*{0,2}|\*{0,2}No winners were announced or tagged\.\*{0,2})/;
    const dateLine = '[^\\n]*\\*\\*Giveaway ended\\*\\*\\n<t:\\d+:F>';
    const oldAfterDate = new RegExp('\\n\\n(' + dateLine + ')\\n\\n' + oldLine.source + '$');
    const oldBeforeDate = new RegExp('\\n\\n' + oldLine.source + '(?=\\n\\n' + dateLine + '$)');
    const reordered = description.replace(oldAfterDate,
        (_, endedTimeBlock) => '\n\n' + newCopy + '\n\n' + endedTimeBlock);
    return reordered.replace(oldBeforeDate, '\n\n' + newCopy);
}

// Correct already-posted ended giveaways in place. Do not repost, ping
// members, change embeds' other fields or edit already-correct copy.
export async function refreshEndedGiveawayClosingCopy(client) {
    if (!client?.db?.get || !client?.db?.set) return;
    const since = Date.now() - 30 * 24 * 60 * 60_000;
    for (const guild of client.guilds?.cache?.values?.() || []) {
        const marker = 'guild:' + guild.id + ':giveaway:ended-winner-copy-v4';
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
                        const reordered = reorderEndedGiveawayDescription(data.description, giveaway.winnerIds || []);
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
        if (!giveaway || !isGiveawayFinished(giveaway) || giveaway.resultPending
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

        const located = await locateGiveawayMessage(client, guild, giveaway.channelId, messageId);
        if (located.status === 'gone') {
            // Never announce a replacement for a giveaway removed in Discord.
            await persist(client, guildId, { ...giveaway, claimDeadlineAt: null });
            return null;
        }
        // Discord could not be asked right now: nothing is drawn and the
        // deadline stays, so the next minute's check simply tries again.
        if (located.status === 'unavailable') return null;

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
            resultPending: pendingResult('reroll', newWinners),
        };
        // Persist before changing Discord: no failed DB write may announce a
        // winner. The advanced deadline also prevents duplicate automatic
        // draws on subsequent sweeps or after restarting.
        await persist(client, guildId, rerolled);
        const delivered = await deliverGiveawayResult(client, guild, rerolled, located);
        return { giveaway: delivered.giveaway, claimed, missing, newWinners, complete: !newWinners.length,
            announced: delivered.announced, pending: delivered.pending === true };
    });
    if (result?.newWinners?.length) {
        await logGiveaway(client, guildId, EVENT_TYPES.GIVEAWAY_REROLL,
            'Unclaimed giveaway prizes automatically rerolled', result.giveaway, [
                { name: 'Unclaimed slots', value: String(result.missing.length), inline: true },
                { name: 'New winners', value: result.newWinners.map(id => `<@${id}>`).join(', '), inline: false },
            ]);
        if (result.announced) await sendGiveawayWinnerCountryLog(client, guild, result.giveaway, result.newWinners);
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

// Code: no code (members choose their country) or a code type Cloudy uses
// to generate each winner's code. Also allowed after the end, for winners
// who have not opened their claim yet. The Enter button changes with it.
export async function setGiveawayCode(client, guild, messageId, { codeType, codeDiscount = null, addedCodes = null }) {
    const guildId = guild?.id;
    if (!Object.hasOwn(GIVEAWAY_CODE_TYPES, codeType || '')) {
        throw giveawayError('Invalid giveaway code type', 'Choose a code.');
    }
    if (codeType === 'added' && !addedCodes?.length) {
        throw giveawayError('No added giveaway codes', 'Add at least one code in Existing codes.');
    }
    return Mutex.runExclusive(lockKey(messageId), async () => {
        const giveaway = await requireGiveaway(client, guildId, messageId);
        const updated = {
            ...giveaway,
            codeType,
            codeDiscount: codeType === 'discount' ? validDiscount(codeDiscount) || 10 : null,
            // Given-out codes stay with their winner; the unused ones are
            // replaced by the codes in the form.
            addedCodes: codeType === 'added' ? withAddedCodes(giveaway, addedCodes)
                : (giveaway.addedCodes || []).filter(entry => entry?.usedBy),
        };
        if (codeType !== 'added' && updated.codeType === giveaway.codeType
            && updated.codeDiscount === (giveaway.codeDiscount ?? null)) return giveaway;
        await persist(client, guildId, updated);
        if (!isGiveawayFinished(updated)) {
            const channel = await fetchGiveawayChannel(client, guild, updated.channelId);
            const message = await fetchGiveawayMessage(channel, messageId);
            if (message) await message.edit({ components: createGiveawayButtons(updated, { ended: false }) });
        }
        return updated;
    });
}

// Shows the current entry count on the giveaway itself (used when the
// member picked their country from a private list).
export async function refreshGiveawayMessage(client, guild, giveaway) {
    const channel = await fetchGiveawayChannel(client, guild, giveaway?.channelId);
    const message = await fetchGiveawayMessage(channel, giveaway?.messageId);
    if (message) await message.edit(activeGiveawayPayload(giveaway));
    return Boolean(message);
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

// Runs every minute: ends giveaways whose time is up, and shows the result
// of giveaways that ended while Discord or Cloudy was unavailable.
export async function checkGiveaways(client) {
    try {
        if (!client?.db) return;
        const justEnded = new Set();
        const due = await getEndedGiveaways(client);
        for (const record of due) {
            const guildId = record.guild_id || record.guildId;
            const messageId = record.message_id || record.messageId;
            const guild = client.guilds?.cache?.get?.(guildId);
            if (!guild || !messageId) continue;
            justEnded.add(messageId);
            try {
                await finishGiveaway(client, guild, messageId, { endedBy: 'automatic' });
                logger.info(`Ended giveaway ${messageId} in guild ${guildId}`);
            } catch (error) {
                if (error?.context?.status === 'already_ended') continue;
                logger.error(`Error ending giveaway ${messageId}:`, error);
            }
        }
        for (const record of await getGiveawaysAwaitingResult(client)) {
            const guildId = record.guild_id || record.guildId;
            const messageId = record.message_id || record.messageId;
            const guild = client.guilds?.cache?.get?.(guildId);
            // One attempt per minute: a giveaway that ended in this run waits for the next.
            if (!guild || !messageId || justEnded.has(messageId)) continue;
            try {
                const result = await resumeGiveawayResult(client, guild, messageId);
                if (result?.announced) logger.info(`Showed the saved result of giveaway ${messageId} in guild ${guildId}`);
            } catch (error) {
                logger.error(`Error showing the result of giveaway ${messageId}:`, error);
            }
        }
    } catch (error) {
        logger.error('Error checking giveaways:', error);
    }
}
