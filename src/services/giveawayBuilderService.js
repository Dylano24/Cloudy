import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags,
    ModalBuilder,
    RoleSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { successEmbed } from '../utils/embeds.js';
import { giveawayWarning, removeAfterTenSeconds } from '../handlers/giveawayButtons.js';
import { logger } from '../utils/logger.js';
import { botConfig } from '../config/bot.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import {
    createGiveawayEmbed,
    DEFAULT_GIVEAWAY_CLAIM,
    giveawayText,
    parseDuration,
    validateWinnerCount,
} from './giveawayService.js';
import { canManageGiveaways, postGiveaway } from './giveawayActions.js';

// The Giveaway Builder: like the Embed Builder, a private live preview with
// controls. /gcreate opens it; nothing is posted until "Post giveaway".
export const GIVEAWAY_BUILDER_PREFIX = 'gbuilder:';
const IDLE_MS = 30 * 60_000;
const MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;
const sessions = new Map();

function closeSession(session, removeMessage = true) {
    clearTimeout(session.timer);
    sessions.delete(session.id);
    if (removeMessage) void session.root.deleteReply?.().catch(() => {});
}

function keepAlive(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => closeSession(session), IDLE_MS);
    session.timer.unref?.();
}

export function newGiveawayDraft(channelId) {
    return {
        prize: '',
        description: null,
        requirements: null,
        claim: null,
        durationText: '1d',
        durationMs: 86_400_000,
        winnerCount: 1,
        channelId: channelId || null,
        ping: { type: 'none', roleId: null },
    };
}

function pingLabel(ping) {
    if (ping.type === 'everyone') return '@everyone';
    if (ping.type === 'role' && ping.roleId) return `<@&${ping.roleId}>`;
    return 'Nobody';
}

const id = (session, action) => `${GIVEAWAY_BUILDER_PREFIX}${action}:${session.id}`;

export function renderGiveawayBuilder(session) {
    const { draft } = session;
    const preview = createGiveawayEmbed({
        ...draft,
        prize: draft.prize || 'Your prize',
        endsAt: Date.now() + draft.durationMs,
        participants: [],
    }, 'active');
    const settings = {
        title: 'Giveaway builder',
        description: draft.prize
            ? 'The giveaway above is a preview. Change it with the controls below, then press **Post giveaway**.'
            : 'Start with **Edit text** to set the prize. The giveaway above is a preview.',
        fields: [
            { name: 'Channel', value: draft.channelId ? `<#${draft.channelId}>` : 'Not chosen', inline: true },
            { name: 'Tag', value: pingLabel(draft.ping), inline: true },
            { name: 'Duration', value: draft.durationText, inline: true },
            { name: 'Winners', value: String(draft.winnerCount), inline: true },
            { name: 'How winners claim the prize', value: draft.claim || DEFAULT_GIVEAWAY_CLAIM, inline: false },
        ],
        color: 0xFFFFFF,
    };

    const channel = new ChannelSelectMenuBuilder()
        .setCustomId(id(session, 'channel'))
        .setPlaceholder('Giveaway channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1);
    if (draft.channelId) channel.setDefaultChannels(draft.channelId);
    const role = new RoleSelectMenuBuilder()
        .setCustomId(id(session, 'role'))
        .setPlaceholder('Tag a role')
        .setMinValues(0)
        .setMaxValues(1);
    if (draft.ping.type === 'role' && draft.ping.roleId) role.setDefaultRoles(draft.ping.roleId);

    return {
        embeds: [preview, settings],
        components: [
            new ActionRowBuilder().addComponents(channel),
            new ActionRowBuilder().addComponents(role),
            // Owner's layout: all grey except the green Post giveaway, which
            // sits next to Tag @everyone; Cancel alone at the bottom left.
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id(session, 'text')).setLabel('Edit text').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(id(session, 'timing')).setLabel('Duration & winners').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id(session, 'everyone'))
                    .setLabel(draft.ping.type === 'everyone' ? 'Untag @everyone' : 'Tag @everyone')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(id(session, 'post')).setLabel('Post giveaway')
                    .setStyle(ButtonStyle.Success).setDisabled(!draft.prize || !draft.channelId),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id(session, 'cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function textInput(customId, label, style, { value, placeholder, required = false, maxLength }) {
    const input = new TextInputBuilder().setCustomId(customId).setLabel(label).setStyle(style)
        .setRequired(required).setMaxLength(maxLength);
    if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
    if (value) input.setValue(String(value).slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
}

export function giveawayTextModal(session) {
    const { draft } = session;
    return new ModalBuilder()
        .setCustomId(id(session, 'textform'))
        .setTitle('Giveaway text')
        .addComponents(
            // Only the prize shows an example; the other fields start empty
            // (empty still uses the default text in the giveaway).
            textInput('prize', 'Prize', TextInputStyle.Short, { value: draft.prize, placeholder: '1 month vip', required: true, maxLength: 256 }),
            textInput('description', 'Description', TextInputStyle.Paragraph, { value: draft.description, maxLength: 1000 }),
            textInput('requirements', 'Requirements', TextInputStyle.Paragraph, { value: draft.requirements, maxLength: 500 }),
            textInput('claim', 'How winners claim the prize', TextInputStyle.Paragraph, { value: draft.claim, maxLength: 500 }),
        );
}

export function giveawayTimingModal(session) {
    const { draft } = session;
    return new ModalBuilder()
        .setCustomId(id(session, 'timingform'))
        .setTitle('Duration & winners')
        .addComponents(
            textInput('duration', 'Duration', TextInputStyle.Short, { value: draft.durationText, placeholder: 'Example: 1m, 1h, 1d', required: true, maxLength: 10 }),
            textInput('winners', `Number of winners (1-${MAX_WINNERS})`, TextInputStyle.Short, { value: draft.winnerCount, required: true, maxLength: 3 }),
        );
}

export async function openGiveawayBuilder(interaction) {
    if (!interaction.inGuild()) {
        return notice(interaction, giveawayWarning('Giveaways only work in a server.'));
    }
    if (!canManageGiveaways(interaction.member, interaction.guild)) {
        return notice(interaction, giveawayWarning('Only staff can start a giveaway.'));
    }
    // One open builder per person: a new /gcreate replaces the old one.
    for (const session of sessions.values()) {
        if (session.userId === interaction.user.id && session.guildId === interaction.guildId) closeSession(session);
    }
    // Start in the current channel when it can hold a giveaway (not a thread).
    const channelType = interaction.channel?.type;
    const usableChannel = channelType === undefined || [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channelType);
    const session = { id: randomUUID().slice(0, 12), guildId: interaction.guildId, userId: interaction.user.id,
        root: interaction, timer: null, draft: newGiveawayDraft(usableChannel ? interaction.channelId : null) };
    sessions.set(session.id, session);
    try {
        await interaction.reply({ ...renderGiveawayBuilder(session), flags: MessageFlags.Ephemeral });
        keepAlive(session);
    } catch (error) {
        closeSession(session, false);
        throw error;
    }
    return session;
}

// Short notices disappear after exactly 10 seconds.
async function notice(interaction, embed) {
    const payload = { embeds: [embed], flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
        const message = await interaction.followUp(payload);
        if (message?.id) removeAfterTenSeconds(interaction, message);
        return message;
    }
    await interaction.reply(payload);
    return removeAfterTenSeconds(interaction);
}

async function postFromBuilder(interaction, client, session) {
    const { draft } = session;
    if (!draft.prize) return notice(interaction, giveawayWarning('Set the prize first with **Edit text**.'));
    const channel = interaction.guild.channels.cache.get(draft.channelId)
        || await interaction.guild.channels.fetch(draft.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return notice(interaction, giveawayWarning('Choose a text channel for the giveaway.'));

    await interaction.deferUpdate();
    const giveaway = await postGiveaway(client, interaction.guild, channel, {
        ...draft,
        durationMs: parseDuration(draft.durationText),
        hostId: interaction.user.id,
    });
    closeSession(session, false);
    const endsAt = Math.floor(giveaway.endsAt / 1000);
    await interaction.editReply({
        embeds: [successEmbed('Success', `The giveaway for **${giveaway.prize}** is live in <#${channel.id}> and ends <t:${endsAt}:R>.`)],
        components: [],
    });
    removeAfterTenSeconds(interaction);

    try {
        await logEvent({
            client,
            guildId: interaction.guildId,
            eventType: EVENT_TYPES.GIVEAWAY_CREATE,
            data: {
                description: `Giveaway created: ${giveaway.prize}`,
                channelId: channel.id,
                userId: interaction.user.id,
                fields: [
                    { name: 'Prize', value: giveaway.prize, inline: true },
                    { name: 'Winners', value: String(giveaway.winnerCount), inline: true },
                    { name: 'Duration', value: draft.durationText, inline: true },
                    { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                ],
            },
        });
    } catch (logError) {
        logger.debug('Error logging giveaway creation event:', logError);
    }
    return giveaway;
}

// All Giveaway Builder controls: buttons, the channel and role pickers, and
// the two forms. Only the person who opened the builder can use it.
export async function handleGiveawayBuilderInteraction(interaction, client) {
    if (!interaction.customId?.startsWith(GIVEAWAY_BUILDER_PREFIX)) return false;
    const [action, sessionId] = interaction.customId.slice(GIVEAWAY_BUILDER_PREFIX.length).split(':');
    const session = sessions.get(sessionId);
    try {
        if (!session || session.userId !== interaction.user.id) {
            await notice(interaction, giveawayWarning('This giveaway builder has expired. Run /gcreate again.'));
            return true;
        }
        if (!canManageGiveaways(interaction.member, interaction.guild)) {
            await notice(interaction, giveawayWarning('Only staff can start a giveaway.'));
            return true;
        }
        keepAlive(session);
        const { draft } = session;

        if (action === 'text' || action === 'timing') {
            await interaction.showModal(action === 'text' ? giveawayTextModal(session) : giveawayTimingModal(session));
            return true;
        }
        if (action === 'cancel') {
            closeSession(session, false);
            await interaction.update({ embeds: [successEmbed('Success', 'The giveaway builder was closed. Nothing was posted.')], components: [] });
            removeAfterTenSeconds(interaction);
            return true;
        }
        if (action === 'post') {
            await postFromBuilder(interaction, client, session);
            return true;
        }
        if (action === 'channel' && interaction.isChannelSelectMenu?.()) {
            draft.channelId = interaction.values[0] || draft.channelId;
        } else if (action === 'role' && interaction.isRoleSelectMenu?.()) {
            const roleId = interaction.values[0];
            draft.ping = roleId ? { type: 'role', roleId } : { type: 'none', roleId: null };
        } else if (action === 'everyone') {
            draft.ping = draft.ping.type === 'everyone' ? { type: 'none', roleId: null } : { type: 'everyone', roleId: null };
        } else if (action === 'textform') {
            const value = name => giveawayText(interaction.fields.getTextInputValue(name), name === 'prize' ? 256 : name === 'description' ? 1000 : 500);
            draft.prize = value('prize') || draft.prize;
            draft.description = value('description');
            draft.requirements = value('requirements');
            draft.claim = value('claim');
        } else if (action === 'timingform') {
            const durationText = interaction.fields.getTextInputValue('duration').trim();
            const durationMs = parseDuration(durationText);
            const winnerCount = Number.parseInt(interaction.fields.getTextInputValue('winners'), 10);
            validateWinnerCount(winnerCount);
            Object.assign(draft, { durationText, durationMs, winnerCount });
        } else {
            await interaction.deferUpdate().catch(() => {});
            return true;
        }
        await interaction.update(renderGiveawayBuilder(session));
        return true;
    } catch (error) {
        const message = error?.userMessage || 'Something went wrong. Please try again.';
        if (!error?.userMessage) logger.error(`Giveaway builder ${action} failed:`, error);
        await notice(interaction, giveawayWarning(message)).catch(() => {});
        return true;
    }
}
