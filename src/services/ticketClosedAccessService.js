import { OverwriteType, PermissionFlagsBits, PermissionOverwrites } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { ticketActorPermissions } from './ticketActionPolicy.js';

// Re-read the channel's permission overwrites from Discord REST and return a
// snapshot of them, or null when no fresh read is available. The Gateway cache
// lags REST writes, so only this snapshot may ever be used to skip a write.
// It is captured in the same tick the REST response is applied, so a late
// Gateway event for an older write cannot change it afterwards.
export async function readFreshTicketOverwrites(channel) {
  if (typeof channel?.fetch !== 'function') return null;
  try {
    // discord.js patches the cached channel instance in place.
    if (await channel.fetch(true) !== channel) return null;
    const snapshot = new Map();
    for (const [id, overwrite] of channel.permissionOverwrites.cache) {
      snapshot.set(String(id), {
        allow: BigInt(overwrite.allow.bitfield),
        deny: BigInt(overwrite.deny.bitfield),
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

// True only when the edit would PUT exactly the allow/deny bits the fresh
// snapshot already shows. Discord runs a channel's permission edits one at a
// time and rate limits them, so such a write only delays the next real change.
export function isNoopOverwriteEdit(freshOverwrites, id, values) {
  const existing = freshOverwrites?.get?.(String(id));
  if (!existing) return false;
  try {
    const next = PermissionOverwrites.resolveOverwriteOptions(values, existing);
    return next.allow.bitfield === existing.allow && next.deny.bitfield === existing.deny;
  } catch {
    return false;
  }
}

// Apply each overwrite exactly as before. With a fresh snapshot, writes that
// cannot change anything are skipped. Wait for every write even on failure,
// so a queued reopen cannot race an outstanding close write.
export async function applyTicketOverwriteEdits(channel, entries, freshOverwrites = null) {
  const writes = [...entries]
    .filter(([id, values]) => !isNoopOverwriteEdit(freshOverwrites, id, values));
  const results = await Promise.allSettled(writes
    .map(async ([id, values]) => channel.permissionOverwrites.edit(id, values)));
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return writes.length;
}

export async function hideClosedTicket(channel, { closing = false } = {}) {
  const data = await getTicketData(channel.guild.id, channel.id);
  if (!data) throw new Error('Ticket data not found');
  if (!closing && data.status !== 'closed') return null;
  const config = await getGuildConfig(channel.client, channel.guild.id);
  // Read the overwrite list in the same tick as the fresh REST snapshot.
  const freshOverwrites = await readFreshTicketOverwrites(channel);
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
  // a cached match is applied anyway unless the state was just re-read from
  // Discord REST. Wait for all writes even on failure so a queued reopen
  // cannot race cleanup.
  await applyTicketOverwriteEdits(channel, permissions, freshOverwrites);
  return freshOverwrites;
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
