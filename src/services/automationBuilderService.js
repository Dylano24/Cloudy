import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, FileUploadBuilder,
  LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import {
  AUTO_WIPE_GUILD_ID, configureWipeAutomation, getWipeAutomationConfig,
  setWipeAutomationState, listAutomaticVotes, saveAutomaticVoteJob,
  setAutomaticVoteJobState, deleteAutomaticVoteJob,
  listAutomaticGiveaways, saveAutomaticGiveawayJob,
  setAutomaticGiveawayJobState, deleteAutomaticGiveawayJob, autoWipeGiveawayPayload,
} from './wipeAutomationService.js';
import { CLOUDY_LOGO_URL } from './cloudyLogoService.js';
import { newGiveawayDraft } from './giveawayBuilderService.js';
import { createGiveawayEmbed, giveawayText } from './giveawayService.js';
import { buildPrivateClaimEmbed, DEFAULT_CLAIM_INTRODUCTION, DEFAULT_CLAIM_CONDITIONS,
  DEFAULT_CLAIM_REVIEW, defaultClaimHowToGet, defaultClaimPleaseNote,
  customClaimHowToGet, customClaimPleaseNote } from './giveawayClaimPreview.js';
import { currentGiveawayClaimIcons } from './giveawayClaimIcons.js';
import { giveawayCodeModal, readGiveawayCodeModal, unusedAddedCodes } from './giveawayCodeService.js';
import { uploadVotePictures } from './voteMediaService.js';
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
  // Automations saved before the dashboard existed had no explicit schedule.
  // They are Rust-wipe automations, never daily repeat jobs.
  const previous = saved && !saved.schedule ? { ...saved, schedule: 'wipe' } : saved;
  const restored = kind === 'giveaway' && previous?.codeType === 'added'
    ? { ...previous, plainAddedCodes: unusedAddedCodes(previous) } : previous;
  return {
    schedule: 'repeat', server: 'Cloudy', channelId: '',
    ...(kind === 'giveaway' ? { giveawayType: previous?.schedule === 'wipe' ? 'wipe' : 'standard' } : {}),
    repeatMinutes: 1440, beforeMinutes: 120, durationMinutes: kind === 'giveaway' ? 1440 : 60,
    randomize: false, state: 'stopped', weeklyMin: 2, weeklyMax: 3,
    mediaLibrary: [],
    ...(kind === 'vote'
      ? { question: '', maps: [] }
      : { ...newGiveawayDraft(), name: '', kit: '', prizes: [], winnerRoleId: '' }),
    ...(restored || {}),
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
  const isWipe = !isVote && draft.giveawayType === 'wipe';
  const status = draft.state || 'stopped';
  const isFinished = draft.schedule === 'once'
    && (Boolean(draft.completedAt)
      || (status === 'stopped' && draft.startAt && draft.startAt <= Date.now()));
  const label = isVote ? 'Auto vote' : 'Auto giveaway';
  const content = isVote
    ? `**Name:** ${draft.name || draft.question || 'New vote'}\n**Question:** ${draft.question || 'Not configured'}\n**Options:** ${draft.maps?.join(' / ') || 'Not configured'}`
    : `**Type:** ${isWipe ? 'Rust wipe' : 'Standard'}\n**Name:** ${draft.name || draft.prizes?.[0] || draft.kit || 'New giveaway'}\n**${isWipe ? 'Kit' : 'Prizes'}:** ${isWipe ? draft.kit || 'Not configured' : draft.prizes?.join(' / ') || draft.kit || 'Not configured'}\n**Winners:** ${draft.winnerCount || 1}\n**Tag:** ${draft.ping?.type === 'everyone' ? '@everyone' : draft.ping?.type === 'role' ? `<@&${draft.ping.roleId}>` : 'No tag'}${isWipe ? `\n**Winner role:** ${draft.winnerRoleId ? `<@&${draft.winnerRoleId}>` : 'Not configured'}\n**Prize sync:** /wipe sync (no claim or reroll)` : ''}`;
  const schedule = draft.schedule === 'random_weekly'
    ? `Random ${draft.weeklyMin || 2}–${draft.weeklyMax || 3} times per week`
    : draft.schedule === 'repeat'
      ? `Every ${shortAutomationDuration(draft.repeatMinutes || 1440)}`
    : draft.schedule === 'once'
      ? 'Once (selected date)'
      : isVote ? `${draft.beforeMinutes || 120} minutes before the **${draft.server || 'Rust'}** wipe`
        : isWipe ? `${shortAutomationDuration(draft.beforeMinutes || 120)} before the **${draft.server || 'Rust'}** wipe`
          : 'Choose Repeat or Once';
  const starts = draft.schedule !== 'wipe'
    ? `\n**Start date:** ${draft.startAt ? `<t:${Math.floor(draft.startAt / 1000)}:F>` : 'Set in Schedule'}`
    : '';
  const next = draft.schedule !== 'wipe' && draft.nextRunAt && status === 'running'
    ? `\n**Next run:** <t:${Math.floor(draft.nextRunAt / 1000)}:F>`
    : '';
  const invalidInformation = session.validationError || Boolean(session.scheduleInputs);
  // Disabled Discord buttons cannot explain themselves. Show the exact
  // prerequisite in the dashboard instead of leaving Start looking broken.
  const startGuidance = invalidInformation
    ? 'Correct the invalid information before saving or starting.'
    : dirty
      ? 'Save your changes before using Start.'
      : !session.saved
        ? 'Complete the setup and choose Save before using Start.'
        : isFinished
          ? 'This one-time giveaway has finished. Set a future date in Schedule.'
          : isWipe && status === 'running'
            ? 'Running — the giveaway starts automatically before the next detected Rust wipe, not immediately.'
            : '';
  const embed = new EmbedBuilder()
    .setColor(invalidInformation ? 0xE53935 : isVote ? 0xFFFFFF : 0xDC2626)
    .setTitle(invalidInformation ? 'Wrong information' : label)
    .setThumbnail(CLOUDY_LOGO_URL)
    .setDescription(`${isVote ? 'Manage your selected vote.' : 'Manage automatic giveaways from one dashboard.'} All changes stay private until a scheduled post is published.\n\u200B\n${content}\n\n**Channel:** ${draft.channelId ? `<#${draft.channelId}>` : 'Select a channel'}\n**Schedule:** ${schedule}${starts}\n**Duration:** ${shortAutomationDuration(draft.durationMinutes)}${isVote ? `\n**Media:** ${draft.mediaLibrary?.length || 0} saved (up to 500)` : ''}${isWipe ? '' : `\n**Randomize:** ${draft.randomize
      ? (isVote ? 'On — shuffle voting options and media' : 'On — choose a random prize')
      : 'Off'}${!isVote && draft.randomize && draft.prizes?.length > 1 ? '\n*Preview shows a sample prize; the actual prize is chosen when posting.*' : ''}` }\n**Status:** ${isFinished ? 'completed — choose a new date to run again' : status}${next}${dirty ? '\n\n*Unsaved changes — choose Save before Start.*' : ''}${startGuidance ? `\n\n**Start:** ${startGuidance}` : ''}${session.notice ? `\n\n**Notice:** ${session.notice}` : ''}`)
    .setFooter({ text: CLOUDY_BRANDING });

  // Auto Giveaway uses exactly five Discord rows. Keep Duration & winners
  // beside Schedule (two buttons only so Discord mobile does not wrap them):
  // 1. Type / Edit text / Kit & role (or Edit claim)
  // 2. Duration & winners / Schedule / (Code for Standard)
  // 3. Start / Pause / Save / Delete / Back
  // 4. Posting channel
  // 5. Tag
  const startButton = button(id, 'start', status === 'paused' ? 'Resume' : 'Start',
    ButtonStyle.Success, status === 'running' || dirty || !session.saved || Boolean(isFinished)
      || Boolean(session.scheduleInputs) || Boolean(session.validationError));
  const pauseButton = button(id, 'pause', 'Pause', ButtonStyle.Secondary, status !== 'running');
  const saveButton = button(id, 'save', 'Save', ButtonStyle.Success,
    Boolean(session.scheduleInputs) || Boolean(session.validationError));
  const deleteButton = button(id, 'delete', session.confirmDelete ? 'Confirm delete' : 'Delete',
    ButtonStyle.Danger, !session.selectedJobId);
  const actions = new ActionRowBuilder().addComponents(...(isVote ? [
    button(id, 'details', 'Edit details', ButtonStyle.Primary),
    button(id, 'schedule', 'Schedule'),
    button(id, 'random', draft.randomize ? 'Randomize: on' : 'Randomize: off'),
  ] : [
    button(id, 'type', 'Type'),
    button(id, 'text', 'Edit text', ButtonStyle.Primary),
    button(id, isWipe ? 'kit' : 'claim', isWipe ? 'Kit & role' : 'Edit claim'),
  ]));
  const controls = new ActionRowBuilder().addComponents(...(isVote
    ? [startButton, pauseButton, saveButton, deleteButton]
    : [
      button(id, 'timing', 'Duration & winners'),
      button(id, 'schedule', 'Schedule'),
      ...(!isWipe ? [button(id, 'code', 'Code')] : []),
    ]));
  const saveRow = !isVote ? new ActionRowBuilder().addComponents(
    startButton, pauseButton, saveButton, deleteButton, button(id, 'list', 'Back'),
  ) : null;
  const channelMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`${AUTOMATION_BUILDER_PREFIX}channel:${id}`)
    .setPlaceholder('Choose a posting channel')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1).setMaxValues(1);
  if (draft.channelId) channelMenu.setDefaultChannels(draft.channelId);
  const rows = isVote
    ? [actions, controls, new ActionRowBuilder().addComponents(channelMenu)]
    : [actions, controls, saveRow, new ActionRowBuilder().addComponents(channelMenu)];
  if (!isVote) {
    const ping = draft.ping || { type: 'none' };
    const tag = new StringSelectMenuBuilder()
      .setCustomId(`${AUTOMATION_BUILDER_PREFIX}tag:${id}`)
      .setPlaceholder('Choose a tag')
      .addOptions(
        { label: '@everyone', value: 'everyone', default: ping.type === 'everyone' },
        { label: 'Role', value: 'role', default: ping.type === 'role' },
        { label: 'No tag', value: 'none', default: ping.type === 'none' },
      );
    rows.push(new ActionRowBuilder().addComponents(tag));
  }
  const mode = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOMATION_BUILDER_PREFIX}mode:${id}`)
    .setPlaceholder('Select a schedule type')
    .addOptions(
      { label: 'Repeat from a date', value: 'repeat', default: draft.schedule === 'repeat' },
      { label: 'Once on a date', value: 'once', default: draft.schedule === 'once' },
      ...(isVote ? [{ label: 'Before a Rust wipe', value: 'wipe', default: draft.schedule === 'wipe' }] : []),
    );
  if (isVote) rows.push(new ActionRowBuilder().addComponents(mode));
  if (isVote) {
    // Keep all rows comfortable on Discord mobile: media controls live with
    // Back, rather than squeezing five long labels into the first row.
    rows.push(new ActionRowBuilder().addComponents(
      button(id, 'list', 'Back'),
      button(id, 'media', 'Add media'),
      button(id, 'clear_media', session.confirmClearMedia ? 'Confirm clear' : 'Clear media',
        ButtonStyle.Secondary, !draft.mediaLibrary?.length),
    ));
  }
  if (isVote) return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
  const prize = draft.prizes?.[0] || draft.kit || draft.prize || 'Your prize';
  const preview = {
    ...draft, prize, hostId: draft.hostId || session.botId || session.userId, guildId: session.guildId,
    messageId: 'preview', participants: [], endsAt: Date.now() + draft.durationMinutes * 60_000,
  };
  if (isWipe) {
    const wipe = autoWipeGiveawayPayload({ ...preview, id: 'preview', kit: draft.kit || prize,
      status: 'active', winners: [], roleId: draft.winnerRoleId });
    return { embeds: [embed, ...wipe.embeds], components: rows, allowedMentions: { parse: [] } };
  }
  return {
    embeds: [embed, createGiveawayEmbed(preview, 'active'),
      buildPrivateClaimEmbed(preview, session.userId, currentGiveawayClaimIcons())],
    components: rows,
    allowedMentions: { parse: [] },
  };
}

// Shared presentation: both kinds expose Add, Manage and a saved-job picker.
export function formatAutomaticVoteHome(session, jobs) {
  const kind = session.kind;
  const label = kind === 'vote' ? 'Auto vote' : 'Auto giveaway';
  const embed = new EmbedBuilder()
    .setTitle(label)
    .setColor(0xFFFFFF)
    .setThumbnail(CLOUDY_LOGO_URL)
    .setDescription(`Create automatic ${kind}s or manage the ones you have already saved.\n\u200B`)
    .setFooter({ text: CLOUDY_BRANDING });
  const actions = new ActionRowBuilder().addComponents(
    button(session.id, 'new', `Add ${kind}`, ButtonStyle.Success),
    button(session.id, 'manage', `Manage ${kind}`, ButtonStyle.Secondary, !jobs.length),
  );
  return { embeds: [embed], components: [actions], allowedMentions: { parse: [] } };
}

export function formatAutomaticVotesList(session, jobs) {
  const kind = session.kind;
  const label = kind === 'vote' ? 'Auto vote' : 'Auto giveaway';
  const limited = jobs.slice(0, 21);
  const lines = limited.map((job, index) => {
    const title = String(kind === 'vote'
      ? job.name || job.question || 'Untitled vote'
      : job.name || job.prizes?.[0] || job.kit || 'Untitled giveaway').replace(/\s+/g, ' ').slice(0, 56);
    const channel = job.channelId ? `<#${job.channelId}>` : `Default ${kind} channel`;
    const status = job.completedAt ? 'completed' : (job.state || 'stopped');
    const schedule = job.schedule === 'once' ? 'Once'
      : job.schedule === 'repeat'
        ? `Every ${shortAutomationDuration(job.repeatMinutes || 1440)}` : 'Rust wipe';
    const next = job.nextRunAt && job.state === 'running'
      ? ` · Next: <t:${Math.floor(job.nextRunAt / 1000)}:f>` : '';
    return `**${index + 1}. ${title}**\n${channel} · ${schedule} · **${status}**${next}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(label)
    .setColor(0xFFFFFF)
    .setThumbnail(CLOUDY_LOGO_URL)
    .setDescription(`${limited.length
      ? `Select the ${kind} you want to manage.\n\n${lines.join('\n\n')}`
      : `No automatic ${kind}s saved. Go back and choose **Add ${kind}**.`}${session.notice ? `\n\n**Notice:** ${session.notice}` : ''}`)
    .setFooter({ text: CLOUDY_BRANDING });
  const buttons = new ActionRowBuilder().addComponents(button(session.id, 'back', 'Back'));
  const components = [buttons];
  if (limited.length) {
    components.unshift(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${AUTOMATION_BUILDER_PREFIX}select:${session.id}`)
        .setPlaceholder(`Choose an existing auto ${kind}`)
        .addOptions(limited.map(job => ({
          label: String(kind === 'vote'
            ? job.name || job.question || 'Untitled vote'
            : job.name || job.prizes?.[0] || job.kit || 'Untitled giveaway').replace(/\s+/g, ' ').slice(0, 100),
          description: `${job.completedAt ? 'completed' : job.state || 'stopped'} · ${job.schedule === 'once' ? 'Once' : job.schedule === 'repeat' ? 'Repeat' : 'Rust wipe'}`.slice(0, 100),
          value: String(job.id),
        }))),
    ));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}
function input(id, label, value, {
  required = true, maxLength = 250, paragraph = false, description = '',
} = {}) {
  // Discord disallows a nested TextInput.label inside a Label component.
  // Keep the label on the old ActionRow inputs only.
  const field = new TextInputBuilder().setCustomId(id)
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(required).setMaxLength(maxLength);
  if (!description) field.setLabel(label);
  if (id === 'repeat') field.setPlaceholder('1m, 1h, 1d, 1w');
  if (id === 'duration' || id === 'before') {
    field.setPlaceholder('1m, 1h, 1d, 1w');
  }
  if (id === 'date') field.setPlaceholder('10-11-2027');
  if (id === 'time') field.setPlaceholder('18:00');
  if (id === 'weeklyMin') field.setPlaceholder('2');
  if (id === 'weeklyMax') field.setPlaceholder('3');
  if (value !== undefined && value !== null && String(value).length) field.setValue(String(value).slice(0, maxLength));
  return description
    ? new LabelBuilder().setLabel(label).setDescription(description).setTextInputComponent(field)
    : new ActionRowBuilder().addComponents(field);
}

export function buildAutomationModal(session, action) {
  const { id, kind, draft } = session;
  // Discord's mobile client can reuse text from another modal with the same ID.
  // Give every Schedule opening a fresh ID, including the schedule mode, so
  // values from the Rust-wipe form cannot appear in Date/Time fields.
  if (action === 'schedule') session.scheduleModalCounter = (session.scheduleModalCounter || 0) + 1;
  if (action === 'media') session.mediaModalCounter = (session.mediaModalCounter || 0) + 1;
  const modalId = action === 'schedule'
    ? `${AUTOMATION_BUILDER_PREFIX}modal:${id}:${action}:${draft.schedule}:${session.scheduleModalCounter}`
    : action === 'media'
      ? `${AUTOMATION_BUILDER_PREFIX}media:${id}:${session.mediaModalCounter}`
      : `${AUTOMATION_BUILDER_PREFIX}modal:${id}:${action}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(action === 'media' ? 'Add media' : action === 'schedule' ? 'Schedule' : kind === 'vote' ? 'Configure auto vote' : 'Configure auto giveaway');
  if (kind === 'giveaway' && action === 'type') {
    return modal.setTitle('Giveaway type').addLabelComponents(
      new LabelBuilder().setLabel('Giveaway type').setStringSelectMenuComponent(
        new StringSelectMenuBuilder().setCustomId('giveawayType').addOptions(
          { label: 'Standard', value: 'standard', default: draft.giveawayType !== 'wipe' },
          { label: 'Rust wipe', value: 'wipe', default: draft.giveawayType === 'wipe' },
        )));
  }
  if (kind === 'giveaway' && action === 'kit') {
    const role = new RoleSelectMenuBuilder().setCustomId('winnerRole')
      .setPlaceholder('Choose the temporary winner role').setMinValues(1).setMaxValues(1);
    if (draft.winnerRoleId) role.setDefaultRoles(draft.winnerRoleId);
    return modal.setTitle('Wipe kit & winner role').addLabelComponents(
      input('kit', 'Rust kit name', draft.kit, {
        maxLength: 150, description: 'The kit linked to the temporary winner role on your Rust server.',
      }),
      new LabelBuilder().setLabel('Temporary winner role').setRoleSelectMenuComponent(role));
  }
  if (kind === 'giveaway' && action === 'code') {
    if (draft.giveawayType === 'wipe') throw new RangeError('Wipe giveaways have no claim codes.');
    return giveawayCodeModal(modalId, { ...draft, draftAddedCodes: draft.plainAddedCodes || [] });
  }
  if (kind === 'giveaway' && action === 'role') {
    const role = new RoleSelectMenuBuilder().setCustomId('role')
      .setPlaceholder('Choose the role').setMinValues(1).setMaxValues(1);
    if (draft.ping?.roleId) role.setDefaultRoles(draft.ping.roleId);
    return modal.setTitle('Tag a role').addLabelComponents(
      new LabelBuilder().setLabel('Role').setRoleSelectMenuComponent(role));
  }
  if (kind === 'giveaway' && action === 'text') {
    if (draft.giveawayType === 'wipe') return modal.setTitle('Wipe giveaway text').addComponents(
      input('introTitle', 'Introduction title', draft.introTitle, { maxLength: 150 }),
      input('description', 'Description', draft.description || '', { maxLength: 1000, paragraph: true, required: false }),
      input('requirements', 'Requirements', draft.requirements, { maxLength: 500, paragraph: true, required: false }),
      input('closingText', 'Closing message', draft.closingText, { maxLength: 300, paragraph: true }),
    );
    return modal.setTitle('Giveaway text').addComponents(
      input('introTitle', 'Introduction title', draft.introTitle, { maxLength: 150 }),
      input('description', 'Description', draft.description || '', { maxLength: 1000, paragraph: true, required: false }),
      input('prizes', 'Prize (one per line for random selection)', draft.prizes?.join('\n') || draft.kit, { maxLength: 1200, paragraph: true }),
      input('requirements', 'Requirements', draft.requirements, { maxLength: 500, paragraph: true, required: false }),
      input('closingText', 'Closing message', draft.closingText, { maxLength: 300, paragraph: true }),
    );
  }
  if (kind === 'giveaway' && action === 'claim') {
    if (draft.giveawayType === 'wipe') throw new RangeError('Wipe giveaways do not use claim channels.');
    return modal.setTitle('Winner claim instructions').addComponents(
      input('claimIntroduction', 'Introduction', draft.claimIntroduction || DEFAULT_CLAIM_INTRODUCTION, { maxLength: 250, paragraph: true }),
      input('claimConditions', 'Prize conditions', draft.claimConditions || DEFAULT_CLAIM_CONDITIONS, { maxLength: 1000, paragraph: true }),
      input('claimHowToGet', 'How to get your prize', draft.claimHowToGet || defaultClaimHowToGet(draft), { maxLength: 500, paragraph: true }),
      input('claimReview', 'Share your feedback', draft.claimReview || DEFAULT_CLAIM_REVIEW, { maxLength: 1000, paragraph: true }),
      input('claimPleaseNote', 'Please note', draft.claimPleaseNote || defaultClaimPleaseNote(draft), { maxLength: 1000, paragraph: true }),
    );
  }
  if (kind === 'giveaway' && action === 'timing') {
    return modal.setTitle('Duration & winners').addComponents(
      input('name', 'Saved giveaway name (optional)', draft.name, { maxLength: 64, required: false }),
      input('duration', 'Duration', shortAutomationDuration(draft.durationMinutes), { maxLength: 8 }),
      input('winners', 'Number of winners (1-10)', draft.winnerCount, { maxLength: 2 }),
      ...(draft.giveawayType === 'wipe' ? [] : [input('randomize', 'Randomize prizes (yes/no)', draft.randomize ? 'yes' : 'no', { maxLength: 3 })]),
    );
  }
  if (action === 'media' && kind === 'vote') {
    return modal.addLabelComponents(new LabelBuilder()
      .setLabel('Upload pictures or GIFs')
      .setDescription('Up to 10 per batch. Repeat Add media for 50+ files.')
      .setFileUploadComponent(new FileUploadBuilder()
        .setCustomId('media_files').setRequired(true)
        .setMinValues(1).setMaxValues(10)));
  }
  if (action === 'schedule') {
    if (kind === 'giveaway') {
      if (draft.giveawayType === 'wipe') {
        return modal.addLabelComponents(
          input('server', 'Connected Rust server name', session.scheduleInputs?.server ?? (draft.server === 'Cloudy' ? '' : draft.server), {
            maxLength: 60, description: 'Must match the Rust server connected to wipe events.',
          }),
          input('before', 'Before wipe', session.scheduleInputs?.before ?? shortAutomationDuration(draft.beforeMinutes), {
            maxLength: 8, description: 'How early the giveaway starts. E.g. 1h, 1d, 1w.',
          }),
          input('duration', 'Duration', session.scheduleInputs?.duration ?? shortAutomationDuration(draft.durationMinutes), {
            maxLength: 8, description: 'The giveaway must finish before the wipe.',
          }),
        );
      }
      const local = draft.startAt ? amsterdamParts(draft.startAt) : { date: '', time: '' };
      const savedMode = session.scheduleInputs?.scheduleType || draft.schedule;
      modal.addLabelComponents(
        new LabelBuilder().setLabel('Schedule type')
          .setDescription('Choose Repeat or Once')
          .setStringSelectMenuComponent(new StringSelectMenuBuilder()
            .setCustomId('scheduleType')
            .setPlaceholder('Choose a schedule type')
            .addOptions(
              { label: 'Repeat from a date', value: 'repeat', default: savedMode !== 'once' },
              { label: 'Once on a date', value: 'once', default: savedMode === 'once' },
            )),
        input('date', 'Date', session.scheduleInputs?.date ?? local.date,
          { maxLength: 10, description: 'Future date only.' }),
        input('time', 'Time (EU)', session.scheduleInputs?.time ?? local.time,
          { maxLength: 5, description: '24-hour clock.' }),
        input('repeat', 'Repeat',
          session.scheduleInputs?.repeat ?? shortAutomationDuration(draft.repeatMinutes),
          { maxLength: 8, required: false,
            description: 'Interval between giveaways. E.g. 1m, 1h, 1d, 1w.' }),
      );
    } else if (draft.schedule === 'repeat' || draft.schedule === 'once' || draft.schedule === 'random_weekly') {
      const local = draft.startAt ? amsterdamParts(draft.startAt) : { date: '', time: '' };
      modal.addLabelComponents(
        input('date', 'Date', session.scheduleInputs?.date ?? local.date, {
          maxLength: 10, description: 'Future date only.',
        }),
        input('time', 'Time (EU)', session.scheduleInputs?.time ?? local.time, {
          maxLength: 5, description: '24-hour clock.',
        }),
      );
      if (draft.schedule === 'random_weekly') {
        modal.addLabelComponents(
          input('weeklyMin', 'Minimum posts per week', session.scheduleInputs?.weeklyMin ?? draft.weeklyMin ?? 2,
            { maxLength: 1, description: 'E.g. 2; must be between 1 and 7.' }),
          input('weeklyMax', 'Maximum posts per week', session.scheduleInputs?.weeklyMax ?? draft.weeklyMax ?? 3,
            { maxLength: 1, description: 'E.g. 3; must be at least the minimum.' }),
        );
      }
      if (draft.schedule === 'repeat') {
        modal.addLabelComponents(input('repeat', 'Repeat',
          session.scheduleInputs?.repeat ?? shortAutomationDuration(draft.repeatMinutes), {
            maxLength: 8,
            description: `How often a new ${kind} starts. E.g. 1m, 1h, 1d, 1w.`,
          }));
      }
      if (kind === 'vote') modal.addLabelComponents(input('duration', 'Duration',
        session.scheduleInputs?.duration ?? shortAutomationDuration(draft.durationMinutes), {
          maxLength: 8,
          description: `How long the ${kind} stays open. E.g. 1m, 1h, 1d, 1w.`,
        }));
    } else {
      modal.addLabelComponents(
        input('server', 'Connected Rust server name', session.scheduleInputs?.server ?? (draft.server === 'Cloudy' ? '' : draft.server), {
          maxLength: 60, description: 'The Rust server linked to your wipe schedule.',
        }),
        input('before', 'Before wipe',
          session.scheduleInputs?.before ?? shortAutomationDuration(draft.beforeMinutes), {
            maxLength: 8, description: `How early the ${kind} starts before the wipe. E.g. 10m, 1h, 1d, 1w.`,
          }),
        input('duration', 'Duration',
          session.scheduleInputs?.duration ?? shortAutomationDuration(draft.durationMinutes), {
            maxLength: 8,
            description: `How long the ${kind} stays open. E.g. 1m, 1h, 1d, 1w.`,
          }),
      );
    }
  } else if (kind === 'vote') {
    modal.addComponents(
      input('name', 'Vote name (optional)', draft.name, { maxLength: 64, required: false }),
      input('question', 'Vote question', draft.question, { maxLength: 250 }),
      input('option1', 'First option', draft.maps?.[0], { maxLength: 80 }),
      input('option2', 'Second option', draft.maps?.[1], { maxLength: 80 }),
      input('option3', 'Third option (optional)', draft.maps?.[2], { maxLength: 80, required: false }),
    );
  } else {
    modal.addComponents(
      input('name', 'Giveaway name (optional)', draft.name, { maxLength: 64, required: false }),
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
    if (session.kind === 'giveaway' && session.draft.giveawayType === 'wipe') {
      // Preserve invalid entries so Schedule can be reopened for correction.
      session.scheduleInputs = { server: field(interaction, 'server'),
        before: field(interaction, 'before'), duration: field(interaction, 'duration') };
      const before = parseAutomationDuration(session.scheduleInputs.before, 'Before wipe');
      const duration = parseAutomationDuration(session.scheduleInputs.duration, 'Duration');
      const server = session.scheduleInputs.server;
      if (!server || server.length > 60 || before < 2 || before > 10080 || duration >= before) {
        throw new RangeError('Enter a Rust server and a duration that ends before the wipe.');
      }
      Object.assign(session.draft, { schedule: 'wipe', server, beforeMinutes: before, durationMinutes: duration });
      session.scheduleInputs = null;
    } else if (session.kind === 'giveaway') {
      // Keep invalid fields for corrections; do not save or activate them.
      const scheduleType = interaction.fields.getStringSelectValues('scheduleType')?.[0];
      session.scheduleInputs = {
        scheduleType, date: field(interaction, 'date'),
        time: field(interaction, 'time'), repeat: field(interaction, 'repeat'),
      };
      if (!['repeat', 'once'].includes(scheduleType)) {
        throw new RangeError('Choose Repeat or Once.');
      }
      const startAt = parseAmsterdamStart(session.scheduleInputs.date, session.scheduleInputs.time);
      if (startAt <= Date.now()) throw new RangeError('Choose a future start date and time.');
      if (scheduleType === 'repeat') {
        const repeat = parseAutomationDuration(session.scheduleInputs.repeat, 'Repeat');
        if (repeat < session.draft.durationMinutes) {
          throw new RangeError('Repeat cannot be shorter than Duration.');
        }
        Object.assign(session.draft, { schedule: 'repeat', repeatMinutes: repeat, startAt });
      } else {
        Object.assign(session.draft, { schedule: 'once', startAt });
      }
      session.scheduleInputs = null;
    } else {
    // Keep submitted entries if validation fails so reopening Schedule does not
    // erase what the user typed. Successful submissions clear the draft.
    session.scheduleInputs = Object.fromEntries(
      (session.draft.schedule === 'wipe'
        ? ['server', 'before', 'duration']
        : session.draft.schedule === 'repeat'
          ? (session.kind === 'giveaway' ? ['date', 'time', 'repeat'] : ['date', 'time', 'repeat', 'duration'])
          : session.draft.schedule === 'random_weekly'
            ? ['date', 'time', 'weeklyMin', 'weeklyMax', 'duration']
            : (session.kind === 'giveaway' ? ['date', 'time'] : ['date', 'time', 'duration']))
        .map(id => [id, field(interaction, id)]),
    );
    const duration = session.kind === 'giveaway'
      ? session.draft.durationMinutes : parseAutomationDuration(field(interaction, 'duration'));
    if (session.draft.schedule === 'repeat' || session.draft.schedule === 'once'
      || session.draft.schedule === 'random_weekly') {
      const startAt = parseAmsterdamStart(field(interaction, 'date'), field(interaction, 'time'));
      if (startAt <= Date.now()) throw new RangeError('Choose a future start date and time.');
      if (session.draft.schedule === 'repeat') {
        const repeat = parseAutomationDuration(field(interaction, 'repeat'), 'Repeat');
        if (repeat < duration) {
          throw new RangeError('Repeat cannot be shorter than Duration.');
        }
        Object.assign(session.draft, { repeatMinutes: repeat, durationMinutes: duration, startAt });
      } else if (session.draft.schedule === 'random_weekly') {
        const weeklyMin = Number(field(interaction, 'weeklyMin'));
        const weeklyMax = Number(field(interaction, 'weeklyMax'));
        if (!Number.isInteger(weeklyMin) || !Number.isInteger(weeklyMax)
          || weeklyMin < 1 || weeklyMax > 7 || weeklyMin > weeklyMax) {
          throw new RangeError('Choose 1–7 posts per week, with minimum no greater than maximum.');
        }
        Object.assign(session.draft, { weeklyMin, weeklyMax, durationMinutes: duration, startAt });
      } else {
        Object.assign(session.draft, { durationMinutes: duration, startAt });
      }
    } else {
      const before = parseAutomationDuration(field(interaction, 'before'), 'Before wipe');
      const server = field(interaction, 'server');
      if (!server || before < 2 || before > 10080 || duration >= before) {
        throw new RangeError('Enter a server and choose a duration that finishes before the wipe.');
      }
      Object.assign(session.draft, { server, beforeMinutes: before, durationMinutes: duration });
    }
    session.scheduleInputs = null;
    }
  } else if (session.kind === 'giveaway' && action === 'type') {
    const type = interaction.fields.getStringSelectValues('giveawayType')?.[0];
    if (!['standard', 'wipe'].includes(type)) throw new RangeError('Choose Standard or Rust wipe.');
    if (session.draft.giveawayType !== type) {
      if (session.draft.state === 'running') throw new RangeError('Pause this automation before changing its type.');
      session.draft.giveawayType = type;
      session.draft.schedule = type === 'wipe' ? 'wipe' : 'repeat';
      // A standard giveaway defaults to a 1-day duration and a 2-hour
      // before-wipe offset. That combination can never be saved as a wipe
      // giveaway. Start with a valid interval instead; allow later edits.
      if (type === 'wipe') {
        session.draft.server = '';
        if (session.draft.durationMinutes >= 10080) {
          session.draft.durationMinutes = 1440;
        }
        if (session.draft.beforeMinutes <= session.draft.durationMinutes) {
          session.draft.beforeMinutes = Math.min(10080, session.draft.durationMinutes + 1440);
        }
      }
      session.draft.startAt = null;
      session.draft.nextRunAt = null;
      session.draft.completedAt = null;
      session.draft.randomize = false;
      session.scheduleInputs = null;
    }
  } else if (session.kind === 'giveaway' && action === 'kit') {
    if (session.draft.giveawayType !== 'wipe') throw new RangeError('Kit & role is only for Rust wipe giveaways.');
    const kit = field(interaction, 'kit');
    const roleId = interaction.fields.getField('winnerRole')?.values?.[0];
    if (!kit || kit.length > 150 || !/^\d{17,20}$/.test(roleId || '')) {
      throw new RangeError('Choose a Rust kit name and temporary winner role.');
    }
    Object.assign(session.draft, { kit, prizes: [kit], winnerRoleId: roleId });
  } else if (session.kind === 'giveaway' && action === 'text') {
    const prizes = session.draft.giveawayType === 'wipe'
      ? [session.draft.kit].filter(Boolean)
      : field(interaction, 'prizes').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!prizes.length || prizes.length > 20 || prizes.some(x => x.length > 150)) {
      throw new RangeError('Enter 1–20 prizes, each up to 150 characters.');
    }
    Object.assign(session.draft, {
      kit: prizes[0], prizes, introTitle: giveawayText(field(interaction, 'introTitle'), 150),
      description: giveawayText(field(interaction, 'description'), 1000),
      requirements: giveawayText(field(interaction, 'requirements'), 500),
      closingText: giveawayText(field(interaction, 'closingText'), 300),
    });
  } else if (session.kind === 'giveaway' && action === 'claim') {
    Object.assign(session.draft, {
      claimIntroduction: giveawayText(field(interaction, 'claimIntroduction'), 250),
      claimConditions: giveawayText(field(interaction, 'claimConditions'), 1000),
      claimHowToGet: customClaimHowToGet(giveawayText(field(interaction, 'claimHowToGet'), 500)),
      claimReview: giveawayText(field(interaction, 'claimReview'), 1000),
      claimPleaseNote: customClaimPleaseNote(giveawayText(field(interaction, 'claimPleaseNote'), 1000)),
    });
  } else if (session.kind === 'giveaway' && action === 'timing') {
    const duration = parseAutomationDuration(field(interaction, 'duration'));
    const winnerCount = Number(field(interaction, 'winners'));
    const randomize = session.draft.giveawayType === 'wipe'
      ? 'no' : field(interaction, 'randomize').toLowerCase();
    if (!Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > 10
      || !['yes', 'no'].includes(randomize) || duration > 43200) {
      throw new RangeError('Enter a valid duration, 1–10 winners and yes/no for randomize.');
    }
    if (session.draft.schedule === 'repeat' && duration > session.draft.repeatMinutes) {
      throw new RangeError('Duration cannot exceed Repeat. Change Schedule first.');
    }
    Object.assign(session.draft, {
      name: field(interaction, 'name').slice(0, 64),
      durationMinutes: duration, winnerCount, randomize: randomize === 'yes',
    });
  } else if (session.kind === 'giveaway' && action === 'code') {
    const { codeType, codeDiscount, addedCodes } = readGiveawayCodeModal(interaction);
    Object.assign(session.draft, { codeType, codeDiscount, plainAddedCodes: addedCodes || [] });
  } else if (session.kind === 'giveaway' && action === 'role') {
    const roleId = interaction.fields.getField('role')?.values?.[0];
    if (!roleId) throw new RangeError('Choose a role.');
    session.draft.ping = { type: 'role', roleId };
  } else if (session.kind === 'vote') {
    const name = field(interaction, 'name');
    const question = field(interaction, 'question');
    const maps = [field(interaction, 'option1'), field(interaction, 'option2'),
      field(interaction, 'option3')].filter(Boolean);
    if (!question || maps.length < 2 || new Set(maps.map(x => x.toLowerCase())).size !== maps.length) {
      throw new RangeError('Enter a question and two or three different options.');
    }
    Object.assign(session.draft, { name, question, maps });
  } else {
    const prizes = field(interaction, 'prizes').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const count = Number(field(interaction, 'winners'));
    if (!prizes.length || prizes.length > 20 || prizes.some(x => x.length > 150)
      || !Number.isInteger(count) || count < 1 || count > 10) {
      throw new RangeError('Enter 1–20 prizes (up to 150 characters each) and 1–10 winners.');
    }
    Object.assign(session.draft, {
      name: field(interaction, 'name').slice(0, 64),
      kit: prizes[0], prizes, winnerCount: count, description: field(interaction, 'description'),
    });
  }
  session.dirty = true;
  session.validationError = false;
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
  if (session.kind !== 'giveaway') return;
  if (session.draft.giveawayType !== 'wipe') {
    if (session.draft.ping?.type === 'role') {
      const roleId = session.draft.ping.roleId;
      const role = interaction.guild?.roles?.cache?.get(roleId)
        || await interaction.guild?.roles?.fetch?.(roleId).catch(() => null);
      if (!role || role.id === interaction.guildId) throw new RangeError('Choose a valid tag role.');
    }
    return;
  }
  if (!session.draft.winnerRoleId) throw new RangeError('Choose a temporary winner role in Kit & role.');
  const role = interaction.guild?.roles?.cache?.get(session.draft.winnerRoleId)
    || await interaction.guild?.roles?.fetch?.(session.draft.winnerRoleId).catch(() => null);
  if (!role || role.managed || role.id === interaction.guildId
    || !botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)
    || !botMember.roles?.highest || botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new RangeError('Choose a manageable winner role below Cloudy’s highest role.');
  }
}

async function saveSession(interaction, session) {
  if (session.scheduleInputs || session.validationError) throw new RangeError('Correct the information first.');
  await validateDestination(interaction, session);
  if (session.draft.schedule !== 'wipe' && !session.draft.startAt) {
    throw new RangeError('Set a future start date and time in Schedule before saving.');
  }
  // Save configuration only; Start/Pause/Stop remain separate actions.
  // Editing an active automation must not stop it as a side effect.
  const previousState = session.draft.state;
  let stored;
  if (session.selectedJobId !== 'legacy') {
    const saveJob = session.kind === 'vote' ? saveAutomaticVoteJob : saveAutomaticGiveawayJob;
    stored = await saveJob(interaction.client, session.guildId, session.draft, session.selectedJobId);
    session.selectedJobId = stored.id;
  } else {
    await configureWipeAutomation(interaction.client, session.guildId, session.kind, session.draft);
    stored = previousState === 'running' || previousState === 'paused'
      ? await setWipeAutomationState(interaction.client, session.guildId, session.kind, previousState)
      : (await getWipeAutomationConfig(interaction.client, session.guildId))[session.kind];
  }
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
  const id = randomUUID().slice(0, 12);
  const session = {
    id, kind, guildId: interaction.guildId, userId: interaction.user.id,
    botId: interaction.client?.user?.id,
    draft: { ...baseDraft(kind, null), ...(kind === 'giveaway' ? { hostId: interaction.user.id } : {}) }, dirty: false, saved: false,
    view: 'home', selectedJobId: null,
    notice: '', expiresAt: Date.now() + SESSION_MS,
  };
  sessions.set(id, session);
  const jobs = kind === 'vote'
    ? await listAutomaticVotes(interaction.client, interaction.guildId)
    : await listAutomaticGiveaways(interaction.client, interaction.guildId);
  return interaction.reply({ ...formatAutomaticVoteHome(session, jobs), flags: MessageFlags.Ephemeral });
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
    const listJobs = () => session.kind === 'vote'
      ? listAutomaticVotes(interaction.client, session.guildId)
      : listAutomaticGiveaways(interaction.client, session.guildId);
    if (['new', 'manage', 'list', 'refresh', 'back', 'select'].includes(action)) {
      if (action === 'new') {
        session.view = 'editor';
        session.draft = { ...baseDraft(session.kind, null),
          ...(session.kind === 'giveaway' ? { hostId: session.userId } : {}) };
        session.selectedJobId = null;
        session.scheduleInputs = null;
        session.validationError = false;
        session.dirty = false;
        session.saved = false;
        session.confirmDelete = false;
        await interaction.update(formatAutomationDashboard(session));
        return true;
      }
      if (action === 'back') {
        session.view = 'home';
        session.dirty = false;
        session.confirmDelete = false;
        await interaction.update(formatAutomaticVoteHome(session, await listJobs()));
        return true;
      }
      if (['manage', 'list', 'refresh'].includes(action)) {
        session.view = 'list';
        session.confirmDelete = false;
        session.dirty = false;
        await interaction.update(formatAutomaticVotesList(session, await listJobs()));
        return true;
      }
      const jobs = await listJobs();
      const choice = jobs.find(job => job.id === interaction.values?.[0]);
      if (!choice) throw new RangeError('This saved automation is no longer available. Refresh the list.');
      session.view = 'editor';
      session.selectedJobId = choice.id;
      session.draft = baseDraft(session.kind, choice);
      session.scheduleInputs = null;
      session.validationError = false;
      session.dirty = false;
      session.saved = true;
      session.confirmDelete = false;
      await interaction.update(formatAutomationDashboard(session));
      return true;
    }
    if (action === 'delete') {
      if (!session.selectedJobId) throw new RangeError('Select a saved automation first.');
      if (!session.confirmDelete) {
        session.confirmDelete = true;
        session.notice = `Press Confirm delete again to permanently delete this automatic ${session.kind}.`;
        await interaction.update(formatAutomationDashboard(session));
        return true;
      }
      await interaction.deferUpdate();
      const deleteJob = session.kind === 'vote' ? deleteAutomaticVoteJob : deleteAutomaticGiveawayJob;
      await deleteJob(interaction.client, session.guildId, session.selectedJobId);
      session.selectedJobId = null;
      session.view = 'list';
      session.saved = false;
      session.dirty = false;
      session.confirmDelete = false;
      session.notice = `Automatic ${session.kind} deleted.`;
      await interaction.editReply(formatAutomaticVotesList(session, await listJobs()));
      return true;
    }
    session.confirmDelete = false;
    if (action === 'media' && interaction.isModalSubmit?.()) {
      if (session.kind !== 'vote' || Number(parts[2]) !== session.mediaModalCounter) {
        throw new RangeError('This media upload is outdated. Open Add media again.');
      }
      const uploaded = [...(interaction.fields.getUploadedFiles('media_files')?.values?.() || [])];
      const current = session.draft.mediaLibrary || [];
      if (!uploaded.length || uploaded.length > 10 || current.length + uploaded.length > 500) {
        throw new RangeError('Upload 1–10 files at a time, up to 500 saved files.');
      }
      for (const file of uploaded) {
        if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(String(file.contentType || ''))
          || file.size > 10 * 1024 * 1024 || file.size < 1) {
          throw new RangeError('Only PNG, JPG, GIF or WebP images up to 10 MB are supported.');
        }
      }
      await interaction.deferUpdate();
      const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
      const files = await Promise.all(uploaded.map(async (file, index) => {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error('An uploaded picture could not be downloaded.');
        return { attachment: Buffer.from(await response.arrayBuffer()),
          name: `automedia_${randomUUID().slice(0, 8)}_${index}.${extensions[file.contentType.toLowerCase()]}` };
      }));
      const stored = await uploadVotePictures(interaction.client, interaction.guild,
        interaction.channel, files);
      const added = stored.media.names.map(name => ({
        channelId: stored.media.channelId, messageId: stored.media.messageId, name,
      }));
      session.draft.mediaLibrary = [...current, ...added];
      session.dirty = true;
      session.notice = `${added.length} pictures added. Total: ${session.draft.mediaLibrary.length}.`;
      session.validationError = false;
      await interaction.editReply(formatAutomationDashboard(session));
      return true;
    }
    if (action === 'modal' && interaction.isModalSubmit?.()) {
      if (parts[2] === 'schedule' && parts[3]
        && (parts[3] !== session.draft.schedule
          || Number(parts[4]) !== session.scheduleModalCounter)) {
        throw new RangeError('This Schedule form is outdated. Open Schedule again.');
      }
      applyModal(session, interaction, parts[2]);
      await interaction.update(formatAutomationDashboard(session));
      return true;
    }
    if (action === 'details' || action === 'schedule'
      || (session.kind === 'giveaway' && ['type', 'text', 'kit', 'claim', 'timing', 'code'].includes(action)
        && (session.draft.giveawayType !== 'wipe' || !['claim', 'code'].includes(action)))
      || (action === 'media' && session.kind === 'vote')) {
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
      session.validationError = false;
    } else if (action === 'role' && interaction.isRoleSelectMenu?.()) {
      if (session.kind !== 'giveaway') return true;
      session.draft.winnerRoleId = interaction.values?.[0] || '';
      session.dirty = true;
    } else if (action === 'tag' && session.kind === 'giveaway' && interaction.isStringSelectMenu?.()) {
      const type = interaction.values?.[0];
      if (type === 'role') {
        await interaction.showModal(buildAutomationModal(session, 'role'));
        return true;
      }
      if (type !== 'everyone' && type !== 'none') return true;
      session.draft.ping = { type, roleId: null };
      session.dirty = true;
      session.validationError = false;
    } else if (action === 'mode' && interaction.isStringSelectMenu?.()) {
      const mode = interaction.values?.[0];
      if (!(session.kind === 'vote' ? ['once', 'repeat', 'wipe'] : ['once', 'repeat']).includes(mode)) return true;
      if (session.draft.schedule !== mode) {
        session.scheduleInputs = null;
        session.validationError = false;
      }
      session.draft.schedule = mode;
      session.dirty = true;
    } else if (action === 'clear_media' && session.kind === 'vote') {
      if (!session.confirmClearMedia) {
        session.confirmClearMedia = true;
        session.notice = 'Click Confirm clear to remove all media from this vote.';
      } else {
        session.draft.mediaLibrary = [];
        session.confirmClearMedia = false;
        session.dirty = true;
        session.notice = 'Media list cleared. Save to keep this change.';
      }
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
      if (action === 'start' && (session.scheduleInputs || session.validationError)) {
        throw new RangeError('Correct the information in Schedule first.');
      }
      if (session.dirty || !session.saved) {
        throw new RangeError('Save your settings before starting or pausing.');
      }
      if (action === 'start' && session.draft.state === 'running') return true;
      if (action === 'pause' && session.draft.state !== 'running') return true;
      const state = action === 'start' ? 'running' : 'paused';
      const stateJob = session.kind === 'vote' ? setAutomaticVoteJobState : setAutomaticGiveawayJobState;
      const stored = session.selectedJobId !== 'legacy'
        ? await stateJob(interaction.client, session.guildId, session.selectedJobId, state)
        : await setWipeAutomationState(interaction.client, session.guildId, session.kind, state);
      session.draft = baseDraft(session.kind, stored);
      await interaction.editReply(formatAutomationDashboard(session));
      return true;
    } else if (action === 'stop') {
      await interaction.deferUpdate();
      const stateJob = session.kind === 'vote' ? setAutomaticVoteJobState : setAutomaticGiveawayJobState;
      const stored = session.selectedJobId !== 'legacy'
        ? await stateJob(interaction.client, session.guildId, session.selectedJobId, 'stopped')
        : await setWipeAutomationState(interaction.client, session.guildId, session.kind, 'stopped');
      session.draft = session.dirty
        ? { ...session.draft, state: 'stopped' } : baseDraft(session.kind, stored);
      await interaction.editReply(formatAutomationDashboard(session));
      return true;
    } else return true;
    await interaction.update(formatAutomationDashboard(session));
  } catch (error) {
    session.validationError = true;
    session.notice = error instanceof RangeError ? error.message : 'Automation could not be updated.';
    if (!(error instanceof RangeError)) logger.warn('[AUTO_BUILDER] Unexpected dashboard error:', error);
    const jobs = session.kind === 'vote'
      ? await listAutomaticVotes(interaction.client, session.guildId)
      : await listAutomaticGiveaways(interaction.client, session.guildId);
    const payload = session.view === 'list'
      ? formatAutomaticVotesList(session, jobs)
      : session.view === 'home'
        ? formatAutomaticVoteHome(session, jobs)
        : formatAutomationDashboard(session);
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