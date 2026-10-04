import { hasCloudyOwnerMember } from './ownerRoleAccess.js';
import { PermissionFlagsBits } from 'discord.js';

export const CLOUDY_GUILD_ID = '1532882647838228723';
export const OWNER_MOD_MESSAGE_LOG_ID = '1555895354187325552';
export const MEMBER_MESSAGE_LOG_ID = '1555891729297580084';

export function messageLogAuthorType(guild, userId, member, config = {}, authorBot = false) {
  if (authorBot || member?.user?.bot) return 'Bot';
  if (!userId) return 'Unknown';
  if (userId === guild?.ownerId) return 'Staff';
  const staff = hasCloudyOwnerMember(member) || member?.permissions?.has?.(PermissionFlagsBits.Administrator)
    || member?.permissions?.has?.(PermissionFlagsBits.ModerateMembers)
    || member?.permissions?.has?.(PermissionFlagsBits.ManageMessages)
    || member?.permissions?.has?.(PermissionFlagsBits.BanMembers)
    || member?.permissions?.has?.(PermissionFlagsBits.KickMembers)
    || Boolean(config.ticketStaffRoleId && member?.roles?.cache?.has?.(config.ticketStaffRoleId));
  return staff ? 'Staff' : 'Member';
}

export function messageLogDestination(guild, userId, member, config = {}, authorBot = false, deleter = null) {
  if (guild?.id !== CLOUDY_GUILD_ID) return null;
  if (deleter && messageLogAuthorType(guild, deleter.id, deleter, config) === 'Staff') return OWNER_MOD_MESSAGE_LOG_ID;
  const type = messageLogAuthorType(guild, userId, member, config, authorBot);
  return ['Staff', 'Bot'].includes(type) ? OWNER_MOD_MESSAGE_LOG_ID : MEMBER_MESSAGE_LOG_ID;
}

