import { PermissionFlagsBits } from 'discord.js';
import { memberHasConfiguredModeratorRole } from '../utils/permissionGuard.js';
import { hasCloudyOwnerMember } from './ownerRoleAccess.js';

const STAFF_ROLE_NAMES = new Set(['staff', 'owner', 'admin', 'administrator', 'moderator']);

/**
 * Cloudy staff: the server owner, Administrators, the Owner role, the
 * configured moderator/admin/ticket staff roles, and roles named Staff,
 * Owner, Admin, Administrator or Moderator. Staff cannot be robbed and
 * may use /give money.
 */
export function isCloudyStaffMember(member, guildConfig = {}, guild = null) {
    if (!member) return false;
    const roles = member.roles?.cache;
    const roleId = role => typeof role === 'string' ? role : role?.id;
    const configured = [
        guildConfig?.modRole, guildConfig?.adminRole, guildConfig?.ticketStaffRoleId,
    ].some(role => Boolean(roleId(role) && roles?.has?.(roleId(role))));

    return String(guild?.ownerId || member.guild?.ownerId || '') === String(member.id)
        || Boolean(member.permissions?.has?.(PermissionFlagsBits.Administrator))
        || hasCloudyOwnerMember(member)
        || memberHasConfiguredModeratorRole(
            roles ? member : null, guildConfig,
        )
        || configured
        || Boolean(Array.from(roles?.values?.() || []).some(role =>
            STAFF_ROLE_NAMES.has(String(role.name || '').trim().toLowerCase())));
}
