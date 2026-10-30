import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { successEmbed, warningEmbed } from '../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../utils/embedColorPolicy.js';
import { logger } from '../utils/logger.js';
import { handleInteractionError } from '../utils/errorHandler.js';
import {
    createDeleteConfirmation,
    createGiveawayManagePanel,
    createParticipantsList,
    isUserRateLimited,
    parseDuration,
    participantsEmoji,
    recordUserInteraction,
} from '../services/giveawayService.js';
import {
    activeGiveawayPayload,
    canManageGiveaways,
    enterGiveaway,
    finishGiveaway,
    leaveGiveaway,
    loadGiveaway,
    removeGiveaway,
    rerollGiveaway,
    setGiveawayTimer,
} from '../services/giveawayActions.js';

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

async function changeEntry(interaction, client, enter) {
    const customId = enter ? 'giveaway_enter' : 'giveaway_leave';
    try {
        if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
        if (isUserRateLimited(interaction.user.id, interaction.message.id)) {
            return warn(interaction, 'Please wait a moment before using this giveaway again.');
        }
        await recordUserInteraction(interaction.user.id, interaction.message.id);
        await interaction.deferUpdate();
        const action = enter ? enterGiveaway : leaveGiveaway;
        const result = await action(client, interaction.guildId, interaction.message.id, interaction.user.id);
        if (result.status === 'missing') return warn(interaction, 'This giveaway is no longer active.');
        if (result.status === 'ended') return warn(interaction, 'This giveaway has already ended.');
        if (result.status === 'already') return warn(interaction, 'You have already entered this giveaway.');
        if (result.status === 'not-entered') return warn(interaction, 'You have not entered this giveaway.');
        // Refresh the giveaway itself (entry count on the button), then confirm privately.
        await interaction.editReply(activeGiveawayPayload(result.giveaway, client));
        await notice(interaction, successEmbed('Success', enter
            ? 'You entered the giveaway. Good luck!'
            : 'You left the giveaway.'));
    } catch (error) {
        await onError(interaction, error, customId);
    }
}

export const giveawayEnterHandler = {
    customId: 'giveaway_enter',
    execute: (interaction, client) => changeEntry(interaction, client, true),
};

export const giveawayLeaveHandler = {
    customId: 'giveaway_leave',
    execute: (interaction, client) => changeEntry(interaction, client, false),
};

// Manage: staff-only controls, opened privately from the giveaway.
export async function openManagePanel(interaction, client, messageId = interaction.message?.id) {
    try {
        if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
        if (!canManageGiveaways(interaction.member, interaction.guild)) {
            return warn(interaction, 'Only staff can manage giveaways.');
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

// giveaway_admin:<action>:<giveaway message ID>, from the private Manage panel.
export const giveawayAdminHandler = {
    customId: 'giveaway_admin',
    async execute(interaction, client, [action, messageId] = []) {
        try {
            if (!interaction.inGuild()) return warn(interaction, 'Giveaways only work in a server.');
            if (!canManageGiveaways(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only staff can manage giveaways.');
            }
            // A form must be the first answer, so Edit timer opens it at once.
            if (action === 'timer') return interaction.showModal(giveawayTimerModal(messageId));
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
            if (!canManageGiveaways(interaction.member, interaction.guild)) {
                return warn(interaction, 'Only staff can manage giveaways.');
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

// Buttons on giveaways posted before the new layout keep working.
export const legacyGiveawayHandlers = [
    { customId: 'giveaway_join', execute: giveawayEnterHandler.execute },
    { customId: 'giveaway_end', execute: (interaction, client) => openManagePanel(interaction, client) },
    { customId: 'giveaway_reroll', execute: (interaction, client) => openManagePanel(interaction, client) },
    { customId: 'giveaway_view', execute: (interaction, client) => openManagePanel(interaction, client) },
];
