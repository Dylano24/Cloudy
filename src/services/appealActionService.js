import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';
import { logger, startupLog } from '../utils/logger.js';
import { appealReviewKey, appealActions, buildAppealActions } from './appealPresentationService.js';
import { resolveDiscordAppealIdentity } from './appealIdentityService.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { CLOUDY_STANDARD_FOOTER } from '../utils/cloudyFooter.js';
export { appealReviewKey, buildAppealActions } from './appealPresentationService.js';

const HANDLED_NOTICE = /\s*\*\*This appeal has been handled\*\*(?:\s*\*\*Staff decision\*\*\n([\s\S]*?))?\s*$/;

// A handled appeal shows Handled at (date and time, as reports do) right
// before Staff decision. The older bold "This appeal has been handled" line,
// sometimes with Staff decision merged into it, is unfolded into fields.
export function handledAppealFields(fields, handledAt) {
  const result = [];
  for (const field of fields || []) {
    if (/^This appeal has been handled$/i.test(String(field.name || '').replace(/\*+/g, '').trim())) continue;
    if (field.name === 'Handled at') continue;
    const value = String(field.value || '');
    const notice = value.match(HANDLED_NOTICE);
    if (!notice) { result.push(field); continue; }
    result.push({ ...field, value: value.slice(0, notice.index) || '\u200B' });
    if (notice[1] !== undefined) result.push({ name: 'Staff decision', value: notice[1], inline: false });
  }
  const handled = { name: 'Handled at', value: `<t:${Math.floor(handledAt / 1000)}:F>`, inline: false };
  const decision = result.findIndex(field => field.name === 'Staff decision');
  if (decision === -1) result.push(handled);
  else result.splice(decision, 0, handled);
  return result;
}

const active = new Set();
export function appealStaffAllowed(guild, member, action, config = {}) {
  const staffId = config.ticketStaffRoleId || guild.roles?.cache?.find(role => role.name.trim().toLowerCase() === 'staff')?.id;
  return member?.id === guild.ownerId || hasCloudyOwnerMember(member) || Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator))
    || Boolean(staffId && member?.roles?.cache?.has(staffId))
    || Boolean(member?.permissions?.has(action === 'unban' ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.ModerateMembers));
}

export function buildAppealReasonModal(record, action) {
  const modal = new ModalBuilder().setCustomId(`appeal_decide:${action}:${record.id}`).setTitle(`${action === 'deny' ? 'Deny' : action === 'unmute' ? 'Unmute' : 'Unban'} appeal`);
  if (record.scope === 'discord' && action !== 'deny') {
    const input = new TextInputBuilder().setCustomId('target').setLabel('Discord username / ID').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(100);
    const identity = String(record.discordIdentity || '').trim();
    if (identity) input.setValue(identity.slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(512)));
}

async function authorized(interaction, client, action, id, { fresh = true } = {}) {
  if (!interaction.inGuild() || !['unmute', 'unban', 'deny'].includes(action)) throw new Error('This appeal is unavailable.');
  const record = await client.db.get(appealReviewKey(interaction.guildId, id));
  if (!record || record.guildId !== interaction.guildId || record.channelId !== interaction.channelId || !appealActions(record).includes(action)) throw new Error('This appeal is unavailable.');
  const member = !fresh && interaction.member?.id === interaction.user.id && interaction.member.roles?.cache
    ? interaction.member : await interaction.guild.members.fetch(interaction.user.id);
  const config = await getGuildConfig(client, interaction.guildId);
  if (!appealStaffAllowed(interaction.guild, member, action, config)) throw new Error('Only the staff team can review appeals.');
  if (record.status !== 'pending') throw new Error('This appeal has already been reviewed or is being processed.');
  const message = !fresh && interaction.message?.id === record.messageId
    ? interaction.message : await interaction.channel.messages.fetch(record.messageId);
  if (message.author?.id !== client.user.id || !message.components.some(row => row.components.some(button => button.customId === `appeal_action:${action}:${id}`))) throw new Error('This appeal is unavailable.');
  return { record, message, member };
}

async function respond(interaction, content) {
  return InteractionHelper.universalReply(interaction, { content: `Error: ${content}`, flags: MessageFlags.Ephemeral });
}

export async function handleAppealAction(interaction, client, [action, id]) {
  try {
    const { record } = await authorized(interaction, client, action, id, { fresh: false });
    if (interaction.message?.id !== record.messageId) throw new Error('This appeal is unavailable.');
    if (record.scope === 'rust' && action === 'unban') throw new Error('Rust unban is not connected yet.');
    // Resolve usernames only after the modal has been submitted and deferred.
    // Member/ban lookups must not consume the button's three-second response window.
    await interaction.showModal(buildAppealReasonModal(record, action));
  } catch (error) { await respond(interaction, error.message); }
}

export async function executeAppealDecision({ client, guild, member, record, action, reason, targetId }) {
  reason = String(reason || '').trim();
  if (!reason || reason.length > 512) throw new Error('A reason between 1 and 512 characters is required.');
  if (!appealActions(record).includes(action) || record.status !== 'pending') throw new Error('This appeal cannot be reviewed.');
  if (record.scope === 'rust' && action === 'unban') throw new Error('Rust unban is not connected yet.');
  if (action !== 'deny') {
    if (record.discordIdentity) {
      const resolvedId = await resolveDiscordAppealIdentity(guild, record.discordIdentity, { includeBans: action === 'unban' });
      const submittedTarget = targetId && targetId !== record.discordIdentity ? await resolveDiscordAppealIdentity(guild, targetId, { includeBans: action === 'unban' }) : resolvedId;
      if (submittedTarget !== resolvedId) throw new Error('The user ID must match this appeal.');
      targetId = resolvedId;
    }
    if (!/^\d{17,20}$/.test(targetId || '')) throw new Error('Enter the correct Discord user ID.');
    const submittedId = String(record.discordIdentity || '').match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];
    if (submittedId && submittedId !== targetId) throw new Error('The user ID must match this appeal.');
  }
  const key = appealReviewKey(record.guildId, record.id);
  if (active.has(key)) throw new Error('This appeal is already being processed.');
  active.add(key);
  try {
    const latest = await client.db.get(key);
    if (latest?.status !== 'pending') throw new Error('This appeal has already been reviewed.');
    const processing = { ...record, status: 'processing', decision: action, reason, moderatorId: member.id, targetId, reviewedAt: new Date().toISOString() };
    if (await client.db.set(key, processing) === false) throw new Error('The appeal could not be saved.');
    try {
      if (action === 'unmute') {
        const { ModerationService } = await import('./moderation/moderationService.js');
        const target = await guild.members.fetch(targetId);
        await ModerationService.removeTimeoutUser({ guild, member: target, moderator: member, reason });
      } else if (action === 'unban') {
        const { ModerationService } = await import('./moderation/moderationService.js');
        const user = await client.users.fetch(targetId);
        await ModerationService.unbanUser({ guild, user, moderator: member, reason });
      }
    } catch (error) {
      await client.db.set(key, record);
      throw error;
    }
    const decided = { ...processing, status: action === 'deny' ? 'denied' : 'approved' };
    if (await client.db.set(key, decided) === false) throw new Error('The action completed, but saving the review failed. Do not repeat the action.');
    return decided;
  } finally { active.delete(key); }
}

export async function handleAppealDecision(interaction, client, [action, id]) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { record, message, member } = await authorized(interaction, client, action, id);
    const decision = await executeAppealDecision({ client, guild: interaction.guild, member, record, action,
      reason: interaction.fields.getTextInputValue('reason'), targetId: action !== 'deny' && record.scope === 'discord' ? interaction.fields.getTextInputValue('target').trim() : undefined });
    const embeds = message.embeds.map((embed, index) => {
      const data = embed.toJSON();
      if (index === 0) {
        data.color = 0x00C49D;
        data.fields = handledAppealFields([
          ...(data.fields || []),
          { name: 'Staff decision', value: `${action === 'deny' ? 'Denied' : action === 'unmute' ? 'Unmuted' : 'Unbanned'} by <@${member.id}>` },
          { name: 'Reason', value: decision.reason },
        ], Date.parse(decision.reviewedAt) || Date.now());
      }
      return data;
    });
    // A completed appeal is final: remove its action row instead of disabling it.
    await message.edit({ embeds, components: [], allowedMentions: { parse: [] } });
    await InteractionHelper.safeEditReply(interaction, { content: 'Success. The appeal has been reviewed.' });
  } catch (error) {
    logger.warn(`Appeal review failed: ${error.message}`);
    await InteractionHelper.safeEditReply(interaction, { content: `Error: ${error.message}` });
  }
}

export async function ensureAppealActions(client) {
  const channel = await resolveCloudyChannel(client, 'banTimeoutAppeals', { textOnly: true });
  if (!channel) return;
  const messages = await channel.messages.fetch({ limit: 100 });
  let restored = 0, updated = 0;
  for (const message of messages.values()) {
    const embed = message.embeds[0];
    const match = embed?.title?.match(/^(Discord|Rust server) appeal(?:\s*[—-]\s*|\s+)(Mute|Ban|Other)$/i);
    const id = embed?.description?.match(/\b(CLD-[A-Z0-9-]+)\b/)?.[1]
      || embed?.footer?.text?.match(/Cloudy Inc\. • (CLD-[A-Z0-9-]+)$/)?.[1];
    if (message.author?.id !== client.user.id || !match || !id) continue;
    const key = appealReviewKey(channel.guild.id, id);
    let record = await client.db.get(key);
    if (!record) {
      record = { id, guildId: channel.guild.id, channelId: channel.id, messageId: message.id, scope: match[1] === 'Discord' ? 'discord' : 'rust', action: match[2], status: 'pending',
        discordIdentity: embed.fields.find(field => field.name === 'Discord username / ID')?.value || '', gamertag: embed.fields.find(field => field.name === 'Gamertag')?.value || '' };
      await client.db.set(key, record);
    }
    // Existing appeals get the normal Cloudy footer and, once handled, the
    // Handled at line from their saved review time (never a guessed time).
    const handledAt = ['approved', 'denied'].includes(record.status) ? Date.parse(record.reviewedAt) : NaN;
    const presentationEmbeds = message.embeds.map((existing, index) => {
      const data = existing.toJSON();
      data.footer = { text: CLOUDY_STANDARD_FOOTER };
      delete data.timestamp;
      if (index === 0 && Number.isFinite(handledAt)) data.fields = handledAppealFields(data.fields, handledAt);
      return data;
    });
    const presentationChanged = JSON.stringify(presentationEmbeds) !== JSON.stringify(message.embeds.map(existing => existing.toJSON()));
    if (presentationChanged) updated++;
    const hasAppealActions = message.components.some(row => row.components.some(button => button.customId?.startsWith('appeal_action:')));
    // Restart recovery must never resurrect a completed appeal's disabled controls.
    if (record.status !== 'pending') {
      if (hasAppealActions || presentationChanged) {
        await message.edit({ ...(presentationChanged ? { embeds: presentationEmbeds } : {}), ...(hasAppealActions ? { components: [] } : {}) });
        if (hasAppealActions) restored++;
      }
      continue;
    }
    if (!hasAppealActions || presentationChanged) {
      await message.edit({ ...(presentationChanged ? { embeds: presentationEmbeds } : {}), ...(!hasAppealActions ? { components: buildAppealActions(record) } : {}) });
      if (!hasAppealActions) restored++;
    }
  }
  startupLog(`Appeal action buttons ready; ${restored} existing appeals linked; ${updated} appeal layouts updated.`);
}

