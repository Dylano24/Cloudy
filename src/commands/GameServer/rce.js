import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { createRconClient } from '../../services/rustConsole/rconClient.js';
import { rceCommand, safeConsoleLine } from '../../services/rce/rceCommands.js';
import { parseServerInfo } from '../../services/rce/rceParser.js';
import { assertPublicHost } from '../../services/rce/rceNetwork.js';
import {
  FEED_TYPES, RCE_LIMITS, RCE_PLAN_REQUIRED, getRceConfig, rcePlanAllows, sealSecret, slugify, updateRceConfig,
} from '../../services/rce/rceStore.js';
import { code, formatDuration, plain, RCE_COLORS, serverStatusEmbed } from '../../services/rce/rceEmbeds.js';
import {
  fail, info, liveSession, rceAutocomplete, requireRuntime, runRceCommand, serverFromOption, success,
} from '../../services/rce/rceInteraction.js';

const feedChoices = Object.entries(FEED_TYPES).map(([value, name]) => ({ name, value }));
const serverOption = (option, required = true) => option.setName('server').setDescription('Game server.').setAutocomplete(true).setRequired(required);
const playerOption = option => option.setName('player').setDescription('Gamertag or PSN ID.').setAutocomplete(true).setRequired(true).setMaxLength(32);
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

async function testConnection({ host, port, password, tls }) {
  try { await assertPublicHost(host); } catch (error) { fail(error.message); }
  const rcon = createRconClient({ host, port, password, tls, name: 'Cloudy', timeoutMs: 8_000 });
  try {
    await rcon.connect();
    const reply = await rcon.send(rceCommand.serverInfo());
    return { ok: true, info: parseServerInfo(reply) };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || 'failed' };
  } finally {
    rcon.close();
  }
}

const reasonText = reason => ({
  timeout: 'the server did not answer in time',
  connect_failed: 'the connection was refused (check the address, the RCON port and that RCON is on)',
  closed: 'the server closed the connection (usually a wrong RCON password)',
  invalid_config: 'the address, port or password is not valid',
}[reason] || reason);

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('rce')
    .setDescription('Rust Console servers: connect, feeds and staff actions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommandGroup(group => group.setName('server').setDescription('Game servers.')
      .addSubcommand(sub => sub.setName('add').setDescription('Connect a game server over RCON.')
        .addStringOption(o => o.setName('name').setDescription('Name shown in Discord.').setRequired(true).setMaxLength(RCE_LIMITS.nameLength))
        .addStringOption(o => o.setName('host').setDescription('Server IP or host name.').setRequired(true).setMaxLength(253))
        .addIntegerOption(o => o.setName('port').setDescription('RCON port.').setRequired(true).setMinValue(1).setMaxValue(65535))
        .addStringOption(o => o.setName('password').setDescription('RCON password (stored encrypted).').setRequired(true).setMaxLength(200))
        .addBooleanOption(o => o.setName('tls').setDescription('Use wss:// (rare).')))
      .addSubcommand(sub => sub.setName('edit').setDescription('Change a game server.')
        .addStringOption(o => serverOption(o))
        .addStringOption(o => o.setName('name').setDescription('New name.').setMaxLength(RCE_LIMITS.nameLength))
        .addStringOption(o => o.setName('host').setDescription('New IP or host.').setMaxLength(253))
        .addIntegerOption(o => o.setName('port').setDescription('New RCON port.').setMinValue(1).setMaxValue(65535))
        .addStringOption(o => o.setName('password').setDescription('New RCON password.').setMaxLength(200))
        .addBooleanOption(o => o.setName('enabled').setDescription('Connect this server.')))
      .addSubcommand(sub => sub.setName('remove').setDescription('Disconnect and remove a game server.').addStringOption(o => serverOption(o)))
      .addSubcommand(sub => sub.setName('list').setDescription('All game servers and their connection.'))
      .addSubcommand(sub => sub.setName('reconnect').setDescription('Reconnect a game server now.').addStringOption(o => serverOption(o))))
    .addSubcommandGroup(group => group.setName('channel').setDescription('Feed channels.')
      .addSubcommand(sub => sub.setName('set').setDescription('Choose the channel of a feed.')
        .addStringOption(o => o.setName('feed').setDescription('Feed.').setRequired(true).addChoices(...feedChoices))
        .addChannelOption(o => o.setName('channel').setDescription('Text channel.').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand(sub => sub.setName('clear').setDescription('Turn a feed off.')
        .addStringOption(o => o.setName('feed').setDescription('Feed.').setRequired(true).addChoices(...feedChoices)))
      .addSubcommand(sub => sub.setName('list').setDescription('Show the feed channels.')))
    .addSubcommandGroup(group => group.setName('player').setDescription('Staff actions on a player.')
      .addSubcommand(sub => sub.setName('kick').setDescription('Kick a player.').addStringOption(o => serverOption(o)).addStringOption(playerOption))
      .addSubcommand(sub => sub.setName('ban').setDescription('Ban a player.').addStringOption(o => serverOption(o)).addStringOption(playerOption)
        .addStringOption(o => o.setName('reason').setDescription('Reason.').setMaxLength(120))
        .addIntegerOption(o => o.setName('minutes').setDescription('Temporary ban length (empty = permanent).').setMinValue(1).setMaxValue(525600)))
      .addSubcommand(sub => sub.setName('unban').setDescription('Unban a player.').addStringOption(o => serverOption(o)).addStringOption(playerOption))
      .addSubcommand(sub => sub.setName('give').setDescription('Give an item.').addStringOption(o => serverOption(o)).addStringOption(playerOption)
        .addStringOption(o => o.setName('shortname').setDescription('Item short name, e.g. rifle.ak.').setRequired(true).setMaxLength(64))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount.').setMinValue(1).setMaxValue(1000000)))
      .addSubcommand(sub => sub.setName('kit').setDescription('Give a kit.').addStringOption(o => serverOption(o)).addStringOption(playerOption)
        .addStringOption(o => o.setName('kit').setDescription('Kit name.').setRequired(true).setMaxLength(32)))
      .addSubcommand(sub => sub.setName('vip').setDescription('Give or remove VIP.').addStringOption(o => serverOption(o)).addStringOption(playerOption)
        .addBooleanOption(o => o.setName('remove').setDescription('Remove VIP instead.')))
      .addSubcommand(sub => sub.setName('teleport').setDescription('Teleport a player to a saved location.').addStringOption(o => serverOption(o)).addStringOption(playerOption)
        .addStringOption(o => o.setName('location').setDescription('Location.').setRequired(true).setAutocomplete(true))))
    .addSubcommandGroup(group => group.setName('game').setDescription('Server console and information.')
      .addSubcommand(sub => sub.setName('console').setDescription('Run a console command.').addStringOption(o => serverOption(o))
        .addStringOption(o => o.setName('command').setDescription('Command.').setRequired(true).setMaxLength(500)))
      .addSubcommand(sub => sub.setName('say').setDescription('Send a message to the in-game chat.').addStringOption(o => serverOption(o))
        .addStringOption(o => o.setName('message').setDescription('Message.').setRequired(true).setMaxLength(220)))
      .addSubcommand(sub => sub.setName('players').setDescription('Who is online.').addStringOption(o => serverOption(o)))
      .addSubcommand(sub => sub.setName('status').setDescription('Server status.').addStringOption(o => serverOption(o, false)))
      .addSubcommand(sub => sub.setName('log').setDescription('The last console lines.').addStringOption(o => serverOption(o)))
      .addSubcommand(sub => sub.setName('wipe').setDescription('New wipe: reset stats, kit claims and ZORP zones.').addStringOption(o => serverOption(o))
        .addBooleanOption(o => o.setName('confirm').setDescription('Yes, reset this server.').setRequired(true)))),

  autocomplete: rceAutocomplete,

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const name = interaction.options.getSubcommand();
    return runRceCommand(interaction, () => {
      if (group === 'server') return serverCommand(interaction, name);
      if (group === 'channel') return channelCommand(interaction, name);
      if (group === 'player') return playerCommand(interaction, name);
      return gameCommand(interaction, name);
    });
  },
};

async function serverCommand(interaction, name) {
  const { client, guildId } = interaction;
  if (name === 'list') {
    const config = await getRceConfig(client, guildId);
    if (!config.servers.length) return info('Rust servers', ['No game server is set up yet.', '', 'Add one with `/rce server add`: you need the server IP, the RCON port and the RCON password from your host (G-Portal or Nitrado).']);
    const runtime = requireRuntime();
    const premium = await rcePlanAllows(client, guildId);
    return info('Rust servers', config.servers.map((server, index) => {
      const session = runtime.session(guildId, server.id);
      const state = !server.enabled ? 'Disabled' : !premium ? 'Premium needed' : session?.state === 'online' ? `Online · ${session.players.size} players` : session?.state === 'connecting' ? 'Connecting' : session ? `Offline${session.lastError ? ` (${plain(session.lastError, 60)})` : ''}` : 'Not started';
      return `**${index + 1}. ${plain(server.name, 40)}** \`${server.id}\`\n${server.host}:${server.port} · ${state}`;
    }));
  }
  if (name === 'add') {
    if (!(await rcePlanAllows(client, guildId))) fail(RCE_PLAN_REQUIRED);
    const host = interaction.options.getString('host').trim();
    if (!HOST.test(host)) fail('Enter the server IP or host name without http:// or a port.');
    const port = interaction.options.getInteger('port');
    const password = interaction.options.getString('password');
    const tls = interaction.options.getBoolean('tls') === true;
    const test = await testConnection({ host, port, password, tls });
    const { outcome } = await updateRceConfig(client, guildId, config => {
      if (config.servers.length >= RCE_LIMITS.servers) fail(`You can connect up to ${RCE_LIMITS.servers} game servers.`);
      const label = interaction.options.getString('name').trim();
      const id = slugify(label, config.servers.map(server => server.id));
      config.servers.push({ id, name: label, host, port, tls, password: sealSecret(password), enabled: true, addedBy: interaction.user.id, addedAt: new Date().toISOString() });
      return { id, label };
    });
    return test.ok
      ? success(`**${plain(outcome.label, 40)}** is connected${test.info?.hostname ? ` (${plain(test.info.hostname, 60)})` : ''}. Choose the feed channels with \`/rce channel set\`.`)
      : info('Server added', [`**${plain(outcome.label, 40)}** was saved, but the test connection failed: ${reasonText(test.error)}.`, '', 'Cloudy keeps trying to connect. Fix the details with `/rce server edit`.'], { color: RCE_COLORS.yellow });
  }
  const { server } = await serverFromOption(interaction);
  if (name === 'remove') {
    await updateRceConfig(client, guildId, config => { config.servers = config.servers.filter(entry => entry.id !== server.id); });
    return success(`**${plain(server.name, 40)}** was removed.`);
  }
  if (name === 'reconnect') {
    const session = requireRuntime().session(guildId, server.id);
    if (!session) fail(`${server.name} is not active (disabled, Premium needed or the password must be entered again).`);
    session.reconnect();
    return success(`Reconnecting to **${plain(server.name, 40)}**.`);
  }
  // edit
  const changes = {};
  const host = interaction.options.getString('host');
  if (host != null) {
    if (!HOST.test(host.trim())) fail('Enter the server IP or host name without http:// or a port.');
    try { await assertPublicHost(host.trim()); } catch (error) { fail(error.message); }
    changes.host = host.trim();
  }
  const port = interaction.options.getInteger('port');
  if (port != null) changes.port = port;
  const label = interaction.options.getString('name');
  if (label != null) changes.name = label.trim();
  const enabled = interaction.options.getBoolean('enabled');
  if (enabled != null) changes.enabled = enabled;
  const password = interaction.options.getString('password');
  if (password != null) changes.password = sealSecret(password);
  if (!Object.keys(changes).length) fail('Choose at least one thing to change.');
  if (changes.enabled && !(await rcePlanAllows(client, guildId))) fail(RCE_PLAN_REQUIRED);
  await updateRceConfig(client, guildId, config => {
    const entry = config.servers.find(item => item.id === server.id);
    if (entry) Object.assign(entry, changes);
  });
  return success(`**${plain(changes.name || server.name, 40)}** was updated.`);
}

async function channelCommand(interaction, name) {
  const { client, guildId } = interaction;
  if (name === 'list') {
    const config = await getRceConfig(client, guildId);
    return info('Rust feed channels', [
      ...Object.entries(FEED_TYPES).map(([type, label]) => `**${label}:** ${config.channels[type] ? `<#${config.channels[type]}>` : 'Off'}`),
      '',
      `**Store deliveries:** ${config.delivery.channelId ? `<#${config.delivery.channelId}>` : 'Off'} (\`/rceconfig delivery channel\`)`,
    ]);
  }
  const feed = interaction.options.getString('feed');
  if (name === 'clear') {
    await updateRceConfig(client, guildId, config => { delete config.channels[feed]; });
    return success(`The ${FEED_TYPES[feed].toLowerCase()} feed is off.`);
  }
  const channel = interaction.options.getChannel('channel');
  const me = interaction.guild.members.me;
  if (!channel?.permissionsFor?.(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    fail('Cloudy needs View Channel, Send Messages and Embed Links in that channel.');
  }
  await updateRceConfig(client, guildId, config => { config.channels[feed] = channel.id; });
  return success(`The ${FEED_TYPES[feed].toLowerCase()} feed goes to <#${channel.id}>.`);
}

async function playerCommand(interaction, name) {
  const runtime = requireRuntime();
  const { config, server } = await serverFromOption(interaction);
  const session = liveSession(runtime, interaction.guildId, server);
  const player = interaction.options.getString('player');
  let line;
  let done;
  if (name === 'kick') { line = rceCommand.kick(player); done = `${code(player)} was kicked.`; }
  else if (name === 'ban') {
    const minutes = interaction.options.getInteger('minutes');
    line = rceCommand.ban(player, interaction.options.getString('reason') || `Banned by ${interaction.user.username}`, minutes ? minutes * 60 : null);
    done = `${code(player)} was banned${minutes ? ` for ${formatDuration(minutes * 60_000)}` : ''}.`;
  } else if (name === 'unban') { line = rceCommand.unban(player); done = `${code(player)} was unbanned.`; }
  else if (name === 'give') {
    const amount = interaction.options.getInteger('amount') || 1;
    line = rceCommand.giveItem(player, interaction.options.getString('shortname'), amount);
    done = `${code(player)} received ${amount} x ${plain(interaction.options.getString('shortname'), 60)}.`;
  } else if (name === 'kit') {
    line = rceCommand.kit(interaction.options.getString('kit'), player);
    done = `${code(player)} received the kit ${plain(interaction.options.getString('kit'), 32)}.`;
  } else if (name === 'vip') {
    const remove = interaction.options.getBoolean('remove') === true;
    line = remove ? rceCommand.removeVip(player) : rceCommand.addVip(player);
    done = remove ? `VIP was removed from ${code(player)}.` : `${code(player)} is now VIP.`;
  } else {
    const wanted = interaction.options.getString('location');
    const location = config.locations.find(entry => entry.name.toLowerCase() === String(wanted).toLowerCase());
    if (!location) fail('That location does not exist. Add it with /rceconfig location add.');
    line = rceCommand.teleport(player, location);
    done = `${code(player)} was teleported to ${plain(location.name, 32)}.`;
  }
  const reply = await session.send(line);
  await runtime.post(interaction.guildId, 'admin', {
    ...info(`Staff: ${name}`, [`**By:** <@${interaction.user.id}>`, done, reply ? `**Server answer:** ${plain(reply, 200)}` : null].filter(Boolean)).embeds[0],
  });
  return success(`${done}${reply ? `\n**Server answer:** ${plain(reply, 300)}` : ''}`);
}

async function gameCommand(interaction, name) {
  const runtime = requireRuntime();
  const { guildId } = interaction;
  if (name === 'status') {
    const { config, server } = await serverFromOption(interaction, 'server', { required: false });
    const sessions = (server ? [server] : config.servers).map(entry => runtime.session(guildId, entry.id)).filter(Boolean);
    if (!sessions.length) fail('No game server is active.');
    return { embeds: sessions.slice(0, 10).map(session => serverStatusEmbed(session)), allowedMentions: { parse: [] } };
  }
  const { server } = await serverFromOption(interaction);
  if (name === 'log') {
    const session = runtime.session(guildId, server.id);
    const lines = (session?.lines || []).slice(-20).map(entry => `<t:${Math.floor(entry.at / 1000)}:T> ${plain(entry.line, 180)}`);
    return info(`Console · ${plain(server.name, 40)}`, [lines.length ? lines.join('\n') : 'No console lines yet.']);
  }
  if (name === 'wipe') {
    if (interaction.options.getBoolean('confirm') !== true) fail('Nothing was reset.');
    await runtime.resetWipe(guildId, server.id);
    return success(`**${plain(server.name, 40)}** starts a new wipe: leaderboard, kit claims and ZORP zones were reset.`);
  }
  const session = liveSession(runtime, guildId, server);
  if (name === 'players') {
    const players = [...session.players.values()].sort((a, b) => a.name.localeCompare(b.name));
    return info(`Online · ${plain(server.name, 40)}`, [
      `**${players.length}${session.info?.maxPlayers ? `/${session.info.maxPlayers}` : ''} players**`,
      '',
      players.length ? players.slice(0, 80).map(player => `${code(player.name)}${player.since ? ` · ${formatDuration(Date.now() - player.since)}` : ''}`).join('\n') : 'Nobody is online.',
    ]);
  }
  if (name === 'say') {
    await session.send(rceCommand.say(interaction.options.getString('message')));
    return success('The message was sent in game.');
  }
  // console
  const line = safeConsoleLine(interaction.options.getString('command'));
  const reply = await session.send(line);
  await runtime.post(guildId, 'admin', info('Console command', [`**By:** <@${interaction.user.id}>`, `**Command:** ${code(line.slice(0, 60))}`]).embeds[0]);
  return info(`Console · ${plain(server.name, 40)}`, [`**Command:** \`${plain(line, 200)}\``, '', reply ? `\`\`\`\n${String(reply).replace(/```/g, "'''").slice(0, 3500)}\n\`\`\`` : 'The server answered without text.']);
}
