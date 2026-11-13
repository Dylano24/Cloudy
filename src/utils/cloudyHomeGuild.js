// Cloudy Inc.'s own Discord server. Cloudy's house style (welcome card, FAQ
// link, Cloudy Inc. channels) belongs there only; every other server is a
// customer's and uses its own settings from the dashboard.
export const CLOUDY_HOME_GUILD_ID = '1532882647838228723';

export function cloudyHomeGuildId(env = process.env) {
  return String(env.GUILD_ID || '').trim() || CLOUDY_HOME_GUILD_ID;
}

export function isCloudyHomeGuild(guildId, env = process.env) {
  return String(guildId || '') === cloudyHomeGuildId(env);
}
