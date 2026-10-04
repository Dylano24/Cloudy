export async function resolveDiscordAppealIdentity(guild, identity, { includeBans = true } = {}) {
  const raw = String(identity || '').trim();
  const id = raw.match(/^(?:<@!?)?(\d{17,20})>?$/)?.[1];
  if (id) return id;
  const name = raw.replace(/^@/, '').toLowerCase();
  if (!name) throw new Error('This appeal has no Discord username or ID.');
  const matches = new Set();
  const add = user => {
    if (user && [user.username, user.tag].some(value => String(value || '').toLowerCase() === name)) matches.add(user.id);
  };
  for (const member of guild.members.cache?.values?.() || []) add(member.user);
  const members = await guild.members.fetch({ query: raw.replace(/^@/, ''), limit: 100 }).catch(() => null);
  for (const member of members?.values?.() || []) add(member.user);
  // A banned player is not in the member list. Do not silently choose one
  // cached member without checking the banned accounts too.
  if (includeBans) {
    const bans = await guild.bans.fetch();
    for (const ban of bans.values()) add(ban.user);
  }
  if (matches.size !== 1) throw new Error(matches.size ? 'This Discord username is ambiguous. Use the correct user ID.' : 'The Discord account could not be found. Check the username or user ID.');
  return [...matches][0];
}

