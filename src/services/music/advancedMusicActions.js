import { PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildMusicData } from './playerStore.js';
import { getPlayer, assertCanControl } from './musicActions.js';
import { refreshPlayerMessage } from './playerHandler.js';
import {
  hydrateMusicPolicy,
  setMusicPermissionMode,
  setMusicSessionLocked,
  addDjRole,
  removeDjRole,
  setUserMusicOverride,
  getMusicPolicySummary,
} from './musicSessionService.js';

const FILTER_PRESETS = {
  off: null,
  bassboost: {
    equalizer: [
      { band: 0, gain: 0.25 }, { band: 1, gain: 0.2 }, { band: 2, gain: 0.15 },
      { band: 3, gain: 0.1 }, { band: 4, gain: 0.05 },
    ],
  },
  nightcore: { timescale: { speed: 1.15, pitch: 1.2, rate: 1.0 } },
  vaporwave: { timescale: { speed: 0.85, pitch: 0.8, rate: 1.0 } },
  karaoke: { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220, filterWidth: 100 } },
  tremolo: { tremolo: { frequency: 4.0, depth: 0.75 } },
  vibrato: { vibrato: { frequency: 4.0, depth: 0.5 } },
  '8d': { rotation: { rotationHz: 0.2 } },
  lowpass: { lowPass: { smoothing: 20.0 } },
};

export const MUSIC_FILTER_NAMES = Object.keys(FILTER_PRESETS);

function requirePlayer(client, interaction) {
  const player = getPlayer(client, interaction.guild.id);
  if (!player) {
    throw new TitanBotError('No player', ErrorTypes.USER_INPUT, 'No active music player.');
  }
  assertCanControl(interaction.member, player);
  return player;
}

export async function toggleAutoplay(client, interaction, enabled) {
  await hydrateMusicPolicy(client, interaction.guild.id);
  const player = requirePlayer(client, interaction);
  const guildData = getGuildMusicData(interaction.guild.id);
  guildData.autoplay = Boolean(enabled);

  if (guildData.autoplay && !player.current && !player.queue?.length) {
    throw new TitanBotError(
      'Autoplay needs a seed track',
      ErrorTypes.USER_INPUT,
      'Play at least one song before enabling autoplay so recommendations have a seed track.',
    );
  }

  await refreshPlayerMessage(client, interaction.guild.id);
  return successEmbed('Autoplay', guildData.autoplay ? 'Autoplay enabled.' : 'Autoplay disabled.');
}

export async function reverseQueue(client, interaction) {
  await hydrateMusicPolicy(client, interaction.guild.id);
  const player = requirePlayer(client, interaction);
  if (!player.queue?.length) {
    throw new TitanBotError('Empty queue', ErrorTypes.USER_INPUT, 'The queue is empty.');
  }

  player.queue.reverse();
  await refreshPlayerMessage(client, interaction.guild.id);
  return successEmbed('Queue Reversed', `Reversed **${player.queue.length}** queued track(s).`);
}

async function invokeFilterApi(player, presetName) {
  const preset = FILTER_PRESETS[presetName];
  const filters = player.filters || player.filter || null;

  if (presetName === 'off') {
    if (typeof filters?.clearFilters === 'function') {
      await filters.clearFilters();
      return;
    }
    if (typeof player.clearFilters === 'function') {
      await player.clearFilters();
      return;
    }
    if (typeof filters?.setFilters === 'function') {
      await filters.setFilters({});
      return;
    }
    if (typeof player.setFilters === 'function') {
      await player.setFilters({});
      return;
    }
    throw new Error('The connected Lavalink/Riffy player does not expose a filter API.');
  }

  if (typeof filters?.setFilters === 'function') {
    await filters.setFilters(preset);
    return;
  }
  if (typeof player.setFilters === 'function') {
    await player.setFilters(preset);
    return;
  }
  if (typeof filters?.apply === 'function') {
    await filters.apply(preset);
    return;
  }

  throw new Error('Audio filters are not supported by the currently connected Lavalink/Riffy player.');
}

export async function setAudioFilter(client, interaction, presetName) {
  await hydrateMusicPolicy(client, interaction.guild.id);
  const player = requirePlayer(client, interaction);
  if (!MUSIC_FILTER_NAMES.includes(presetName)) {
    throw new TitanBotError('Unknown filter', ErrorTypes.USER_INPUT, 'Unknown audio-filter preset.');
  }

  try {
    await invokeFilterApi(player, presetName);
  } catch (error) {
    throw new TitanBotError(
      'Audio filter unavailable',
      ErrorTypes.CONFIGURATION,
      `Could not apply **${presetName}**: ${error?.message || error}`,
    );
  }

  const guildData = getGuildMusicData(interaction.guild.id);
  guildData.activeFilter = presetName;
  await refreshPlayerMessage(client, interaction.guild.id);
  return successEmbed('Audio Filter', presetName === 'off' ? 'Audio filters cleared.' : `Applied **${presetName}**.`);
}

function requireManageMusicPolicy(interaction) {
  if (
    interaction.guild.ownerId === interaction.user.id
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return;
  }
  throw new TitanBotError(
    'Manage Server required',
    ErrorTypes.PERMISSION,
    'You need **Manage Server** to change music session permissions.',
  );
}

export async function configureSessionMode(client, interaction, mode) {
  requireManageMusicPolicy(interaction);
  const data = await setMusicPermissionMode(client, interaction.guild.id, mode);
  return successEmbed('Music Permission Mode', `Mode set to **${data.permissionMode}**.`);
}

export async function configureSessionLock(client, interaction, locked) {
  await hydrateMusicPolicy(client, interaction.guild.id);
  const guildData = getGuildMusicData(interaction.guild.id);
  const canLock = interaction.guild.ownerId === interaction.user.id
    || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || guildData.sessionOwnerId === interaction.user.id;

  if (!canLock) {
    throw new TitanBotError('No permission', ErrorTypes.PERMISSION, 'Only the session owner, server managers, or administrators can lock the session.');
  }

  await setMusicSessionLocked(client, interaction.guild.id, locked);
  return successEmbed('Music Session Lock', locked ? 'Session locked.' : 'Session unlocked.');
}

export async function configureDjRole(client, interaction, role, enabled) {
  requireManageMusicPolicy(interaction);
  if (enabled) await addDjRole(client, interaction.guild.id, role.id);
  else await removeDjRole(client, interaction.guild.id, role.id);
  return successEmbed('DJ Role', enabled ? `${role} can now control restricted music sessions.` : `${role} removed from DJ roles.`);
}

export async function configureMusicUser(client, interaction, user, state) {
  requireManageMusicPolicy(interaction);
  await setUserMusicOverride(client, interaction.guild.id, user.id, state);
  const labels = { allow: 'explicitly allowed', deny: 'explicitly denied', reset: 'reset to default permissions' };
  return successEmbed('Music User Permission', `${user} is now **${labels[state] || state}**.`);
}

export async function musicPermissionStatus(client, interaction) {
  const summary = await getMusicPolicySummary(client, interaction.guild.id);
  return successEmbed(
    'Music Session Permissions',
    `**Mode:** ${summary.permissionMode}\n` +
    `**Locked:** ${summary.sessionLocked ? 'Yes' : 'No'}\n` +
    `**Session owner:** ${summary.sessionOwnerId ? `<@${summary.sessionOwnerId}>` : 'Not set'}\n` +
    `**DJ roles:** ${summary.djRoleIds.length ? summary.djRoleIds.map((id) => `<@&${id}>`).join(', ') : 'None'}\n` +
    `**Allowed users:** ${summary.allowedUsers.length ? summary.allowedUsers.map((id) => `<@${id}>`).join(', ') : 'None'}\n` +
    `**Denied users:** ${summary.deniedUsers.length ? summary.deniedUsers.map((id) => `<@${id}>`).join(', ') : 'None'}`,
  );
}
