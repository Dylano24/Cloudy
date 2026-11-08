import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, ChannelType, EmbedBuilder,
  MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  AUTO_WIPE_GUILD_ID, configureWipeAutomation, getWipeAutomationConfig,
  setWipeAutomationState,
} from './wipeAutomationService.js';
import { CLOUDY_LOGO_URL } from './cloudyLogoService.js';
import { CLOUDY_BRANDING } from './cloudyBrandingService.js';
import { logger } from '../utils/logger.js';
import { amsterdamParts, parseAmsterdamStart, parseAutomationDuration, shortAutomationDuration } from './automationSchedule.js';

export const AUTOMATION_BUILDER_PREFIX = 'auto_builder:';
const SESSION_MS = 30 * 60_000;
const sessions = new Map();

function expiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(id);
  }
}

function baseDraft(kind, saved) {
  return {
    schedule: 'repeat', server: 'Cloudy', channelId: '',
    repeatMinutes: 1440, beforeMinutes: 120, durationMinutes: 60,
    randomize: false, state: 'stopped',
    ...(kind === 'vote'
      ? { question: '', maps: [] }
      : { kit: '', prizes: [], winnerCount: 1, winnerRoleId: '', description: '' }),
    ...(saved || {}),
  };
}

function button(id, action, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(`${AUTOMATION_BUILDER_PREFIX}${action}:${id}`)
    .setLabel(label).setStyle(style).setDisabled(disabled);
}

export function formatAutomationDashboard(session) {
  const { kind, draft, id, dirty } = session;
  const isVote = kind === 'vote';
  const status = draft.state || 'stopped';
  const isFinished = draft.schedule === 'once'
    && (Boolean(draft.completedAt)
      || (status === 'stopped' && draft.startAt && draft.startAt <= Date.now()));
  const label = isVote ? 'Auto vote' : 'Auto giveaway';
  const content = isVote
    ? `**Question:** ${draft.question || 'Not configured'}\n**Options:** ${draft.maps?.join(' / ') || 'Not configured'}`
    : `**Prizes:** ${draft.prizes?.join(' / ') || draft.kit || 'Not configured'}\n**Winners:** ${draft.winnerCount || 1}\n**Winner role:** ${draft.winnerRoleId ? `<@&${draft.winnerRoleId}>` : 'None (optional for repeats)'}`;
  const schedule = draft.schedule === 'repeat'
    ? `Every ${shortAutomationDuration(draft.repeatMinutes || 1440)}`
    : draft.schedule === 'once'
      ? 'Once (selected date)'
      : `${draft.beforeMinutes || 120} minutes before the **${draft.server || 'Rust'}** wipe`;
  const starts = draft.schedule !== 'wipe'
    ? `\n**Start date:** ${draft.startAt ? `<t:${Math.floor(draft.startAt / 1000)}:F>` : 'Set in Schedule'}`
    : '';
  const next = draft.schedule !== 'wipe' && draft.nextRunAt && status === 'running'
    ? `\n**Next run:** <t:${Math.floor(draft.nextRunAt / 1000)}:F>`
    : '';
  const embed = new EmbedBuilder()
    .setColor(0xDC2626)
    .setTitle(label)
    .setThumbnail(CLOUDY_LOGO_URL)
    .setDescription(`Manage automatic ${isVote ? 'votes' : 'giveaways'} from one dashboard. All changes stay private until a scheduled post is published.\n\u200B\n${content}\n\n**Channel:** ${draft.channelId ? `<#${draft.channelId}>` : 'Select a channel'}\n**Schedule:** ${schedule}${starts}\n**Duration:** ${shortAutomationDuration(draft.durationMinutes)}\n**Randomize:** ${draft.randomize
      ? (isVote ? 'On — shuffle voting options' : 'On — choose a random prize')
      : 'Off'}\n**Status:** ${isFinished ? 'completed — choose a new date to run again' : status}${next}${dirty ? '\n\n*Unsaved changes — choose Save before Start.*' : ''}${session.notice ? `\n\n**Notice:** ${session.notice}` : ''}`)
    .setFooter({ text: CLOUDY_BRANDING });

  // Discord supports up to five buttons per action row. Keep the layout
  // identical for votes and giveaways, regardless of automation state.
  const actions = new ActionRowBuilder().addComponents(
    button(id, 'details', 'Edit details', ButtonStyle.Primary),
    button(id, 'schedule', 'Schedule'),
    button(id, 'random', draft.randomize ? 'Randomize: on' : 'Randomize: off'),
  );
  const controls = new ActionRowBuilder().addComponents(
    button(id, 'save', 'Save', ButtonStyle.Success),
    button(id, 'start', status === 'paused' ? 'Resume' : 'Start',
      ButtonStyle.Success, status === 'running' || dirty || !session.saved || Boolean(isFinished)),
    button(id, 'pause', 'Pause', ButtonStyle.Secondary, status !== 'running'),
    button(id, 'stop', 'Stop', ButtonStyle.Danger, status === 'stopped'),
    button(id, 'close', 'Cancel'),
  );
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`${AUTOMATION_BUILDER_PREFIX}channel:${id}`)
    .setPlaceholder('Choose a posting channel')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1).setMaxValues(1);
  if (draft.channelId) channelMenu.setDefaultChannels(draft.channelId);
  const rows = [actions, controls, new ActionRowBuilder().addComponents(channelMenu)];
  if (!isVote) {
    const roles = new RoleSelectMenuBuilder()
      .setCustomId(`${AUTOMATION_BUILDER_PREFIX}role:${id}`)
      .setPlaceholder('Optional winner role')
      .setMinValues(0).setMaxValues(1);
    if (draft.winnerRoleId) roles.setDefaultRoles(draft.winnerRoleId);
    rows.push(new ActionRowBuilder().addComponents(roles));
  }
  const mode = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOMATION_BUILDER_PREFIX}mode:${id}`)
    .setPlaceholder('Select a schedule type')
    .addOptions(
      { label: 'Repeat from a date', value: 'repeat', default: draft.schedule === 'repeat' },
      { label: 'Once on a date', value: 'once', default: draft.schedule === 'once' },
      { label: 'Before a Rust wipe', value: 'wipe', default: draft.schedule === 'wipe' },
    );
  rows.push(new ActionRowBuilder().addComponents(mode));
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

function input(id, label, value, { required = true, maxLength = 250, paragraph = false } = {}) {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(required).setMaxLength(maxLength);
  if (id === 'repeat') field.setPlaceholder('1d');
  if (id === 'duration') field.setPlaceholder('1m');
  if (id === 'date') field.setPlaceholder('10-11-2026');
  if (id === 'time') field.setPlaceholder('18:00');
  if (value !== undefined && value !== null && String(value).length) field.setValue(String(value).slice(0, maxLength));
  return new ActionRowBuilder().addComponents(field);
}

export function buildAutomationModal(session, action) {
  const { id, kind, draft } = session;
  const modal = new ModalBuilder()
    .setCustomId(`${AUTOMATION_BUILDER_PREFIX}modal:${id}:${action}`)
    .setTitle(action === 'schedule' ? 'Schedule' : kind === 'vote' ? 'Configure auto vote' : 'Configure auto giveaway');
  if (action === 'schedule') {
    if (draft.schedule === 'repeat' || draft.schedule === 'once') {
      const local = draft.startAt ? amsterdamParts(draft.startAt) : { date: '', time: '' };
      modal.addComponents(
        input('date', 'Date', local.date, { maxLength: 10 }),
        input('time', 'Time (EU)', local.time, { maxLength: 5 }),
      );
      if (draft.schedule === 'repeat') {
        modal.addComponents(input('repeat', 'Repeat', shortAutomationDuration(draft.repeatMinutes),
          { maxLength: 8 }));
      }
      modal.addComponents(input('duration', 'Duration', shortAutomationDuration(draft.durationMinutes),
        { maxLength: 8 }));
    } else {
      modal.addComponents(
        input('server', 'Connected Rust server name', draft.server === 'Cloudy' ? '' : draft.server, { maxLength: 60 }),
        input('before', 'Before wipe', shortAutomationDuration(draft.beforeMinutes),
          { maxLength: 8 }),
        input('duration', 'Duration', shortAutomationDuration(draft.durationMinutes),
          { maxLength: 8 }),
      );
    }
  } else if (kind === 'vote') {
    modal.addComponents(
      input('question', 'Vote question', draft.question, { maxLength: 250 }),
      input('option1', 'First option', draft.maps?.[0], { maxLength: 80 }),
      input('option2', 'Second option', draft.maps?.[1], { maxLength: 80 }),
      input('option3', 'Third option (optional)', draft.maps?.[2], { maxLength: 80, required: false }),
    );
  } else {
    modal.addComponents(
      input('prizes', 'Prizes (one per line)', draft.prizes?.join('\n') || draft.kit,
        { maxLength: 1200, paragraph: true }),
      input('winners', 'Number of winners (1-10)', draft.winnerCount, { maxLength: 2 }),
      input('description', 'Description (optional)', draft.description,
        { maxLength: 800, paragraph: true, required: false }),
    );
  }
  return modal;
}

function field(interaction, id) {
  return String(interaction.fields.getTextInputValue(id) || '').trim();
}

function applyModal(session, interaction, action) {
  if (action === 'schedule') {
    const duration = parseAutomationDuration(field(interaction, 'duration'));
    if (session.draft.schedule === 'repeat' || session.draft.schedule === 'once') {
      const startAt = parseAmsterdamStart(field(interaction, 'date'), field(interaction, 'time'));
      if (startAt <= Date.now()) throw new RangeError('Choose a future start date and time.');
      if (session.draft.schedule === 'repeat') {
        const repeat = parseAutomationDuration(field(interaction, 'repeat'));
        if (repeat < 15 || repeat < duration) {
          throw new RangeError('Repeat must be at least 15m and not shorter than Duration.');
        }
        Object.assign(session.draft, { repeatMinutes: repeat, durationMinutes: duration, startAt });
      } else {
        Object.assign(session.draft, { durationMinutes: duration, startAt });
      }
    } else {
      const before = parseAutomationDuration(field(interaction, 'before'));
      const server = field(interaction, 'server');
      if (!server || before < 2 || before > 10080 || duration >= before) {
        throw new RangeError('Enter a server and choose a duration that finishes before the wipe.');
      }
      Object.assign(session.draft, { server, beforeMinutes: before, durationMinutes: duration });
    }
  } else if (session.kind === 'vote') {
    const question = field(interaction, 'question');
    const maps = [field(interaction, 'option1'), field(interaction, 'option2'),
      field(interaction, 'option3')].filter(Boolean);
    if (!question || maps.length < 2 || new Set(maps.map(x => x.toLowerCase())).size !== maps.length) {
      throw new RangeError('Enter a question and two or three different options.');
    }
    Object.assign(session.draft, { question, maps });
  } else {
    const prizes = field(interaction, 'prizes').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const count = Number(field(interaction, 'winners'));
    if (!prizes.length || prizes.length > 20 || prizes.some(x => x.length > 150)
      || !Number.isInteger(count) || count < 1 || count > 10) {
      throw new RangeError('Enter 1–20 prizes (up to 150 characters each) and 1–10 winners.');
    }
    Object.assign(session.draft, {
      kit: prizes[0], prizes, winnerCount: count, description: field(interaction, 'description'),
    });
  }
  session.dirty = true;
}

function authorized(interaction) {
  return interaction.guildId === AUTO_WIPE_GUILD_ID
    && interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild);
}

async function validateDestination(interaction, session) {
  if (!session.draft.channelId) throw new RangeError('Select a posting channel first.');
  const channel = interaction.guild?.channels?.cache?.get(session.draft.channelId)
    || await interaction.guild?.channels?.fetch?.(session.draft.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel?.isSendable?.()) {
    throw new RangeError('Cloudy cannot post in the selected channel.');
  }
  const botMember = interaction.guild?.members?.me
    || await interaction.guild?.members?.fetchMe?.().catch(() => null);
  const channelPermissions = botMember && channel.permissionsFor?.(botMember);
  if (channelPermissions && (!channelPermissions.has(PermissionFlagsBits.SendMessages)
    || !channelPermissions.has(PermissionFlagsBits.EmbedLinks))) {
    throw new RangeError('Cloudy needs Send Messages and Embed Links permissions in that channel.');
  }
  if (session.kind !== 'giveaway' || !session.draft.winnerRoleId) return;
  const role = interaction.guild?.roles?.cache?.get(session.draft.winnerRoleId)
    || await interaction.guild?.roles?.fetch?.(session.draft.winnerRoleId).catch(() => null);
  if (!role || role.managed || role.id === interaction.guildId
    || !botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)
    || !botMember.roles?.highest || botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new RangeError('Choose a winner role below Cloudy’s highest role, or leave it empty.');
  }
}

async function saveSession(interaction, session) {
  await validateDestination(interaction, session);
  // Save configuration only; Start/Pause/Stop remain separate actions.
  // Editing an active automation must not stop it as a side effect.
  const previousState = session.draft.state;
  await configureWipeAutomation(interaction.client, session.guildId, session.kind, session.draft);
  const stored = previousState === 'running' || previousState === 'paused'
    ? await setWipeAutomationState(interaction.client, session.guildId, session.kind, previousState)
    : (await getWipeAutomationConfig(interaction.client, session.guildId))[session.kind];
  session.draft = baseDraft(session.kind, stored);
  session.dirty = false;
  session.saved = true;
}

export async function openAutomationDashboard(interaction, kind) {
  if (!authorized(interaction) || !['vote', 'giveaway'].includes(kind)) {
    return interaction.reply({ content: 'Manage Server permission is required in Cloudy Inc.',
      flags: MessageFlags.Ephemeral });
  }
  expiredSessions();
  const saved = (await getWipeAutomationConfig(interaction.client, interaction.guildId))[kind];
  const id = randomUUID().slice(0, 12);
  const session = {
    id, kind, guildId: interaction.guildId, userId: interaction.user.id,
    draft: baseDraft(kind, saved), dirty: false, saved: Boolean(saved),
    notice: '', expiresAt: Date.now() + SESSION_MS,
  };
  sessions.set(id, session);
  return interaction.reply({
    ...formatAutomationDashboard(session), flags: MessageFlags.Ephemeral,
  });
}

export async function handleAutomationBuilderInteraction(interaction) {
  if (!interaction.customId?.startsWith(AUTOMATION_BUILDER_PREFIX)) return false;
  const parts = interaction.customId.slice(AUTOMATION_BUILDER_PREFIX.length).split(':');
  const action = parts[0];
  const id = parts[1];
  const session = sessions.get(id);
  if (!session || session.userId !== interaction.user?.id
    || session.guildId !== interaction.guildId || session.expiresAt < Date.now()
    || !authorized(interaction)) {
    await interaction.reply({ content: 'This dashboard expired or belongs to another user. Run /auto vote or /auto giveaway again.',
      flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }
  session.expiresAt = Date.now() + SESSION_MS;
  session.notice = '';
  try {
    if (action === 'modal' && interaction.isModalSubmit?.()) {
      applyModal(session, interaction, parts[2]);
      await interaction.update(formatAutomationDashboard(session));
      return true;
    }
    if (action === 'details' || action === 'schedule') {
      await interaction.showModal(buildAutomationModal(session, action));
      return true;
    }
    if (action === 'close') {
      sessions.delete(id);
      await interaction.update({ embeds: [], components: [], content: 'Automation builder closed.' });
      return true;
    }
    if (action === 'channel' && interaction.isChannelSelectMenu?.()) {
      const channelId = interaction.values?.[0];
      const channel = interaction.guild?.channels?.cache?.get(channelId)
        || await interaction.guild?.channels?.fetch?.(channelId).catch(() => null);
      if (!channel?.isTextBased?.() || !channel?.isSendable?.()) {
        throw new RangeError('Choose a text channel where Cloudy can send messages.');
      }
      session.draft.channelId = channelId;
      session.dirty = true;
    } else if (action === 'role' && interaction.isRoleSelectMenu?.()) {
      if (session.kind !== 'giveaway') return true;
      session.draft.winnerRoleId = interaction.values?.[0] || '';
      session.dirty = true;
    } else if (action === 'mode' && interaction.isStringSelectMenu?.()) {
      const mode = interaction.values?.[0];
      if (!['once', 'repeat', 'wipe'].includes(mode)) return true;
      session.draft.schedule = mode;
      session.dirty = true;
    } else if (action === 'random') {
      session.draft.randomize = !session.draft.randomize;
      session.dirty = true;
    } else if (action === 'save') {
      await interaction.deferUpdate();
      if (session.dirty || !session.saved) await saveSession(interaction, session);
      await interaction.editReply(formatAutomationDashboard(session));
      return true;
    } else if (action === 'start' || action === 'pause') {
      await interaction.deferUpdate();
      if (session.dirty || !session.saved) {
        throw new RangeError('Save your settings before starting or pausing.');
      }
      if (action === 'start' && session.draft.state === 'running') return true;
      if (action === 'pause' && session.draft.state !== 'running') return true;
      const state = action === 'start' ? 'running' : 'paused';
      const stored = await setWipeAutomationState(interaction.client, session.guildId, session.kind, state);
      session.draft = baseDraft(session.kind, stored);
      await interaction.editReply(formatAutomationDashboard(session));
      return true;
    } else if (action === 'stop') {
      await interaction.deferUpdate();
      const stored = await setWipeAutomationState(interaction.client, session.guildId, session.kind, 'stopped');
      session.draft = session.dirty
        ? { ...session.draft, state: 'stopped' } : baseDraft(session.kind, stored);
      await interaction.editReply(formatAutomationDashboard(session));
      return true;
    } else return true;
    await interaction.update(formatAutomationDashboard(session));
  } catch (error) {
    session.notice = error instanceof RangeError ? error.message : 'Automation could not be updated.';
    if (!(error instanceof RangeError)) logger.warn('[AUTO_BUILDER] Unexpected dashboard error:', error);
    const payload = formatAutomationDashboard(session);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else if (interaction.update) {
      await interaction.update(payload).catch(() => {});
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}
