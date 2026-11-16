import { SlashCommandBuilder } from 'discord.js';
import { SHOP_TYPES, getRceConfig, findServer } from '../../services/rce/rceStore.js';
import { getBounties, getLinks, getZones, linkForDiscord, playerKey, rankPlayers, removeLink } from '../../services/rce/rceData.js';
import { code, formatDuration, plain, serverStatusEmbed, RCE_COLORS } from '../../services/rce/rceEmbeds.js';
import { fail, info, rceAutocomplete, requireRuntime, runRceCommand, success } from '../../services/rce/rceInteraction.js';

const serverOption = option => option.setName('server').setDescription('Game server.').setAutocomplete(true);
const publicOption = option => option.setName('public').setDescription('Show it to everyone in the channel.');
const BOARDS = Object.freeze({ kills: 'Kills', kd: 'K/D', playtime: 'Playtime', streak: 'Best killstreak', npc: 'NPC kills' });

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('rust')
    .setDescription('Rust Console: link your account, stats, shop and more.')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('link').setDescription('Link your gamertag to Discord.')
      .addStringOption(o => o.setName('gamertag').setDescription('Your Xbox gamertag or PSN ID.').setRequired(true).setMaxLength(32)))
    .addSubcommand(sub => sub.setName('unlink').setDescription('Remove the link with your gamertag.'))
    .addSubcommand(sub => sub.setName('profile').setDescription('Your link, stats and lists.')
      .addUserOption(o => o.setName('member').setDescription('Another member.')))
    .addSubcommand(sub => sub.setName('stats').setDescription('Player statistics.')
      .addStringOption(o => o.setName('player').setDescription('Gamertag (empty = you).').setAutocomplete(true).setMaxLength(32))
      .addStringOption(serverOption).addBooleanOption(publicOption))
    .addSubcommand(sub => sub.setName('leaderboard').setDescription('Top players of this wipe.')
      .addStringOption(o => o.setName('type').setDescription('Ranking.').addChoices(...Object.entries(BOARDS).map(([value, name]) => ({ name, value }))))
      .addStringOption(serverOption).addBooleanOption(publicOption))
    .addSubcommand(sub => sub.setName('online').setDescription('Who is online.').addStringOption(serverOption).addBooleanOption(publicOption))
    .addSubcommand(sub => sub.setName('status').setDescription('Server status.').addStringOption(serverOption).addBooleanOption(publicOption))
    .addSubcommand(sub => sub.setName('shop').setDescription('Items you can buy and get in game.'))
    .addSubcommand(sub => sub.setName('buy').setDescription('Buy a shop item, delivered in game.')
      .addStringOption(o => o.setName('item').setDescription('Item.').setRequired(true).setAutocomplete(true))
      .addStringOption(serverOption))
    .addSubcommand(sub => sub.setName('zone').setDescription('The ZORP zone of your team.').addStringOption(serverOption))
    .addSubcommandGroup(group => group.setName('bounty').setDescription('Bounties on players.')
      .addSubcommand(sub => sub.setName('place').setDescription('Put a bounty on a player.')
        .addStringOption(o => o.setName('player').setDescription('Gamertag.').setRequired(true).setAutocomplete(true).setMaxLength(32))
        .addIntegerOption(o => o.setName('amount').setDescription('Amount from your wallet.').setRequired(true).setMinValue(1).setMaxValue(1000000000)))
      .addSubcommand(sub => sub.setName('list').setDescription('Open bounties.').addBooleanOption(publicOption))),

  autocomplete: rceAutocomplete,

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const name = interaction.options.getSubcommand();
    const visible = interaction.options.getBoolean('public') === true;
    return runRceCommand(interaction, () => {
      if (group === 'bounty') return bountyCommand(interaction, name);
      return handlers[name](interaction);
    }, { visible });
  },
};

async function chosenServers(interaction, { onlyOne = false } = {}) {
  const config = await getRceConfig(interaction.client, interaction.guildId);
  if (!config.servers.length) fail('This server has no Rust game server connected yet.');
  const value = interaction.options.getString('server');
  if (value) {
    const server = findServer(config, value);
    if (!server) fail('That game server does not exist.');
    return { config, servers: [server] };
  }
  return { config, servers: onlyOne ? [config.servers[0]] : config.servers };
}

const handlers = {
  async link(interaction) {
    const runtime = requireRuntime();
    const config = await getRceConfig(interaction.client, interaction.guildId);
    if (!config.servers.length) fail('This server has no Rust game server connected yet.');
    const gamertag = interaction.options.getString('gamertag');
    const started = await runtime.startLink(interaction.guildId, interaction.user.id, gamertag, async ({ gamertag: linked }) => {
      await interaction.editReply(success(`Your Discord account is now linked to ${code(linked)}.`)).catch(() => undefined);
    });
    return info('Link your account', [
      `Prove in game that ${code(gamertag)} is you. You have **10 minutes**; join one of the servers first.`,
      '',
      '**Option 1: emotes**',
      `Use these quick chat emotes in this order: ${started.emotes.map(label => `**${plain(label, 30)}**`).join(' → ')}`,
      '',
      '**Option 2: a note**',
      `Write \`${started.code}\` on a note in your inventory.`,
      '',
      `This message changes as soon as your account is linked. Expires <t:${Math.floor(started.expiresAt / 1000)}:R>.`,
    ], { color: RCE_COLORS.white });
  },

  async unlink(interaction) {
    const previous = await removeLink(interaction.client, interaction.guildId, interaction.user.id);
    requireRuntime().cancelLink(interaction.guildId, interaction.user.id);
    if (!previous) fail('Your account is not linked.');
    const config = await getRceConfig(interaction.client, interaction.guildId);
    if (config.settings.linkedRoleId) await interaction.member?.roles?.remove?.(config.settings.linkedRoleId, 'Rust account unlinked').catch(() => undefined);
    return success(`Your account is no longer linked to ${code(previous.gamertag)}.`);
  },

  async profile(interaction) {
    const user = interaction.options.getUser('member') || interaction.user;
    const runtime = requireRuntime();
    const config = await getRceConfig(interaction.client, interaction.guildId);
    const link = linkForDiscord(await getLinks(interaction.client, interaction.guildId), user.id);
    if (!link) fail(user.id === interaction.user.id ? 'Your account is not linked. Use /rust link.' : 'That member has not linked a gamertag.');
    const lines = [`**Member:** <@${user.id}>`, `**Gamertag:** ${code(link.gamertag)}`, link.platform ? `**Platform:** ${link.platform === 'xbox' ? 'Xbox' : 'PlayStation'}` : null, ''];
    for (const server of config.servers) {
      const state = await runtime.stats.load(interaction.guildId, server.id);
      const entry = state.players[playerKey(link.gamertag)];
      const online = runtime.session(interaction.guildId, server.id)?.isOnline(link.gamertag);
      lines.push(`**${plain(server.name, 40)}**${online ? ' · online now' : ''}`);
      lines.push(entry ? `Kills ${entry.kills} · Deaths ${entry.deaths} · K/D ${(entry.deaths ? entry.kills / entry.deaths : entry.kills).toFixed(2)} · Played ${formatDuration(entry.playtimeMs)}` : 'No statistics yet.');
    }
    return info('Rust profile', lines.filter(line => line != null));
  },

  async stats(interaction) {
    const runtime = requireRuntime();
    let player = interaction.options.getString('player');
    if (!player) {
      const link = linkForDiscord(await getLinks(interaction.client, interaction.guildId), interaction.user.id);
      if (!link) fail('Enter a gamertag, or link yours with /rust link.');
      player = link.gamertag;
    }
    const { servers } = await chosenServers(interaction);
    const fields = [];
    for (const server of servers.slice(0, 10)) {
      const state = await runtime.stats.load(interaction.guildId, server.id);
      const entry = state.players[playerKey(player)];
      if (!entry) continue;
      const kd = entry.deaths ? entry.kills / entry.deaths : entry.kills;
      fields.push({
        name: plain(server.name, 60),
        value: [
          `**Kills:** ${entry.kills} · **Deaths:** ${entry.deaths} · **K/D:** ${kd.toFixed(2)}`,
          `**NPC kills:** ${entry.npcKills} · **Suicides:** ${entry.suicides}`,
          `**Killstreak:** ${entry.streak} (best ${entry.bestStreak})`,
          `**Played:** ${formatDuration(entry.playtimeMs)} · **Last seen:** <t:${Math.floor(entry.lastSeen / 1000)}:R>`,
        ].join('\n'),
      });
    }
    if (!fields.length) fail(`No statistics for ${plain(player, 32)} yet.`);
    return info(`Stats · ${plain(player, 32)}`, [], { fields });
  },

  async leaderboard(interaction) {
    const runtime = requireRuntime();
    const type = interaction.options.getString('type') || 'kills';
    const { servers } = await chosenServers(interaction);
    const embeds = [];
    for (const server of servers.slice(0, 5)) {
      const state = await runtime.stats.load(interaction.guildId, server.id);
      const ranked = rankPlayers(state, type, 10);
      const value = player => (type === 'kd' ? player.kd.toFixed(2) : type === 'playtime' ? formatDuration(player.playtimeMs) : type === 'streak' ? player.bestStreak : type === 'npc' ? player.npcKills : player.kills);
      embeds.push(info(`${BOARDS[type]} leaderboard`, [
        `**${plain(server.name, 40)}** · since <t:${Math.floor(state.since / 1000)}:d>`,
        '',
        ranked.length ? ranked.map((player, index) => `**${index + 1}.** ${code(player.name)} · ${value(player)}${type === 'kills' ? ` (K/D ${player.kd.toFixed(2)})` : ''}`).join('\n') : 'No statistics yet.',
      ]).embeds[0]);
    }
    return { embeds, allowedMentions: { parse: [] } };
  },

  async online(interaction) {
    const runtime = requireRuntime();
    const { servers } = await chosenServers(interaction);
    const lines = [];
    for (const server of servers.slice(0, 5)) {
      const session = runtime.session(interaction.guildId, server.id);
      const players = session?.online ? [...session.players.values()].sort((a, b) => a.name.localeCompare(b.name)) : [];
      lines.push(`**${plain(server.name, 40)}** · ${session?.online ? `${players.length}${session.info?.maxPlayers ? `/${session.info.maxPlayers}` : ''} online` : 'Offline'}`);
      if (players.length) lines.push(players.slice(0, 60).map(player => code(player.name)).join(', '));
      lines.push('');
    }
    return info('Online players', lines);
  },

  async status(interaction) {
    const runtime = requireRuntime();
    const { servers } = await chosenServers(interaction);
    const embeds = servers.slice(0, 10).map(server => runtime.session(interaction.guildId, server.id)).filter(Boolean).map(session => serverStatusEmbed(session));
    if (!embeds.length) fail('No game server is connected right now.');
    return { embeds, allowedMentions: { parse: [] } };
  },

  async shop(interaction) {
    const config = await getRceConfig(interaction.client, interaction.guildId);
    if (!config.shop.length) fail('The shop is empty.');
    return info('Rust shop', [
      ...config.shop.map(item => `**${plain(item.name, 40)}** · ${item.price ? item.price.toLocaleString('en-US') : 'Free'}${item.description ? `\n${plain(item.description, 100)}` : ''}\n${SHOP_TYPES[item.type]}${item.type === 'item' ? ` x${item.amount}` : ''}${item.type === 'vip' ? ` · ${item.vipDays ? `${item.vipDays} days` : 'permanent'}` : ''}${item.cooldownMinutes ? ` · once per ${formatDuration(item.cooldownMinutes * 60_000)}` : ''}${item.server !== 'all' ? ` · ${plain(config.servers.find(server => server.id === item.server)?.name || item.server, 40)}` : ''}`),
      '',
      'Buy with `/rust buy`. Link your gamertag first and be online in game.',
    ]);
  },

  async buy(interaction) {
    const runtime = requireRuntime();
    const result = await runtime.buy(interaction.guildId, interaction.user.id, interaction.options.getString('item'), interaction.options.getString('server'));
    return result.unsure
      ? info('Delivery sent', [`**${plain(result.item.name, 40)}** was sent to ${plain(result.session.name, 40)}, but the server did not confirm it in time. Staff can check it if it did not arrive.`], { color: RCE_COLORS.yellow })
      : success(`**${plain(result.item.name, 40)}** was delivered on ${plain(result.session.name, 40)}.`);
  },

  async zone(interaction) {
    const runtime = requireRuntime();
    const link = linkForDiscord(await getLinks(interaction.client, interaction.guildId), interaction.user.id);
    if (!link) fail('Link your gamertag first with /rust link.');
    const { servers } = await chosenServers(interaction);
    const lines = [];
    for (const server of servers) {
      const session = runtime.session(interaction.guildId, server.id);
      const team = session?.teamOf(link.gamertag);
      const { zones } = await getZones(interaction.client, interaction.guildId, server.id);
      const zone = Object.values(zones).find(entry => (team && entry.teamId === team.id) || entry.ownerKey === playerKey(link.gamertag)
        || entry.members.some(member => playerKey(member) === playerKey(link.gamertag)));
      if (!zone) continue;
      const state = { white: 'New', green: 'Team online (raidable)', yellow: 'Team offline, protection starts soon', red: 'Protected' }[zone.state] || zone.state;
      lines.push(`**${plain(server.name, 40)}** · \`${zone.name}\``, `**State:** ${state}`, `**Leader:** ${code(zone.ownerName)}`, `**Members:** ${zone.members.map(code).join(', ') || '-'}`, '');
    }
    if (!lines.length) fail('Your team has no ZORP zone.');
    return info('Your ZORP zone', lines);
  },
};

async function bountyCommand(interaction, name) {
  const runtime = requireRuntime();
  if (name === 'list') {
    const bounties = Object.values(await getBounties(interaction.client, interaction.guildId)).filter(entry => entry?.total > 0)
      .sort((a, b) => b.total - a.total).slice(0, 20);
    if (!bounties.length) return info('Bounties', ['There are no open bounties.']);
    return info('Bounties', bounties.map((entry, index) => `**${index + 1}.** ${code(entry.name)} · ${entry.total.toLocaleString('en-US')}`));
  }
  const player = interaction.options.getString('player');
  const amount = interaction.options.getInteger('amount');
  const entry = await runtime.placeBounty(interaction.guildId, interaction.user.id, player, amount);
  for (const session of runtime.guildSessions(interaction.guildId)) {
    if (session.online) await runtime.say(session, `A bounty of ${amount.toLocaleString('en-US')} was placed on ${entry.name} (total ${entry.total.toLocaleString('en-US')})`);
  }
  return success(`You placed a bounty of **${amount.toLocaleString('en-US')}** on ${code(entry.name)}. Total: **${entry.total.toLocaleString('en-US')}**.`);
}
