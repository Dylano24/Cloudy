import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
    buildPrivateClaimEmbed, createDemoClaimCode, DEFAULT_CLAIM_INTRODUCTION,
    DEFAULT_CLAIM_CONDITIONS, defaultClaimHowToGet, customClaimHowToGet,
    DEFAULT_CLAIM_REVIEW, defaultClaimPleaseNote, customClaimPleaseNote,
} from './giveawayClaimPreview.js';
import { currentGiveawayClaimIcons } from './giveawayClaimIcons.js';
import { successEmbed } from '../utils/embeds.js';
import { giveawayWarning, removeAfterTenSeconds } from '../handlers/giveawayButtons.js';
import { logger } from '../utils/logger.js';
import { botConfig } from '../config/bot.js';
import { sendGiveawayCreatedLog } from './giveawayLogService.js';
import { giveawayCodeModal, readGiveawayCodeModal } from './giveawayCodeService.js';
import {
    createGiveawayEmbed,
    DEFAULT_GIVEAWAY_DESCRIPTION,
    DEFAULT_GIVEAWAY_INTRO,
    DEFAULT_GIVEAWAY_CLOSING,
    giveawayText,
    parseDuration,
    validateWinnerCount,
} from './giveawayService.js';
import { canManageGiveaways, postGiveaway } from './giveawayActions.js';

// The Giveaway Builder: like the Embed Builder, a private live preview with
// controls. /giveaway create opens it; nothing is posted until "Post giveaway".
export const GIVEAWAY_BUILDER_PREFIX = 'gbuilder:';
const IDLE_MS = 30 * 60_000;
const MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;
const sessions = new Map();
// A new giveaway must always open with the original default text.
// Changes in an active builder belong only to that giveaway, and stored
// legacy templates are deliberately ignored (not deleted).
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
        introTitle: DEFAULT_GIVEAWAY_INTRO,
        closingText: DEFAULT_GIVEAWAY_CLOSING,
        description: null,
        requirements: null,
        claim: null,
        claimDetails: null,
        claimCodeInstructions: null,
        claimPanelTitle: null,
        claimExpiryInstructions: null,
        claimDemoCode: createDemoClaimCode(),
        claimIntroduction: null,
        claimConditions: null,
        claimHowToGet: null,
        claimReview: null,
        claimPleaseNote: null,
        // No code until Code says otherwise: members then choose their country.
        codeType: 'none',
        codeDiscount: null,
        plainAddedCodes: [],
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
        hostId: session.userId,
        endsAt: Date.now() + draft.durationMs,
        participants: [],
    }, 'active');
    // Use the same private claim embed as the winner's channel. The builder
    // preview does not tag anyone or activate demo codes.
    const winnerPreview = buildPrivateClaimEmbed(
        { ...draft, guildId: session.guildId, messageId: 'preview' }, session.userId, currentGiveawayClaimIcons(),
    );

    const channel = new ChannelSelectMenuBuilder()
        .setCustomId(id(session, 'channel'))
        .setPlaceholder('Choose a channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1);
    if (draft.channelId) channel.setDefaultChannels(draft.channelId);
    // @everyone is not a Discord role-selectable role. A dedicated choice
    // places it first; "Role" opens a small form with the role picker, so the
    // controls fit Discord's limit of five rows.
    const roleName = draft.ping.type === 'role' && draft.ping.roleId
        ? session.roleName?.(draft.ping.roleId) || null : null;
    const pingType = new StringSelectMenuBuilder()
        .setCustomId(id(session, 'pingtype'))
        .setPlaceholder(draft.ping.type === 'role' && draft.ping.roleId
            ? `Role: @${roleName || 'chosen role'}`.slice(0, 150) : 'Choose a tag')
        .addOptions(
            { label: '@everyone', value: 'everyone', default: draft.ping.type === 'everyone' },
            { label: 'Role', value: 'role' },
            { label: 'No tag', value: 'none' },
        );

    return {
        embeds: [preview, winnerPreview],
        components: [
            new ActionRowBuilder().addComponents(pingType),
            new ActionRowBuilder().addComponents(channel),
            // Owner's order: Edit text, Edit claim / Duration & winners, Code /
            // Post giveaway, Cancel (red).
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id(session, 'text')).setLabel('Edit text').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(id(session, 'claim')).setLabel('Edit claim').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id(session, 'timing')).setLabel('Duration & winners').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(id(session, 'code')).setLabel('Code').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(id(session, 'post')).setEmoji('📤').setLabel('Post giveaway')
                    .setStyle(ButtonStyle.Success).setDisabled(!draft.prize || !draft.channelId),
                new ButtonBuilder().setCustomId(id(session, 'cancel')).setLabel('Cancel').setStyle(ButtonStyle.Danger),
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
            textInput('introTitle', 'Introduction title', TextInputStyle.Short, { value: draft.introTitle, required: true, maxLength: 150 }),
            textInput('description', 'Description', TextInputStyle.Paragraph, { value: draft.description || DEFAULT_GIVEAWAY_DESCRIPTION, maxLength: 1000 }),
            textInput('prize', 'Prize', TextInputStyle.Short, { value: draft.prize, placeholder: '1 month vip', required: true, maxLength: 256 }),
            textInput('requirements', 'Requirements', TextInputStyle.Paragraph, { value: draft.requirements, maxLength: 500 }),
            textInput('closingText', 'Closing message', TextInputStyle.Paragraph, { value: draft.closingText, required: true, maxLength: 300 }),
        );
}

export function giveawayClaimModal(session) {
    const { draft } = session;
    return new ModalBuilder()
        .setCustomId(id(session, 'claimform'))
        .setTitle('Winner claim instructions')
        .addComponents(
            textInput('claimIntroduction', 'Introduction', TextInputStyle.Paragraph,
                { value: draft.claimIntroduction || DEFAULT_CLAIM_INTRODUCTION, maxLength: 250 }),
            textInput('claimConditions', 'Prize conditions', TextInputStyle.Paragraph,
                { value: draft.claimConditions || DEFAULT_CLAIM_CONDITIONS, maxLength: 1000 }),
            textInput('claimHowToGet', 'How to get your prize', TextInputStyle.Paragraph,
                { value: draft.claimHowToGet || defaultClaimHowToGet(draft), maxLength: 500 }),
            textInput('claimReview', 'Share your feedback', TextInputStyle.Paragraph,
                { value: draft.claimReview || DEFAULT_CLAIM_REVIEW, maxLength: 1000 }),
            textInput('claimPleaseNote', 'Please note', TextInputStyle.Paragraph,
                { value: draft.claimPleaseNote || defaultClaimPleaseNote(draft), maxLength: 1000 }),
        );
}

export function giveawayRoleModal(session) {
    const role = new RoleSelectMenuBuilder()
        .setCustomId('role')
        .setPlaceholder('Choose the role')
        .setMinValues(1)
        .setMaxValues(1);
    if (session.draft.ping.type === 'role' && session.draft.ping.roleId) role.setDefaultRoles(session.draft.ping.roleId);
    return new ModalBuilder()
        .setCustomId(id(session, 'roleform'))
        .setTitle('Tag a role')
        .addLabelComponents(new LabelBuilder().setLabel('Role').setRoleSelectMenuComponent(role));
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
    // One open builder per person: a new /giveaway create replaces the old one.
    for (const session of sessions.values()) {
        if (session.userId === interaction.user.id && session.guildId === interaction.guildId) closeSession(session);
    }
    // Require an explicit channel choice for each new giveaway.
    const session = { id: randomUUID().slice(0, 12), guildId: interaction.guildId, userId: interaction.user.id,
        root: interaction, timer: null, draft: newGiveawayDraft(),
        roleName: roleId => interaction.guild?.roles?.cache?.get?.(roleId)?.name || null };
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

    // Created log in #giveaway-logs (owner's choice).
    await sendGiveawayCreatedLog(client, interaction.guild, giveaway);
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
            await notice(interaction, giveawayWarning('This giveaway builder has expired. Run /giveaway create again.'));
            return true;
        }
        if (!canManageGiveaways(interaction.member, interaction.guild)) {
            await notice(interaction, giveawayWarning('Only staff can start a giveaway.'));
            return true;
        }
        keepAlive(session);
        const { draft } = session;

        if (action === 'text' || action === 'timing' || action === 'claim' || action === 'code') {
            await interaction.showModal(action === 'text' ? giveawayTextModal(session)
                : action === 'claim' ? giveawayClaimModal(session)
                    : action === 'code' ? giveawayCodeModal(id(session, 'codeform'), { ...draft, draftAddedCodes: draft.plainAddedCodes || [] })
                        : giveawayTimingModal(session));
            return true;
        }
        if (action === 'pingtype' && interaction.isStringSelectMenu?.() && interaction.values[0] === 'role') {
            await interaction.showModal(giveawayRoleModal(session));
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
        } else if (action === 'pingtype' && interaction.isStringSelectMenu?.()) {
            const type = interaction.values[0];
            if (['everyone', 'none'].includes(type)) draft.ping = { type, roleId: null };
        } else if (action === 'roleform') {
            const roleId = interaction.fields.getField('role')?.values?.[0];
            if (roleId) draft.ping = { type: 'role', roleId };
        } else if (action === 'codeform') {
            const { codeType, codeDiscount, addedCodes } = readGiveawayCodeModal(interaction);
            Object.assign(draft, { codeType, codeDiscount, plainAddedCodes: addedCodes || [] });
        } else if (action === 'textform') {
            const value = name => giveawayText(interaction.fields.getTextInputValue(name), name === 'prize' ? 256 : name === 'description' ? 1000 : 500);
            draft.introTitle = value('introTitle') || DEFAULT_GIVEAWAY_INTRO;
            draft.description = value('description');
            draft.prize = value('prize') || draft.prize;
            draft.requirements = value('requirements');
            draft.closingText = value('closingText') || DEFAULT_GIVEAWAY_CLOSING;
        } else if (action === 'claimform') {
            draft.claimIntroduction = giveawayText(interaction.fields.getTextInputValue('claimIntroduction'), 250);
            draft.claimConditions = giveawayText(interaction.fields.getTextInputValue('claimConditions'), 1000);
            draft.claimHowToGet = customClaimHowToGet(giveawayText(interaction.fields.getTextInputValue('claimHowToGet'), 500));
            draft.claimReview = giveawayText(interaction.fields.getTextInputValue('claimReview'), 1000);
            draft.claimPleaseNote = customClaimPleaseNote(giveawayText(interaction.fields.getTextInputValue('claimPleaseNote'), 1000));
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
