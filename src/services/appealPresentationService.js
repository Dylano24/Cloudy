import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const appealReviewKey = (guildId, id) => `global:appeal-review:${guildId}:${id}`;
export function appealActions(record) {
  if (record.scope === 'rust') return ['unban', 'deny'];
  return record.action === 'Mute' ? ['unmute', 'deny'] : record.action === 'Ban' ? ['unban', 'deny'] : ['unmute', 'unban', 'deny'];
}

export function buildAppealActions(record) {
  return [new ActionRowBuilder().addComponents(appealActions(record).map(action => new ButtonBuilder()
    .setCustomId(`appeal_action:${action}:${record.id}`)
    .setLabel({ unmute: 'Unmute', unban: 'Unban', deny: 'Deny' }[action])
    .setStyle(action === 'deny' ? ButtonStyle.Danger : ButtonStyle.Success)
    .setDisabled(record.status !== 'pending' || (record.scope === 'rust' && action === 'unban'))))];
}
