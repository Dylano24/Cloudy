import path from 'node:path';
import { pathToFileURL } from 'node:url';

function messageReference(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['discord.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname)
      || url.username || url.password || url.port) throw new Error('Use a Discord HTTPS message link');
  const match = url.pathname.match(/^\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/);
  if (!match) throw new Error('A complete server/channel/message link is required');
  return {guildId: match[1], channelId: match[2], messageId: match[3]};
}

export function parseTicketPanelTransferArgs(args) {
  if (args.length === 1 && args[0] === '--help') return {help: true};
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--source-url', '--target-url', '--apply', '--dry-run'].includes(key) || values.has(key)) {
      throw new Error('Unknown or repeated argument');
    }
    if (key === '--apply' || key === '--dry-run') values.set(key, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing message link');
      values.set(key, value);
    }
  }
  if (values.has('--apply') && values.has('--dry-run')) throw new Error('Choose preview or apply');
  if (!values.has('--source-url') || !values.has('--target-url')) throw new Error('Provide both message links');
  const source = messageReference(values.get('--source-url'));
  const target = messageReference(values.get('--target-url'));
  if (source.guildId !== target.guildId || source.channelId !== target.channelId || source.messageId === target.messageId) {
    throw new Error('Choose distinct messages in the same server and channel');
  }
  return {source, target, apply: values.has('--apply')};
}

async function main() {
  const options = parseTicketPanelTransferArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/transfer-ticket-panel.js --source-url <old message link> --target-url <shield message link> [--apply]');
    console.log('Without --apply: preview only; no message/config/registry writes. No startup migration.');
    return;
  }
  await import('dotenv/config');
  const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('Cloudy bot credentials are required');
  const {Client, Events, GatewayIntentBits} = await import('discord.js');
  const {once} = await import('node:events');
  const client = new Client({intents: [GatewayIntentBits.Guilds]});
  let database;
  try {
    await Promise.all([once(client, Events.ClientReady, {signal: AbortSignal.timeout(30_000)}), client.login(token)]);
    const reference = options.target;
    const guild = await client.guilds.fetch(reference.guildId);
    const channel = await guild.channels.fetch(reference.channelId);
    if (!channel?.messages?.fetch) throw new Error('The selected channel is not a message channel');
    const {transferTicketPanelControls} = await import('../src/services/ticketPanelTransitionService.js');
    const source = await channel.messages.fetch({message: options.source.messageId, force: true});
    const target = await channel.messages.fetch({message: options.target.messageId, force: true});
    if (options.apply) {
      database = await import('../src/utils/database.js');
      await database.initializeDatabase();
      if (database.db.getConnectionType() !== 'postgresql') throw new Error('Persistent PostgreSQL is required to apply');
      client.db = database.db;
    }
    console.log(JSON.stringify(await transferTicketPanelControls(client, {source, target}, {apply: options.apply}), null, 2));
  } finally {
    client.destroy();
    if (database?.db?.db?.close) await database.db.db.close();
    else if (database?.db?.db?.pool?.end) await database.db.db.pool.end();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error('Ticket panel transfer failed. Inspect the exact target before retrying.', error.code || error.name);
    process.exitCode = 1;
  });
}
