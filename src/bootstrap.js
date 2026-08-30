import 'dotenv/config';
import { installBuilderSessionCleanup } from './utils/builderSessionCleanup.js';

function firstTrimmedEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function assertSnowflake(value, label) {
  if (!/^\d{17,20}$/.test(String(value || ''))) {
    throw new Error(`${label} must be a valid Discord snowflake ID`);
  }
}

function prepareDiscordConfig() {
  const token = firstTrimmedEnv(
    'DISCORD_TOKEN',
    'TOKEN',
    'BOT_TOKEN',
    'DISCORD_BOT_TOKEN',
  );

  if (!token) {
    throw new Error('No Discord bot token is configured in Railway');
  }

  // Normalize whitespace from copied Railway secrets before the real app reads them.
  process.env.DISCORD_TOKEN = token;

  const clientId = firstTrimmedEnv(
    'CLIENT_ID',
    'DISCORD_CLIENT_ID',
    'APPLICATION_ID',
    'BOT_CLIENT_ID',
  );
  if (clientId) {
    assertSnowflake(clientId, 'CLIENT_ID');
    process.env.CLIENT_ID = clientId;
  }

  const guildId = firstTrimmedEnv('GUILD_ID', 'BOTPROFILE_GUILD_ID');
  if (!guildId) {
    throw new Error('GUILD_ID is empty in Railway');
  }
  assertSnowflake(guildId, 'GUILD_ID');
  process.env.GUILD_ID = guildId;

  // Do not make application startup depend on Discord REST. Cloudflare/Discord
  // can temporarily rate-limit REST while the Gateway is healthy. The real
  // Discord client login below is the authoritative live token/intent check.
  console.log(
    `[PREFLIGHT] Local Discord configuration validated${clientId ? ` for app ${clientId}` : ''}; live validation deferred to Discord Gateway login.`,
  );
}

try {
  prepareDiscordConfig();
  installBuilderSessionCleanup();
  await import('./app.js');
} catch (error) {
  console.error(`[PREFLIGHT] Fatal startup validation failed: ${error?.message || error}`);
  process.exit(1);
}
