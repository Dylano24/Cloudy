// /votemanage (owner's choice, like /giveaway manage): private and for staff.
// Choose a status (Active votes / Ended votes), then a vote: End an open vote
// or Delete it (with confirm). The panel follows the five-minute dashboard
// rule (vmanage_ ids, interactionMessageLifecycle.js); a result or warning
// replaces it and disappears after 10 seconds.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder,
} from 'discord.js';
import { successEmbed, warningEmbed } from '../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../utils/embedColorPolicy.js';
import { registerPendingDelete, unregisterPendingDelete } from '../utils/pendingTransientDeletes.js';
import {
  CLOUDY_C_LOGO_URL, deleteVote, endVoteNow, forgetDeletedVotes, guildVotes, isVoteOpen, loadVote, voteCounts, voteNumberIcon,
} from './voteService.js';

export const VOTE_MANAGE_PAGE_SIZE = 25;
// Discord waits 3 seconds for the answer.
const ANSWER_WITHIN_MS = 2_000;
const STATUSES = Object.freeze({ active: 'Active votes', ended: 'Ended votes' });
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const unix = ms => Math.floor(ms / 1000);
const warning = text => setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR);
const statusOf = vote => (isVoteOpen(vote) ? 'active' : 'ended');
const totalOf = vote => voteCounts(vote).reduce((sum, count) => sum + count, 0);
const panel = { title: 'Manage vote', color: 0xFFFFFF, thumbnail: { url: CLOUDY_C_LOGO_URL } };
const wait = ms => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
});

// Unknown Channel / Unknown Message: the vote's message is gone from Discord.
const GONE = new Set([10003, 10008]);

// Whether a vote's message was deleted in Discord. When it cannot be checked
// (no access, Discord busy) the vote stays listed: it is never forgotten by guess.
async function voteMessageGone(guild, vote) {
  let channel = guild?.channels?.cache?.get?.(vote.channelId);
  if (!channel) {
    if (!guild?.channels?.fetch) return false;
    try {
      channel = await guild.channels.fetch(vote.channelId);
    } catch (error) {
      return GONE.has(error?.code);
    }
    if (!channel) return true;
  }
  if (channel.messages?.cache?.has?.(vote.messageId)) return false;
  if (!channel.messages?.fetch) return false;
  try {
    return !await channel.messages.fetch(vote.messageId);
  } catch (error) {
    return GONE.has(error?.code);
  }
}

// Only votes that are still in a channel (owner's choice, like Manage
// giveaway): a vote deleted in Discord, also while Cloudy was offline, is
// forgotten here instead of being listed as Active or Ended.
async function votesInChannels(client, guild) {
  const votes = await guildVotes(client, guild.id);
  const gone = new Set();
  let cursor = 0;
  const worker = async () => {
    while (cursor < votes.length) {
      const vote = votes[cursor++];
      if (await voteMessageGone(guild, vote)) gone.add(vote.messageId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, votes.length) }, worker));
  if (gone.size) await forgetDeletedVotes(client, guild.id, { messageIds: [...gone] });
  return votes.filter(vote => !gone.has(vote.messageId));
}

// The status picker stays on top, so the other status is one choice away.
function statusPicker(votes, requesterId, status) {
  const active = votes.filter(vote => isVoteOpen(vote)).length;
  const counts = { active, ended: votes.length - active };
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`vmanage_status:${requesterId}`)
    .setPlaceholder('Choose a status')
    .addOptions(Object.entries(STATUSES).map(([value, label]) => ({
      label, value, description: plural(counts[value], 'vote'), default: value === status,
    }))));
}

export function buildVoteManagePicker(votes, guild, requesterId, requestedPage = 0, status = null) {
  if (!votes.length) {
    return { embeds: [{ ...panel, description: 'There are no votes to manage in this server.' }], components: [] };
  }
  if (!Object.hasOwn(STATUSES, status || '')) {
    const active = votes.filter(vote => isVoteOpen(vote)).length;
    return {
      embeds: [{ ...panel, description: `Choose a vote status.\n\n${active} active · ${votes.length - active} ended` }],
      components: [statusPicker(votes, requesterId, null)],
    };
  }
  const filtered = votes.filter(vote => statusOf(vote) === status);
  const pageCount = Math.max(1, Math.ceil(filtered.length / VOTE_MANAGE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  const shown = filtered.slice(page * VOTE_MANAGE_PAGE_SIZE, (page + 1) * VOTE_MANAGE_PAGE_SIZE);
  const components = [statusPicker(votes, requesterId, status)];
  if (!shown.length) return { embeds: [{ ...panel, description: `There are no ${status} votes.` }], components };
  components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`vmanage_vote:${requesterId}`)
    .setPlaceholder('Choose a vote')
    .addOptions(shown.map(vote => {
      const channel = guild?.channels?.cache?.get?.(vote.channelId)?.name;
      const when = vote.endedAt || vote.endsAt || Date.parse(vote.createdAt) || null;
      return {
        label: String(vote.question || 'Vote').slice(0, 100),
        description: [
          status === 'active' ? 'Active' : 'Ended',
          channel ? `#${channel}` : null,
          plural(totalOf(vote), 'vote'),
          when ? new Date(when).toLocaleDateString('en-GB') : null,
        ].filter(Boolean).join(' · ').slice(0, 100),
        value: vote.messageId,
      };
    }))));
  if (pageCount > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`vmanage_page:${requesterId}:${status}:${page - 1}`)
        .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`vmanage_page:${requesterId}:${status}:${page + 1}`)
        .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1),
    ));
  }
  return {
    embeds: [{ ...panel, description: `Select a vote to manage.\n\n${plural(filtered.length, `${status} vote`)} · Page ${page + 1}/${pageCount}` }],
    components,
  };
}

const actionButton = (vote, requesterId, action, label, style) => new ButtonBuilder()
  .setCustomId(`vmanage_btn:${action}:${requesterId}:${vote.messageId}`)
  .setLabel(label)
  .setStyle(style);

// One empty line between the sections, like the giveaway Manage panel.
export function buildVoteManagePanel(vote, requesterId) {
  const counts = voteCounts(vote);
  const open = isVoteOpen(vote);
  return {
    embeds: [{
      ...panel,
      description: [
        `**${vote.question}**`,
        vote.options.map((option, index) => `${voteNumberIcon(index)} **${option}** · ${plural(counts[index], 'vote')}`).join('\n'),
        `${plural(totalOf(vote), 'vote')} · <#${vote.channelId}>`,
        open
          ? (vote.endsAt ? `Ends <t:${unix(vote.endsAt)}:F> (<t:${unix(vote.endsAt)}:R>)` : 'This vote has no end time.')
          : 'This vote has ended.',
      ].join('\n\n'),
    }],
    // Discord has no yellow button, so End is red, as for giveaways.
    components: [new ActionRowBuilder().addComponents(
      ...(open ? [actionButton(vote, requesterId, 'end', 'End', ButtonStyle.Danger)] : []),
      actionButton(vote, requesterId, 'delete', 'Delete', ButtonStyle.Danger),
      actionButton(vote, requesterId, 'back', 'Back', ButtonStyle.Secondary),
    )],
  };
}

export function buildVoteDeleteConfirmation(vote, requesterId) {
  return {
    embeds: [{
      ...panel,
      title: 'Delete vote?',
      description: `The vote **${vote.question}** and its message will be removed. This cannot be undone.`,
    }],
    components: [new ActionRowBuilder().addComponents(
      actionButton(vote, requesterId, 'confirmdelete', 'Delete vote', ButtonStyle.Danger),
      actionButton(vote, requesterId, 'panel', 'Cancel', ButtonStyle.Secondary),
    )],
  };
}

// Short replies disappear after exactly 10 seconds; a restart removes them at once.
function removeAfterTenSeconds(interaction) {
  const key = `vote-manage:${interaction.id}`;
  const remove = () => interaction.deleteReply().catch(() => {});
  const timer = setTimeout(() => { unregisterPendingDelete(key); void remove(); }, 10_000);
  timer.unref?.();
  registerPendingDelete(key, remove);
}

async function show(interaction, payload) {
  await interaction.editReply(payload);
  if (!payload.components?.length) removeAfterTenSeconds(interaction);
}

const done = (interaction, embed) => show(interaction, { embeds: [embed], components: [] });
const canManage = interaction => Boolean(interaction.inGuild?.()
  && interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));

// Only the staff member who opened it can use it.
async function allowed(interaction, requesterId = interaction.user.id) {
  if (canManage(interaction) && interaction.user.id === requesterId) return true;
  await interaction.reply({ embeds: [warning('Only staff with Manage Server can manage votes.')], flags: MessageFlags.Ephemeral });
  removeAfterTenSeconds(interaction);
  return false;
}

/** /votemanage: the private status picker, answered in one step when ready within 2 seconds. */
export async function openVoteManager(interaction) {
  if (!await allowed(interaction)) return;
  const loading = votesInChannels(interaction.client, interaction.guild)
    .then(votes => buildVoteManagePicker(votes, interaction.guild, interaction.user.id))
    .catch(() => ({ embeds: [warning('Votes could not be loaded. Please try again.')], components: [] }));
  let payload = await Promise.race([loading, wait(ANSWER_WITHIN_MS)]);
  if (payload) {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    payload = await loading;
    await interaction.editReply(payload);
  }
  if (!payload.components.length) removeAfterTenSeconds(interaction);
}

// vmanage_status:<requester> (select): Active votes or Ended votes.
export async function chooseVoteStatus(interaction, client, [requesterId] = []) {
  if (!await allowed(interaction, requesterId)) return;
  await interaction.deferUpdate();
  const votes = await votesInChannels(client || interaction.client, interaction.guild);
  return show(interaction, buildVoteManagePicker(votes, interaction.guild, requesterId, 0, interaction.values?.[0]));
}

// vmanage_page:<requester>:<status>:<page> (Previous / Next).
export async function turnVoteManagePage(interaction, client, [requesterId, status, page] = []) {
  if (!await allowed(interaction, requesterId)) return;
  await interaction.deferUpdate();
  const votes = await votesInChannels(client || interaction.client, interaction.guild);
  return show(interaction, buildVoteManagePicker(votes, interaction.guild, requesterId, Number(page), status));
}

// vmanage_vote:<requester> (select): opens the chosen vote.
export async function chooseVoteToManage(interaction, client, [requesterId] = []) {
  if (!await allowed(interaction, requesterId)) return;
  await interaction.deferUpdate();
  const bot = client || interaction.client;
  const vote = await loadVote(bot, interaction.guildId, String(interaction.values?.[0] || ''));
  // A vote deleted in Discord meanwhile is forgotten and the list shown again.
  if (!vote || await voteMessageGone(interaction.guild, vote)) {
    if (vote) await forgetDeletedVotes(bot, interaction.guildId, { messageIds: [vote.messageId] });
    return show(interaction, buildVoteManagePicker(await votesInChannels(bot, interaction.guild), interaction.guild, requesterId));
  }
  return show(interaction, buildVoteManagePanel(vote, requesterId));
}

// vmanage_btn:<action>:<requester>:<vote message>: End, Delete (with confirm), Back.
export async function voteManageAction(interaction, client, [action, requesterId, messageId] = []) {
  if (!await allowed(interaction, requesterId)) return;
  const bot = client || interaction.client;
  // Acknowledged before any database work.
  await interaction.deferUpdate();
  const vote = await loadVote(bot, interaction.guildId, messageId);
  if (!vote) return done(interaction, warning('This vote no longer exists.'));
  if (action === 'panel') return show(interaction, buildVoteManagePanel(vote, requesterId));
  if (action === 'delete') return show(interaction, buildVoteDeleteConfirmation(vote, requesterId));
  if (action === 'back') {
    return show(interaction, buildVoteManagePicker(await votesInChannels(bot, interaction.guild), interaction.guild, requesterId, 0, statusOf(vote)));
  }
  if (action === 'confirmdelete') {
    await deleteVote(bot, interaction.guild, messageId, { deletedBy: interaction.user });
    return done(interaction, successEmbed('Success', 'The vote was deleted.'));
  }
  if (action === 'end') {
    const result = await endVoteNow(bot, interaction.guild, messageId);
    if (result.status !== 'ended') return show(interaction, buildVoteManagePanel(await loadVote(bot, interaction.guildId, messageId) || vote, requesterId));
    return done(interaction, successEmbed('Success', 'The vote has ended.'));
  }
  return done(interaction, warning('This option is no longer available.'));
}
