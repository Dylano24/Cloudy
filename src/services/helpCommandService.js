import { PermissionFlagsBits } from 'discord.js';
import { isBotOwner } from '../config/bot.js';
import { isPlayerCommand } from '../config/playerCommands.js';

export function canSeeAllHelpCommands(interaction) {
  return Boolean(isBotOwner(interaction?.user?.id)
    || interaction?.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

export function getVisibleHelpCommands(client, interaction) {
  const all = canSeeAllHelpCommands(interaction);
  const commands = [];
  for (const command of client?.commands?.values?.() || []) {
    const data = command.data?.toJSON?.() || command.data;
    if (!data?.name || (data.type !== undefined && data.type !== 1)) continue;
    let category = command.category || 'Core';
    if (category === '00Overrides' && data.name === 'jointocreate') category = 'JoinToCreate';
    if (category === 'Leveling' || ['help', 'commandlist'].includes(data.name)) continue;
    if (!all && (command.adminOnly === true || !isPlayerCommand(data.name))) continue;
    commands.push({command, data, category});
  }
  return commands;
}
