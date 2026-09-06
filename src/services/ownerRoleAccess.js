const OWNER_ROLE_NAME = 'owner';

export function hasCloudyOwnerRole(messageOrInteraction) {
  const member = messageOrInteraction?.member || null;
  const roles = member?.roles?.cache;
  if (!roles?.some) return false;

  return roles.some(role => String(role?.name || '').trim().toLowerCase() === OWNER_ROLE_NAME);
}
