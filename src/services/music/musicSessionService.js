import { PermissionFlagsBits } from 'discord.js';
import { getGuildMusicData } from './playerStore.js';

const POLICY_PREFIX = 'music:policy:';
const VALID_MODES = ['open', 'owner', 'dj'];

function policyKey(guildId) {
  return `${POLICY_PREFIX}${guildId}`;
}

export async function hydrateMusicPolicy(client, guildId) {
  const guildData = getGuildMusicData(guildId);
  if (guildData.policyHydrated) return guildData;

  try {
    const stored = await client.db?.get?.(policyKey(guildId), null);
    if (stored) {
      guildData.permissionMode = VALID_MODES.includes(stored.permissionMode)
        ? stored.permissionMode
        : 'open';
      guildData.sessionLocked = Boolean(stored.sessionLocked);
      guildData.djRoleIds = new Set((stored.djRoleIds || []).map(String));
      guildData.allowedUsers = new Set((stored.allowedUsers || []).map(String));
      guildData.deniedUsers = new Set((stored.deniedUsers || []).map(String));
    }
  } catch {
    // Degraded DB: keep safe in-memory defaults instead of breaking music.
  }

  guildData.policyHydrated = true;
  return guildData;
}

export async function persistMusicPolicy(client, guildId) {
  const guildData = getGuildMusicData(guildId);
  await client.db?.set?.(policyKey(guildId), {
    permissionMode: guildData.permissionMode,
    sessionLocked: guildData.sessionLocked,
    djRoleIds: [...guildData.djRoleIds],
    allowedUsers: [...guildData.allowedUsers],
    deniedUsers: [...guildData.deniedUsers],
  });
  return guildData;
}

export async function setMusicPermissionMode(client, guildId, mode) {
  if (!VALID_MODES.includes(mode)) throw new Error('Invalid music permission mode.');
  const guildData = await hydrateMusicPolicy(client, guildId);
  guildData.permissionMode = mode;
  await persistMusicPolicy(client, guildId);
  return guildData;
}

export async function setMusicSessionLocked(client, guildId, locked) {
  const guildData = await hydrateMusicPolicy(client, guildId);
  guildData.sessionLocked = Boolean(locked);
  await persistMusicPolicy(client, guildId);
  return guildData;
}

export async function addDjRole(client, guildId, roleId) {
  const guildData = await hydrateMusicPolicy(client, guildId);
  guildData.djRoleIds.add(String(roleId));
  await persistMusicPolicy(client, guildId);
  return guildData;
}

export async function removeDjRole(client, guildId, roleId) {
  const guildData = await hydrateMusicPolicy(client, guildId);
  guildData.djRoleIds.delete(String(roleId));
  await persistMusicPolicy(client, guildId);
  return guildData;
}

export async function setUserMusicOverride(client, guildId, userId, state) {
  const guildData = await hydrateMusicPolicy(client, guildId);
  guildData.allowedUsers.delete(String(userId));
  guildData.deniedUsers.delete(String(userId));

  if (state === 'allow') guildData.allowedUsers.add(String(userId));
  if (state === 'deny') guildData.deniedUsers.add(String(userId));

  await persistMusicPolicy(client, guildId);
  return guildData;
}

export function memberHasDjRole(member, guildData) {
  return member?.roles?.cache?.some((role) => guildData.djRoleIds.has(role.id)) || false;
}

export function canMemberControlSession(member, guildData) {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (guildData.allowedUsers.has(member.id)) return true;
  if (guildData.deniedUsers.has(member.id)) return false;

  const isOwner = Boolean(guildData.sessionOwnerId && guildData.sessionOwnerId === member.id);
  const isDj = memberHasDjRole(member, guildData);

  if (guildData.sessionLocked) return isOwner || isDj;
  if (guildData.permissionMode === 'owner') return isOwner;
  if (guildData.permissionMode === 'dj') return isOwner || isDj;
  return true;
}

export async function getMusicPolicySummary(client, guildId) {
  const guildData = await hydrateMusicPolicy(client, guildId);
  return {
    permissionMode: guildData.permissionMode,
    sessionLocked: guildData.sessionLocked,
    sessionOwnerId: guildData.sessionOwnerId,
    djRoleIds: [...guildData.djRoleIds],
    allowedUsers: [...guildData.allowedUsers],
    deniedUsers: [...guildData.deniedUsers],
  };
}
