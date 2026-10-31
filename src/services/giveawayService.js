// giveawayService.js

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logger } from '../utils/logger.js';
import { CloudyError, ErrorTypes } from '../utils/errorHandler.js';
import { botConfig } from '../config/bot.js';
import { checkRateLimit, getRateLimitStatus } from '../utils/rateLimiter.js';

const GIVEAWAY_CONFIG = botConfig.giveaways || {};
const GIVEAWAY_INTERACTION_COOLDOWN = 1000;
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';

function getGiveawayInteractionKey(userId, giveawayId) {
    return `giveaway:${userId}:${giveawayId}`;
}

export function parseDuration(durationString) {
    if (!durationString || typeof durationString !== 'string') {
        throw new CloudyError(
            'Invalid duration format provided',
            ErrorTypes.VALIDATION,
            'Please provide a valid duration (e.g., 1h, 30m, 5d, 10s).',
            { durationString }
        );
    }

    const regex = /^(\d+)([hmds])$/i;
    const match = durationString.trim().match(regex);

    if (!match) {
        throw new CloudyError(
            `Invalid duration format: ${durationString}`,
            ErrorTypes.VALIDATION,
            'Invalid duration format. Use: 1h, 30m, 5d, 10s (min: 10s, max: 30d)',
            { input: durationString }
        );
    }

    const amount = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (amount <= 0 || amount > 999) {
        throw new CloudyError(
            `Duration amount out of range: ${amount}`,
            ErrorTypes.VALIDATION,
            'Duration amount must be between 1 and 999.',
            { amount, unit }
        );
    }

    let ms = 0;
    switch (unit) {
        case 's':
            ms = amount * 1000;
            break;
        case 'm':
            ms = amount * 60 * 1000;
            break;
        case 'h':
            ms = amount * 60 * 60 * 1000;
            break;
        case 'd':
            ms = amount * 24 * 60 * 60 * 1000;
            break;
        default:
            throw new CloudyError(
                `Unknown duration unit: ${unit}`,
                ErrorTypes.VALIDATION,
                'Please use s (seconds), m (minutes), h (hours), or d (days).',
                { unit }
            );
    }

    const maxDuration = GIVEAWAY_CONFIG.maximumDuration ?? 30 * 24 * 60 * 60 * 1000;
    if (ms > maxDuration) {
        throw new CloudyError(
            `Duration exceeds maximum: ${ms}ms > ${maxDuration}ms`,
            ErrorTypes.VALIDATION,
            `Maximum duration is ${Math.floor(maxDuration / (24 * 60 * 60 * 1000))} days.`,
            { requestedMs: ms, maxMs: maxDuration }
        );
    }

    const minDuration = GIVEAWAY_CONFIG.minimumDuration ?? 10 * 1000;
    if (ms < minDuration) {
        throw new CloudyError(
            `Duration below minimum: ${ms}ms < ${minDuration}ms`,
            ErrorTypes.VALIDATION,
            `Minimum duration is ${Math.ceil(minDuration / 1000)} seconds.`,
            { requestedMs: ms, minMs: minDuration }
        );
    }

    return ms;
}

export function validatePrize(prize) {
    if (!prize || typeof prize !== 'string') {
        throw new CloudyError(
            'Prize must be a non-empty string',
            ErrorTypes.VALIDATION,
            'Please provide a valid prize description.',
            { prize }
        );
    }

    const trimmed = prize.trim();
    if (trimmed.length === 0 || trimmed.length > 256) {
        throw new CloudyError(
            `Prize length out of range: ${trimmed.length}`,
            ErrorTypes.VALIDATION,
            'Prize must be between 1 and 256 characters.',
            { length: trimmed.length }
        );
    }

    return trimmed;
}

export function validateWinnerCount(winnerCount) {
    const minimumWinners = GIVEAWAY_CONFIG.minimumWinners ?? 1;
    const maximumWinners = GIVEAWAY_CONFIG.maximumWinners ?? 10;

    if (!Number.isInteger(winnerCount) || winnerCount < minimumWinners || winnerCount > maximumWinners) {
        throw new CloudyError(
            `Invalid winner count: ${winnerCount}`,
            ErrorTypes.VALIDATION,
            `Winner count must be between ${minimumWinners} and ${maximumWinners}.`,
            { winnerCount, minimumWinners, maximumWinners }
        );
    }
}

// Owner's layout. Custom emojis only render in the description, so the whole
// giveaway text lives there.
export const GIVEAWAY_EMOJIS = Object.freeze({
    gift: '<a:W89gift:1557507008284987442>',
    prize: '<:W89zgiveway:1557507484812312727>',
    timer: '<a:W89timer:1557506643372146778>',
    enter: Object.freeze({ id: '1543303914152001536', name: 'W90250885giveaway' }),
    leave: Object.freeze({ id: '1565742837453029516', name: 'arrow_pointing_right', animated: true }),
});
export const DEFAULT_GIVEAWAY_DESCRIPTION = 'Cloudy Inc. is giving you the chance to win something special!';
export const DEFAULT_ENDED_GIVEAWAY_DESCRIPTION = 'Thank you to everyone who participated!';
export const DEFAULT_GIVEAWAY_INTRO = 'Giveaway time !';
export const DEFAULT_GIVEAWAY_CLOSING = 'Good luck to everyone!';
export const DEFAULT_GIVEAWAY_CLAIM = 'Please open a support ticket within 24 hours to claim your prize.';
export const DEFAULT_GIVEAWAY_FAILURE = 'Failure to claim your prize within this timeframe will result in a reroll, and a new winner will be selected.';
const GIVEAWAY_WHITE = 0xFFFFFF;

const unix = ms => Math.floor(Number(ms) / 1000);
const mentionList = ids => ids.map(id => `<@${id}>`).join(', ');

export function giveawayEndTime(giveaway) {
    return Number(giveaway?.endsAt || giveaway?.endTime) || 0;
}

export function giveawayParticipants(giveaway) {
    return [...new Set(Array.isArray(giveaway?.participants) ? giveaway.participants : [])];
}

export function isGiveawayFinished(giveaway) {
    return giveaway?.ended === true || giveaway?.isEnded === true;
}

// Slash command text cannot hold line breaks; "\n" in the text starts a new line.
export function giveawayText(value, maxLength) {
    const text = String(value ?? '').replace(/\\n/g, '\n').trim();
    return text ? text.slice(0, maxLength) : null;
}

export function createGiveawayEmbed(giveaway, status = 'active', winners = giveaway?.winnerIds || []) {
    const ended = status !== 'active';
    const winnerCount = Number(giveaway.winnerCount) || 1;
    const endsAt = giveawayEndTime(giveaway);
    const endedAt = Date.parse(giveaway.endedAt) || endsAt || Date.now();
    const lines = [
        `${GIVEAWAY_EMOJIS.gift} **${ended ? 'Giveaway ended!' : (giveaway.introTitle || DEFAULT_GIVEAWAY_INTRO)}**`,
        '',
        ended ? DEFAULT_ENDED_GIVEAWAY_DESCRIPTION : (giveaway.description || DEFAULT_GIVEAWAY_DESCRIPTION),
        '',
        `${GIVEAWAY_EMOJIS.prize} **${giveaway.prize || 'Mystery prize'}**`,
        '',
        '**Hosted by**',
        giveaway.hostId ? `<@${giveaway.hostId}>` : 'Not specified',
        '',
        '**Requirements**',
        giveaway.requirements || 'None',
        '',
        '**Winners**',
        ended
            ? (winners.length ? mentionList(winners) : 'No valid entries')
            : `${winnerCount} ${winnerCount === 1 ? 'winner' : 'winners'}`,
        '',
        `${GIVEAWAY_EMOJIS.timer} **${ended ? 'Giveaway ended' : 'Giveaway ends'}**`,
        ended ? `<t:${unix(endedAt)}:F>` : `<t:${unix(endsAt)}:F> (<t:${unix(endsAt)}:R>)`,
        '',
        ended ? 'The winner(s) have been announced and tagged below!' : `**${giveaway.closingText || DEFAULT_GIVEAWAY_CLOSING}**`,
    ];
    return {
        description: lines.join('\n').slice(0, 4096),
        // Always a white side line, also once ended (owner's choice).
        color: GIVEAWAY_WHITE,
        thumbnail: { url: CLOUDY_C_LOGO_URL },
    };
}

// Only participant buttons are public. Discord components cannot be made
// visible to only one role; owners manage with /giveaway manage (private panel).
export function createGiveawayButtons(giveaway, { ended = isGiveawayFinished(giveaway) } = {}) {
    const entry = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('giveaway_enter')
            .setEmoji(GIVEAWAY_EMOJIS.enter)
            .setLabel(`Enter giveaway (${giveawayParticipants(giveaway).length})`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(ended),
    );
    if (!ended) {
        entry.addComponents(new ButtonBuilder()
            .setCustomId('giveaway_leave')
            .setEmoji(GIVEAWAY_EMOJIS.leave)
            .setLabel('Leave giveaway')
            .setStyle(ButtonStyle.Secondary));
    }
    return [entry];
}

// Staff-only controls, shown privately.
// The owner's white person emoji, found by name in Cloudy's servers; 👤 when missing.
export const PARTICIPANTS_EMOJI_NAME = 'W881241476043907403887';
export const MANAGE_EMOJI_NAME = 'W94setting2';
// A custom emoji from Cloudy's servers, found by name (no ID needed).
export function customEmoji(client, name, fallback = null) {
    const emoji = client?.emojis?.cache?.find?.(entry => entry?.name === name);
    return emoji?.id ? { id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) } : fallback;
}
export function participantsEmoji(client) {
    return customEmoji(client, PARTICIPANTS_EMOJI_NAME, '👤');
}

export function createGiveawayManagePanel(giveaway, { participantsIcon = '👤' } = {}) {
    const ended = isGiveawayFinished(giveaway);
    const count = giveawayParticipants(giveaway).length;
    const id = giveaway.messageId;
    const button = (action, label, style) => {
        const built = new ButtonBuilder().setCustomId(`giveaway_admin:${action}:${id}`).setLabel(label).setStyle(style);
        if (action === 'participants') return built.setEmoji(participantsIcon);
        return action === 'reroll' ? built.setEmoji('🎲') : built;
    };
    const rows = ended
        ? [
            new ActionRowBuilder().addComponents(
                button('reroll', 'Reroll', ButtonStyle.Secondary),
                button('participants', 'View participants', ButtonStyle.Primary),
                button('delete', 'Delete', ButtonStyle.Danger)),
        ]
        : [
            new ActionRowBuilder().addComponents(
                button('reroll', 'Reroll', ButtonStyle.Secondary),
                button('text', 'Edit text', ButtonStyle.Secondary),
                button('timer', 'Edit timer', ButtonStyle.Secondary)),
            new ActionRowBuilder().addComponents(
                button('end', 'End', ButtonStyle.Danger),
                button('participants', 'View participants', ButtonStyle.Primary),
                button('delete', 'Delete', ButtonStyle.Danger)),
            new ActionRowBuilder().addComponents(
                button('claim', 'Edit claim', ButtonStyle.Secondary)),
        ];
    const endsAt = giveawayEndTime(giveaway);
    return {
        embeds: [{
            title: 'Manage giveaway',
            description: [
                `**${giveaway.prize || 'Giveaway'}**`,
                `${count} ${count === 1 ? 'participant' : 'participants'}`,
                ended ? 'This giveaway has ended.' : `Ends <t:${unix(endsAt)}:F> (<t:${unix(endsAt)}:R>)`,
            ].join('\n'),
            color: GIVEAWAY_WHITE,
            thumbnail: { url: CLOUDY_C_LOGO_URL },
        }],
        components: rows,
    };
}

export function createDeleteConfirmation(giveaway) {
    return {
        embeds: [{
            title: 'Delete giveaway?',
            description: `The giveaway for **${giveaway.prize || 'this prize'}** and its message will be removed. This cannot be undone.`,
            color: GIVEAWAY_WHITE,
            thumbnail: { url: CLOUDY_C_LOGO_URL },
        }],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`giveaway_admin:confirmdelete:${giveaway.messageId}`).setLabel('Delete giveaway').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`giveaway_admin:panel:${giveaway.messageId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
    };
}

export function createParticipantsList(giveaway) {
    const participants = giveawayParticipants(giveaway);
    const lines = [];
    let length = 0;
    for (const [index, id] of participants.entries()) {
        const line = `${index + 1}. <@${id}>`;
        if (length + line.length + 40 > 4000) {
            lines.push(`…and ${participants.length - index} more`);
            break;
        }
        lines.push(line);
        length += line.length + 1;
    }
    return {
        embeds: [{
            title: `Participants (${participants.length})`,
            description: lines.length ? lines.join('\n') : 'Nobody has entered this giveaway yet.',
            color: GIVEAWAY_WHITE,
        }],
        allowedMentions: { parse: [] },
    };
}

// Posted in the giveaway channel when winners are drawn: tags the winners and
// tells them how to claim their prize.
export function createWinnerAnnouncement(giveaway, winners, { reroll = false } = {}) {
    if (!winners.length) {
        return {
            embeds: [{
                description: [
                    `${GIVEAWAY_EMOJIS.gift} **Giveaway ended**`,
                    `Nobody entered the giveaway for **${giveaway.prize || 'this prize'}**, so there is no winner.`,
                ].join('\n'),
                color: GIVEAWAY_WHITE,
                thumbnail: { url: CLOUDY_C_LOGO_URL },
            }],
            allowedMentions: { parse: [] },
        };
    }
    const tags = mentionList(winners);
    return {
        content: winners.map(id => `<@${id}>`).join(' '),
        embeds: [{
            description: [
                `🎁 **${reroll ? 'New winner!' : 'Congratulations!'}**`,
                `${tags} ${winners.length === 1 ? 'has' : 'have'} won **${giveaway.prize || 'the giveaway'}**!`,
                '',
                giveaway.claim || DEFAULT_GIVEAWAY_CLAIM,
                '',
                DEFAULT_GIVEAWAY_FAILURE,
            ].join('\n'),
            color: GIVEAWAY_WHITE,
            thumbnail: { url: CLOUDY_C_LOGO_URL },
        }],
        allowedMentions: { parse: [], users: winners },
    };
}

// The role (or @everyone) tagged above a new giveaway.
export function giveawayPing(role, guildId) {
    if (!role?.id) return { content: undefined, allowedMentions: { parse: [] } };
    if (role.id === guildId) return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
    return { content: `<@&${role.id}>`, allowedMentions: { parse: [], roles: [role.id] } };
}

export function selectWinners(participants, winnerCount) {
    if (!Array.isArray(participants) || participants.length === 0) {
        return [];
    }

    const uniqueParticipants = [...new Set(participants)];

    if (!Number.isInteger(winnerCount) || winnerCount < 1) {
        throw new CloudyError(
            'Invalid winner count for selection',
            ErrorTypes.VALIDATION,
            'Winner count must be at least 1.',
            { winnerCount }
        );
    }

    const requested = Math.min(winnerCount, uniqueParticipants.length);
    
    try {
        
        const shuffled = [...uniqueParticipants];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, requested);
    } catch (error) {
        logger.error('Error selecting winners:', error);
        throw new CloudyError(
            'Failed to select winners',
            ErrorTypes.UNKNOWN,
            'An error occurred while selecting winners.',
            { error: error.message, participantCount: participants.length }
        );
    }
}

export function isUserRateLimited(userId, giveawayId) {
    const status = getRateLimitStatus(
        getGiveawayInteractionKey(userId, giveawayId),
        GIVEAWAY_INTERACTION_COOLDOWN,
    );
    return status.attempts >= 1 && status.remaining > 0;
}

export async function recordUserInteraction(userId, giveawayId) {
    await checkRateLimit(
        getGiveawayInteractionKey(userId, giveawayId),
        1,
        GIVEAWAY_INTERACTION_COOLDOWN,
    );
}

export async function endGiveaway(client, giveaway, guildId, endedBy) {
    try {
        if (!giveaway) {
            throw new CloudyError(
                'Giveaway object is null or undefined',
                ErrorTypes.VALIDATION,
                'Cannot end a non-existent giveaway.',
                { giveaway }
            );
        }

        if (giveaway.ended === true || giveaway.isEnded === true) {
            throw new CloudyError(
                `Giveaway ${giveaway.messageId} is already ended`,
                ErrorTypes.VALIDATION,
                'This giveaway has already ended.',
                { giveawayId: giveaway.messageId, status: 'already_ended' }
            );
        }

        const participants = giveaway.participants || [];
        const winners = selectWinners(participants, giveaway.winnerCount || 1);

        const updatedGiveaway = {
            ...giveaway,
            ended: true,
            isEnded: true,
            winnerIds: winners,
            endedAt: new Date().toISOString(),
            endedBy: endedBy,
            participantCount: participants.length
        };

        logger.info(`Ending giveaway ${giveaway.messageId}: selected ${winners.length} winners from ${participants.length} entries`);

        return {
            giveaway: updatedGiveaway,
            winners: winners,
            participantCount: participants.length
        };
    } catch (error) {
        if (error instanceof CloudyError) {
            logger.debug(`Giveaway end validation error: ${error.message}`, error.context || {});
            throw error;
        }
        logger.error('Error ending giveaway:', error);
        throw new CloudyError(
            'Failed to end giveaway',
            ErrorTypes.UNKNOWN,
            'An error occurred while ending the giveaway.',
            { error: error.message, giveawayId: giveaway?.messageId }
        );
    }
}
