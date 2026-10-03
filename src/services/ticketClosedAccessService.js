import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { ticketActorPermissions } from './ticketActionPolicy.js';

export async function hideClosedTicket(channel, { closing = false } = {}) {
  const data = await getTicketData(channel.guild.id, channel.id);
  if (!data) throw new Error('Ticket data not found');
  if (!closing && data.status !== 'closed') return;
  const config = await getGuildConfig(channel.client, channel.guild.id);
  const staffRoleId = config.ticketStaffRoleId || channel.guild.roles.cache.find(role => role.name.trim().toLowerCase() === 'staff')?.id;
  const botId = channel.client.user.id;
  const overwrites = [...channel.permissionOverwrites.cache.values()];
  const hidden = [];
  for (const overwrite of overwrites) {
    if ([channel.guild.id, botId, staffRoleId].includes(overwrite.id)) continue;
    if (overwrite.type === OverwriteType.Member) {
      const member = await channel.guild.members.fetch(overwrite.id).catch(error => {
        if (error.code === 10007) return null;
        throw error;
      });
      if (ticketActorPermissions({ member, userId: overwrite.id, ownerId: channel.guild.ownerId, staffRoleId }).canManageTicket) {
        await channel.permissionOverwrites.edit(overwrite.id, { ViewChannel: true, SendMessages: true });
        continue;
      }
    } else {
      const role = channel.guild.roles.cache.get(overwrite.id);
      if (role?.permissions?.has(PermissionFlagsBits.Administrator)) continue;
    }
    hidden.push({ id: overwrite.id,
      view: overwrite.allow?.has(PermissionFlagsBits.ViewChannel) ? true : overwrite.deny?.has(PermissionFlagsBits.ViewChannel) ? false : null,
      send: overwrite.allow?.has(PermissionFlagsBits.SendMessages) ? true : overwrite.deny?.has(PermissionFlagsBits.SendMessages) ? false : null });
  }
  if (!data.closedAccessSnapshot) {
    data.closedAccessSnapshot = hidden;
    await saveTicketData(channel.guild.id, channel.id, data);
  }
  await channel.permissionOverwrites.edit(channel.guild.id, { ViewChannel: false });
  await channel.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  for (const overwrite of hidden) await channel.permissionOverwrites.edit(overwrite.id, { ViewChannel: false, SendMessages: false });
  const creator = await channel.guild.members.fetch(data.userId).catch(error => {
    if (error.code === 10007) return null;
    throw error;
  });
  const creatorIsStaff = ticketActorPermissions({ member: creator, userId: data.userId, ownerId: channel.guild.ownerId, staffRoleId }).canManageTicket;
  await channel.permissionOverwrites.edit(data.userId, { ViewChannel: creatorIsStaff, SendMessages: creatorIsStaff });
  if (staffRoleId) await channel.permissionOverwrites.edit(staffRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
}

export async function restoreReopenedTicketAccess(channel) {
  const data = await getTicketData(channel.guild.id, channel.id);
  if (!data?.closedAccessSnapshot) return;
  for (const overwrite of data.closedAccessSnapshot) {
    if (overwrite.id === data.userId) continue;
    await channel.permissionOverwrites.edit(overwrite.id, { ViewChannel: overwrite.view, SendMessages: overwrite.send });
  }
  delete data.closedAccessSnapshot;
  await saveTicketData(channel.guild.id, channel.id, data);
}
