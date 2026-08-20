import 'dotenv/config';
import { REST } from '@discordjs/rest';

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

async function preflightDiscord() {
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

  const rest = new REST({ version: '10' }).setToken(token);

  let botUser;
  try {
    botUser = await rest.get('/users/@me');
  } catch (error) {
    const code = error?.code ?? error?.status ?? 'unknown';
    throw new Error(`Discord rejected the configured bot token (code ${code})`);
  }

  if (!botUser?.id) {
    throw new Error('Discord token validation returned no bot user ID');
  }

  const authenticatedClientId = String(botUser.id);
  const configuredClientId = firstTrimmedEnv(
    'CLIENT_ID',
    'DISCORD_CLIENT_ID',
    'APPLICATION_ID',
    'BOT_CLIENT_ID',
  );

  if (configuredClientId && configuredClientId !== authenticatedClientId) {
    console.warn(
      `[PREFLIGHT] Railway CLIENT_ID ${configuredClientId} does not match the authenticated bot ${authenticatedClientId}; using the authenticated ID.`,
    );
  }

  // The token is the source of truth. This prevents a stale Railway CLIENT_ID
  // from registering commands for a different Discord application.
  process.env.CLIENT_ID = authenticatedClientId;

  const guildId = firstTrimmedEnv('GUILD_ID', 'BOTPROFILE_GUILD_ID');
  if (!guildId) {
    throw new Error('GUILD_ID is empty in Railway');
  }
  assertSnowflake(guildId, 'GUILD_ID');
  process.env.GUILD_ID = guildId;

  try {
    const guild = await rest.get(`/guilds/${guildId}`);
    console.log(
      `[PREFLIGHT] Discord token valid for bot ${authenticatedClientId}; guild access confirmed for ${guild?.id || guildId}.`,
    );
  } catch (error) {
    const code = error?.code ?? error?.status ?? 'unknown';
    throw new Error(
      `The configured bot token cannot access GUILD_ID ${guildId} (code ${code}). ` +
      'Check that Cloudy is actually added to that server and that GUILD_ID is correct.',
    );
  }

  // Discord application flags provide useful diagnostics for privileged gateway
  // intent access. Do not hard-fail here because Discord may change flag policy;
  // the real gateway login remains the final authority.
  try {
    const application = await rest.get('/oauth2/applications/@me');
    const flags = BigInt(application?.flags || 0);
    const guildMembersBits = 16384n | 32768n;
    const messageContentBits = 262144n | 524288n;

    if ((flags & guildMembersBits) === 0n) {
      console.warn('[PREFLIGHT] Server Members privileged intent does not appear enabled for this application.');
    }
    if ((flags & messageContentBits) === 0n) {
      console.warn('[PREFLIGHT] Message Content privileged intent does not appear enabled for this application.');
    }
  } catch (error) {
    console.warn(`[PREFLIGHT] Could not inspect application intent flags: ${error?.message || error}`);
  }
}

try {
  await preflightDiscord();
  await import('./app.js');
} catch (error) {
  console.error(`[PREFLIGHT] Fatal startup validation failed: ${error?.message || error}`);
  process.exit(1);
}
