import { PermissionFlagsBits } from 'discord.js';

export const CLOUDY_GUILD_ID = '1532882647838228723';
export const OWNER_MOD_MESSAGE_LOG_ID = '1555895354187325552';
export const MEMBER_MESSAGE_LOG_ID = '1555891729297580084';

export function messageLogDestination(guild, userId, member, config = {}) {
  if (guild?.id !== CLOUDY_GUILD_ID || !userId) return null;
  const staff = userId === guild.ownerId
    || member?.permissions?.has?.(PermissionFlagsBits.Administrator)
    || member?.permissions?.has?.(PermissionFlagsBits.ModerateMembers)
    || member?.permissions?.has?.(PermissionFlagsBits.ManageMessages)
    || Boolean(config.ticketStaffRoleId && member?.roles?.cache?.has?.(config.ticketStaffRoleId));
  return staff ? OWNER_MOD_MESSAGE_LOG_ID : MEMBER_MESSAGE_LOG_ID;
}
