const OWNER_ROLE_NAME = 'owner';

export function hasCloudyOwnerMember(member) {
  const roles = member?.roles?.cache;
  if (!roles?.some) return false;
  return roles.some(role => String(role?.name || '').trim().toLowerCase() === OWNER_ROLE_NAME);
}

export function hasCloudyOwnerRole(messageOrInteraction) {
  return hasCloudyOwnerMember(messageOrInteraction?.member || null);
}
