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
  const exemptIds = [channel.guild.id, botId, staffRoleId];
  const memberIds = new Set([data.userId, ...overwrites
    .filter(overwrite => overwrite.type === OverwriteType.Member && !exemptIds.includes(overwrite.id))
    .map(overwrite => overwrite.id)]);
  const members = new Map(await Promise.all([...memberIds].map(async id => {
    const member = await channel.guild.members.fetch(id).catch(error => {
      if (error.code === 10007) return null;
      throw error;
    });
    return [id, member];
  })));
  const permissions = new Map();
  const hidden = [];
  for (const overwrite of overwrites) {
    if (exemptIds.includes(overwrite.id)) continue;
    if (overwrite.type === OverwriteType.Member) {
      const member = members.get(overwrite.id);
      if (ticketActorPermissions({ member, userId: overwrite.id, ownerId: channel.guild.ownerId, staffRoleId }).canManageTicket) {
        permissions.set(overwrite.id, { ViewChannel: true, SendMessages: true });
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
  permissions.set(channel.guild.id, { ViewChannel: false });
  permissions.set(botId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
  for (const overwrite of hidden) permissions.set(overwrite.id, { ViewChannel: false, SendMessages: false });
  const creator = members.get(data.userId);
  const creatorIsStaff = ticketActorPermissions({ member: creator, userId: data.userId, ownerId: channel.guild.ownerId, staffRoleId }).canManageTicket;
  permissions.set(data.userId, { ViewChannel: creatorIsStaff, SendMessages: creatorIsStaff });
  if (staffRoleId) permissions.set(staffRoleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
  // Every ID has one final overwrite. Discord's cache can lag REST writes, so
  // even a cached match must be applied after a rapid Close/Reopen/Close.
  // Wait for all writes even on failure so a queued reopen cannot race cleanup.
  const results = await Promise.allSettled([...permissions]
    .map(async ([id, values]) => channel.permissionOverwrites.edit(id, values)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

export async function restoreReopenedTicketAccess(channel, currentTicketData = null) {
  const data = currentTicketData || await getTicketData(channel.guild.id, channel.id);
  if (!data?.closedAccessSnapshot) return;

  // The permission edits are independent. Restore them together instead of
  // serially waiting for every overwrite before the reopen action can finish.
  const results = await Promise.allSettled(
    data.closedAccessSnapshot
      .filter(overwrite => overwrite.id !== data.userId)
      .map(overwrite => channel.permissionOverwrites.edit(overwrite.id, {
        ViewChannel: overwrite.view,
        SendMessages: overwrite.send,
      })),
  );
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;

  delete data.closedAccessSnapshot;
  await saveTicketData(channel.guild.id, channel.id, data);
}
