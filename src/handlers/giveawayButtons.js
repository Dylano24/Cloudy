import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import {
    DEFAULT_CLAIM_INTRODUCTION, DEFAULT_CLAIM_CONDITIONS, defaultClaimHowToGet, customClaimHowToGet,
    DEFAULT_CLAIM_REVIEW, defaultClaimPleaseNote, customClaimPleaseNote,
} from '../services/giveawayClaimPreview.js';
import { successEmbed, warningEmbed } from '../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../utils/embedColorPolicy.js';
import { logger } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errorHandler.js';
import {
    createDeleteConfirmation,
    createGiveawayManagePanel,
    createParticipantsList,
    DEFAULT_GIVEAWAY_DESCRIPTION,
    isUserRateLimited,
    parseDuration,
    participantsEmoji,
    recordUserInteraction,
} from '../services/giveawayService.js';
import {
    activeGiveawayPayload,
    canManageGiveawaysAsOwner,
    enterGiveaway,
    finishGiveaway,
    leaveGiveaway,
    loadGiveaway,
    removeGiveaway,
    refreshGiveawayMessage,
    rerollGiveaway,
    setGiveawayCode,
    setGiveawayTimer,
    setGiveawayText,
} from '../services/giveawayActions.js';
import {
    giveawayCodeModal, giveawayCountryModal, giveawayCountryPicker, readGiveawayCodeModal,
    readGiveawayCountryModal, readGiveawayCountryPick,
} from '../services/giveawayCodeService.js';

const EPHEMERAL = MessageFlags.Ephemeral;

// Giveaway warnings have a red side line (owner's choice), never yellow.
export function giveawayWarning(text) {
    return setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR);
}

// Every short notice (Success/Warning) disappears after exactly 10 seconds.
export const NOTICE_LIFETIME_MS = 10_000;

// Removes the private reply (or the given follow-up) after 10 seconds.
export function removeAfterTenSeconds(interaction, message = null) {
    const timer = setTimeout(() => {
        void Promise.resolve()
            .then(() => (message ? interaction.deleteReply(message) : interaction.deleteReply()))
            // Already dismissed is fine; anything else is logged so a notice
            // that stays visible can be traced.
            .catch(error => {
                if (error?.code !== 10008) logger.warn(`Giveaway notice could not be removed: ${error?.message || error}`);
            });
    }, NOTICE_LIFETIME_MS);
    timer.unref?.();
}

async function notice(interaction, embed) {
    // A private "thinking…" reply is replaced by the notice, never left open.
    if (interaction.__giveawayPendingReply) {
        interaction.__giveawayPendingReply = false;
        await interaction.editReply({ embeds: [embed], components: [] });
        return removeAfterTenSeconds(interaction);
    }
    const payload = { embeds: [embed], flags: EPHEMERAL };
    if (interaction.replied || interaction.deferred) {
        // After an update of the giveaway itself, only this follow-up is
        // removed: never the giveaway message.
        const message = await interaction.followUp(payload);
        if (message?.id) removeAfterTenSeconds(interaction, message);
        return message;
    }
    await interaction.reply(payload);
    return removeAfterTenSeconds(interaction);
}

// The private Manage panel turns into a short Success notice.
async function panelDone(interaction, text) {
    await interaction.editReply(done(text));
    removeAfterTenSeconds(interaction);
}

// Every button is acknowledged before any database work, so a slow moment
// (e.g. right after a restart) never exceeds Discord's 3-second limit.
async function deferPrivate(interaction) {
    const deferred = interaction.deferReply({ flags: EPHEMERAL });
    interaction.__giveawayPendingReply = true;
    await deferred;
}
const warn = (interaction, text) => notice(interaction, giveawayWarning(text));
const done = (text) => ({ embeds: [successEmbed('Success', text)], components: [] });

async function onError(interaction, error, customId) {
    if (error?.userMessage && error?.context?.expected) {
        return notice(interaction, giveawayWarning(error.userMessage)).catch(() => {});
    }
    logger.error(`Error in giveaway button ${customId}:`, error);
    return handleInteractionError(interaction, error, { type: 'button', customId, handler: 'giveaway' });
}

async function changeEntry(interaction, client, enter, { country = null } = {}) {
    const customId = enter ? 'giveaway_enter' : 'giveaway_leave';
    try {
        if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
        if (isUserRateLimited(interaction.user.id, interaction.message.id)) {
            return warn(interaction, 'Please wait a moment before using this giveaway again.');
        }
        await recordUserInteraction(interaction.user.id, interaction.message.id);
        await interaction.deferUpdate();
        const result = enter
            ? await enterGiveaway(client, interaction.guildId, interaction.message.id, interaction.user.id, { country })
            : await leaveGiveaway(client, interaction.guildId, interaction.message.id, interaction.user.id);
        if (result.status === 'missing') return warn(interaction, 'This giveaway is no longer active.');
        if (result.status === 'ended') return warn(interaction, 'This giveaway has already ended.');
        if (result.status === 'already') return warn(interaction, 'You have already entered this giveaway.');
        if (result.status === 'not-entered') return warn(interaction, 'You have not entered this giveaway.');
        // Refresh the giveaway itself (entry count on the button), then confirm privately.
        await interaction.editReply(activeGiveawayPayload(result.giveaway, client));
        await notice(interaction, successEmbed('Success', enter
            ? 'You entered the giveaway.\n\nGood luck!'
            : 'You left the giveaway.'));
    } catch (error) {
        await onError(interaction, error, customId);
    }
}

// giveaway_enter:country (a giveaway without a code) first asks the
// member's country in a form; that is Discord's first answer.
export const giveawayEnterHandler = {
    customId: 'giveaway_enter',
    async execute(interaction, client, [mode] = []) {
        if (mode !== 'country') return changeEntry(interaction, client, true);
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            return await interaction.showModal(giveawayCountryModal(interaction.message.id));
        } catch (error) {
            return onError(interaction, error, 'giveaway_enter:country');
        }
    },
};

// The private country list closes after 5 minutes without a choice.
export const COUNTRY_PICKER_LIFETIME_MS = 5 * 60_000;

export const giveawayCountryModalHandler = {
    customId: 'giveaway_country',
    async execute(interaction, client) {
        let search;
        try {
            search = readGiveawayCountryModal(interaction);
        } catch (error) {
            return onError(interaction, error, 'giveaway_country');
        }
        // One match: entered at once, the entry count updates in place.
        if (search.matches.length === 1) return changeEntry(interaction, client, true, { country: search.matches[0] });
        try {
            await interaction.reply({ ...giveawayCountryPicker(interaction.message.id, search.query, search.matches), flags: EPHEMERAL });
            const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, COUNTRY_PICKER_LIFETIME_MS);
            timer.unref?.();
            return undefined;
        } catch (error) {
            return onError(interaction, error, 'giveaway_country');
        }
    },
};

// giveaway_country_pick:<giveaway message ID>, from the private country list.
export const giveawayCountryPickHandler = {
    customId: 'giveaway_country_pick',
    async execute(interaction, client, [messageId] = []) {
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            const country = readGiveawayCountryPick(interaction);
            await interaction.deferUpdate();
            const result = await enterGiveaway(client, interaction.guildId, messageId, interaction.user.id, { country });
            const answer = {
                missing: 'This giveaway is no longer active.',
                ended: 'This giveaway has already ended.',
                already: 'You have already entered this giveaway.',
            }[result.status];
            if (!answer) await refreshGiveawayMessage(client, interaction.guild, result.giveaway);
            // The list itself turns into the 10-second notice.
            await interaction.editReply({
                embeds: [answer ? giveawayWarning(answer) : successEmbed('Success', 'You entered the giveaway.\n\nGood luck!')],
                components: [],
            });
            return removeAfterTenSeconds(interaction);
        } catch (error) {
            return onError(interaction, error, 'giveaway_country_pick');
        }
    },
};

export const giveawayLeaveHandler = {
    customId: 'giveaway_leave',
    execute: (interaction, client) => changeEntry(interaction, client, false),
};

// Manage: staff-only controls, opened privately from the giveaway.
export async function openManagePanel(interaction, client, messageId = interaction.message?.id) {
    try {
        if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
        if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
            return warn(interaction, 'Only the Owner role can manage giveaways.');
        }
        await deferPrivate(interaction);
        const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
        if (!giveaway) return notice(interaction, giveawayWarning('This giveaway could not be found.'));
        return interaction.editReply(createGiveawayManagePanel(giveaway, { participantsIcon: participantsEmoji(client) }));
    } catch (error) {
        return onError(interaction, error, 'giveaway_manage');
    }
}

export const giveawayManageHandler = {
    customId: 'giveaway_manage',
    execute: (interaction, client) => openManagePanel(interaction, client),
};

export function giveawayTimerModal(messageId) {
    return new ModalBuilder()
        .setCustomId(`giveaway_timer:${messageId}`)
        .setTitle('Edit giveaway timer')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Ends in (from now)')
            .setPlaceholder('Example: 1m, 1h, 1d')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(10)));
}

// Same text fields as the creation builder, prefilled from the saved giveaway.
export function giveawayTextEditModal(messageId, giveaway) {
    const field = (name, label, style, value, maxLength, required = false) => {
        const input = new TextInputBuilder().setCustomId(name).setLabel(label)
            .setStyle(style).setRequired(required).setMaxLength(maxLength);
        if (value) input.setValue(String(value).slice(0, maxLength));
        return new ActionRowBuilder().addComponents(input);
    };
    return new ModalBuilder().setCustomId(`giveaway_text:${messageId}`)
        .setTitle('Edit giveaway text')
        .addComponents(
            field('introTitle', 'Introduction title', TextInputStyle.Short, giveaway.introTitle?.replace(/^Giveaway time !$/, 'Giveaway time!') || 'Giveaway time!', 150, true),
            field('description', 'Description', TextInputStyle.Paragraph, giveaway.description || DEFAULT_GIVEAWAY_DESCRIPTION, 1000),
            field('prize', 'Prize', TextInputStyle.Short, giveaway.prize, 256, true),
            field('requirements', 'Requirements', TextInputStyle.Paragraph, giveaway.requirements, 500),
            field('closingText', 'Closing message', TextInputStyle.Paragraph, giveaway.closingText || 'Good luck to everyone!', 300, true),
        );
}

export function giveawayClaimEditModal(messageId, giveaway) {
    const field = (id, label, value, maxLength) => {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label)
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(maxLength);
        if (value) input.setValue(String(value).slice(0, maxLength));
        return new ActionRowBuilder().addComponents(input);
    };
    return new ModalBuilder()
        .setCustomId(`giveaway_claim:${messageId}`)
        .setTitle('Edit winner claim instructions')
        .addComponents(
            field('claimIntroduction', 'Introduction', giveaway.claimIntroduction || DEFAULT_CLAIM_INTRODUCTION, 250),
            field('claimConditions', 'Prize conditions', giveaway.claimConditions || DEFAULT_CLAIM_CONDITIONS, 1000),
            field('claimHowToGet', 'How to get your prize', giveaway.claimHowToGet || defaultClaimHowToGet(giveaway), 500),
            field('claimReview', 'Share your feedback', giveaway.claimReview || DEFAULT_CLAIM_REVIEW, 1000),
            field('claimPleaseNote', 'Please note', giveaway.claimPleaseNote || defaultClaimPleaseNote(giveaway), 1000),
        );
}

// giveaway_admin:<action>:<giveaway message ID>, from the private Manage panel.
export const giveawayAdminHandler = {
    customId: 'giveaway_admin',
    async execute(interaction, client, [action, messageId] = []) {
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only the Owner role can manage giveaways.');
            }
            // A form must be the first answer, before any defer.
            if (action === 'timer') return interaction.showModal(giveawayTimerModal(messageId));
            if (action === 'code') {
                const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
                if (!giveaway) return warn(interaction, 'This giveaway no longer exists.');
                return interaction.showModal(giveawayCodeModal(`giveaway_code:${messageId}`, giveaway));
            }
            if (action === 'text' || action === 'claim') {
                const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
                if (!giveaway) return warn(interaction, 'This giveaway no longer exists.');
                if (giveaway.ended || giveaway.isEnded) return warn(interaction, 'This giveaway has already ended.');
                return interaction.showModal(action === 'text'
                    ? giveawayTextEditModal(messageId, giveaway)
                    : giveawayClaimEditModal(messageId, giveaway));
            }
            if (action === 'participants') {
                await deferPrivate(interaction);
                const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
                if (!giveaway) return notice(interaction, giveawayWarning('This giveaway no longer exists.'));
                // The participants list disappears after 10 seconds as well.
                await interaction.editReply(createParticipantsList(giveaway));
                return removeAfterTenSeconds(interaction);
            }

            await interaction.deferUpdate();
            const giveaway = await loadGiveaway(client, interaction.guildId, messageId);
            if (!giveaway) return panelDone(interaction, 'This giveaway no longer exists.');
            if (action === 'panel') return interaction.editReply(createGiveawayManagePanel(giveaway, { participantsIcon: participantsEmoji(client) }));
            if (action === 'delete') return interaction.editReply(createDeleteConfirmation(giveaway));
            if (action === 'end') {
                const { winners } = await finishGiveaway(client, interaction.guild, messageId, { endedBy: interaction.user.id });
                return panelDone(interaction, (winners.length
                    ? `The giveaway has ended. Winner${winners.length === 1 ? '' : 's'}: ${winners.map(id => `<@${id}>`).join(', ')}`
                    : 'The giveaway has ended. Nobody entered, so there is no winner.'));
            }
            if (action === 'reroll') {
                const { winners } = await rerollGiveaway(client, interaction.guild, messageId, { rerolledBy: interaction.user.id });
                return panelDone(interaction, `New winner${winners.length === 1 ? '' : 's'}: ${winners.map(id => `<@${id}>`).join(', ')}`);
            }
            if (action === 'confirmdelete') {
                await removeGiveaway(client, interaction.guild, messageId, { deletedBy: interaction.user });
                return panelDone(interaction, 'The giveaway was deleted.');
            }
            return panelDone(interaction, 'This option is no longer available.');
        } catch (error) {
            return onError(interaction, error, `giveaway_admin:${action}`);
        }
    },
};

// Edit timer form: the giveaway now ends this long from now.
export const giveawayTimerModalHandler = {
    customId: 'giveaway_timer',
    async execute(interaction, client, [messageId] = []) {
        try {
            if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only the Owner role can manage giveaways.');
            }
            const durationMs = parseDuration(interaction.fields.getTextInputValue('duration'));
            await deferPrivate(interaction);
            const updated = await setGiveawayTimer(client, interaction.guild, messageId, durationMs);
            const endsAt = Math.floor(updated.endsAt / 1000);
            return notice(interaction, successEmbed('Success', `The giveaway now ends <t:${endsAt}:F> (<t:${endsAt}:R>).`));
        } catch (error) {
            return onError(interaction, error, 'giveaway_timer');
        }
    },
};

export const giveawayCodeModalHandler = {
    customId: 'giveaway_code',
    async execute(interaction, client, [messageId] = []) {
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only the Owner role can manage giveaways.');
            }
            const choice = readGiveawayCodeModal(interaction);
            await deferPrivate(interaction);
            await setGiveawayCode(client, interaction.guild, messageId, choice);
            return notice(interaction, successEmbed('Success', choice.codeType === 'none'
                ? 'This giveaway has no code. Members give their country when they enter.'
                : choice.codeType === 'added'
                    ? 'The codes were saved. Each winner gets the next unused code when they claim.'
                    : 'Cloudy now generates a code for every winner of this giveaway.'));
        } catch (error) {
            return onError(interaction, error, 'giveaway_code');
        }
    },
};

export const giveawayTextModalHandler = {
    customId: 'giveaway_text',
    async execute(interaction, client, [messageId] = []) {
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only the Owner role can manage giveaways.');
            }
            const value = name => interaction.fields.getTextInputValue(name);
            await deferPrivate(interaction);
            await setGiveawayText(client, interaction.guild, messageId, {
                introTitle: value('introTitle'),
                description: value('description'),
                prize: value('prize'),
                requirements: value('requirements'),
                closingText: value('closingText'),
            });
            return notice(interaction, successEmbed('Success', 'The giveaway text was updated.'));
        } catch (error) {
            return onError(interaction, error, 'giveaway_text');
        }
    },
};

export const giveawayClaimModalHandler = {
    customId: 'giveaway_claim',
    async execute(interaction, client, [messageId] = []) {
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only the Owner role can manage giveaways.');
            }
            await deferPrivate(interaction);
            await setGiveawayText(client, interaction.guild, messageId, {
                claimIntroduction: interaction.fields.getTextInputValue('claimIntroduction'),
                claimConditions: interaction.fields.getTextInputValue('claimConditions'),
                claimHowToGet: customClaimHowToGet(interaction.fields.getTextInputValue('claimHowToGet')) ?? '',
                claimReview: interaction.fields.getTextInputValue('claimReview'),
                claimPleaseNote: customClaimPleaseNote(interaction.fields.getTextInputValue('claimPleaseNote')) ?? '',
            });
            return notice(interaction, successEmbed('Success', 'Winner claim instructions were updated.'));
        } catch (error) {
            return onError(interaction, error, 'giveaway_claim');
        }
    },
};

// Buttons on giveaways posted before the new layout keep working.
export const legacyGiveawayHandlers = [
    { customId: 'giveaway_join', execute: giveawayEnterHandler.execute },
    { customId: 'giveaway_end', execute: (interaction, client) => openManagePanel(interaction, client) },
    { customId: 'giveaway_reroll', execute: (interaction, client) => openManagePanel(interaction, client) },
    { customId: 'giveaway_view', execute: (interaction, client) => openManagePanel(interaction, client) },
];
