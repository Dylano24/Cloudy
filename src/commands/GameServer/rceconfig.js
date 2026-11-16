import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { QUICK_CHAT, QUICK_CHAT_CODES } from '../../services/rce/rceParser.js';
import { safeItemName, safeKitName, safePlayerName, renderCommandTemplate, RceCommandError } from '../../services/rce/rceCommands.js';
import { EMOTE_ACTIONS, RCE_LIMITS, SHOP_TYPES, findServer, getRceConfig, updateRceConfig } from '../../services/rce/rceStore.js';
import { getDeliveries, getLinks, getLists, getZones, mutateLists, removeLink, setLink } from '../../services/rce/rceData.js';
import { code, formatDuration, plain } from '../../services/rce/rceEmbeds.js';
import { fail, info, rceAutocomplete, requireRuntime, runRceCommand, success } from '../../services/rce/rceInteraction.js';

const serverOption = (option, required = false) => option.setName('server').setDescription('Game server (empty = all).').setAutocomplete(true).setRequired(required);
const shopChoices = Object.entries(SHOP_TYPES).map(([value, name]) => ({ name, value }));
const actionChoices = Object.entries(EMOTE_ACTIONS).map(([value, name]) => ({ name, value }));
const ZORP_EMOTES = new Set(Object.values(QUICK_CHAT_CODES));

function checkValue(type, value, config) {
  if (type === 'item') return safeItemName(value);
  if (type === 'kit') return safeKitName(value);
  if (type === 'vip') return '';
  if (type === 'teleport') {
    if (!config.locations.some(entry => entry.name.toLowerCase() === String(value).toLowerCase())) fail('Add the location first with /rceconfig location add.');
    return String(value).trim();
  }
  renderCommandTemplate(value, 'Player');
  return String(value).trim();
}

function serverId(config, value) {
  if (!value) return 'all';
  const server = findServer(config, value);
  if (!server) fail('That game server does not exist.');
  return server.id;
}

const serverLabel = (config, id) => (id === 'all' ? 'All servers' : plain(config.servers.find(server => server.id === id)?.name || id, 40));
const yesNo = value => (value ? 'On' : 'Off');

export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('rceconfig')
    .setDescription('Rust Console setup: shop, emotes, ZORP, links and more.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('settings').setDescription('Feed and in-game settings (empty = show).')
      .addStringOption(o => o.setName('killfeed').setDescription('Which deaths the kill feed shows.').addChoices({ name: 'Player kills', value: 'pvp' }, { name: 'All deaths', value: 'all' }))
      .addBooleanOption(o => o.setName('ingame-killfeed').setDescription('Announce kills in game.'))
      .addBooleanOption(o => o.setName('ingame-joins').setDescription('Announce joins in game.'))
      .addBooleanOption(o => o.setName('ingame-events').setDescription('Announce world events in game.'))
      .addStringOption(o => o.setName('welcome').setDescription('In-game welcome, {player} = name ("off" clears).').setMaxLength(160))
      .addRoleOption(o => o.setName('linked-role').setDescription('Role for linked members.'))
      .addBooleanOption(o => o.setName('announce-claims').setDescription('Announce emote kits in game.'))
      .addBooleanOption(o => o.setName('bounties').setDescription('Allow bounties.'))
      .addIntegerOption(o => o.setName('bounty-min').setDescription('Lowest bounty.').setMinValue(1).setMaxValue(1000000000)))
    .addSubcommand(sub => sub.setName('rewards').setDescription('Money for linked players (0 = off).')
      .addIntegerOption(o => o.setName('kill').setDescription('Per player kill.').setMinValue(0).setMaxValue(1000000))
      .addIntegerOption(o => o.setName('npc-kill').setDescription('Per NPC or animal kill.').setMinValue(0).setMaxValue(1000000))
      .addIntegerOption(o => o.setName('playtime-hour').setDescription('Per hour online.').setMinValue(0).setMaxValue(1000000)))
    .addSubcommandGroup(group => group.setName('shop').setDescription('Discord shop with in-game delivery.')
      .addSubcommand(sub => sub.setName('add').setDescription('Add a shop item.')
        .addStringOption(o => o.setName('name').setDescription('Name.').setRequired(true).setMaxLength(40))
        .addStringOption(o => o.setName('type').setDescription('What is delivered.').setRequired(true).addChoices(...shopChoices))
        .addIntegerOption(o => o.setName('price').setDescription('Price.').setRequired(true).setMinValue(0).setMaxValue(1000000000))
        .addStringOption(o => o.setName('value').setDescription('Item short name, kit name or command with {player}.').setMaxLength(300))
        .addIntegerOption(o => o.setName('amount').setDescription('Item amount.').setMinValue(1).setMaxValue(1000000))
        .addIntegerOption(o => o.setName('cooldown').setDescription('Minutes between buys.').setMinValue(0).setMaxValue(525600))
        .addIntegerOption(o => o.setName('vip-days').setDescription('VIP days (0 = permanent).').setMinValue(0).setMaxValue(365))
        .addStringOption(o => serverOption(o))
        .addStringOption(o => o.setName('description').setDescription('Short description.').setMaxLength(100)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove a shop item.').addStringOption(o => o.setName('item').setDescription('Item.').setRequired(true).setAutocomplete(true)))
      .addSubcommand(sub => sub.setName('list').setDescription('All shop items.')))
    .addSubcommandGroup(group => group.setName('emote').setDescription('In-game emote actions (kits, items, teleports).')
      .addSubcommand(sub => sub.setName('add').setDescription('Run an action when a player uses an emote.')
        .addStringOption(o => o.setName('emote').setDescription('Quick chat emote.').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('action').setDescription('Action.').setRequired(true).addChoices(...actionChoices))
        .addStringOption(o => o.setName('value').setDescription('Kit, item, location or command with {player}.').setRequired(true).setMaxLength(300))
        .addStringOption(o => o.setName('name').setDescription('Name shown in game.').setMaxLength(40))
        .addIntegerOption(o => o.setName('amount').setDescription('Item amount.').setMinValue(1).setMaxValue(1000000))
        .addIntegerOption(o => o.setName('cooldown').setDescription('Minutes per player (default 60).').setMinValue(0).setMaxValue(525600))
        .addIntegerOption(o => o.setName('price').setDescription('Price (needs a link).').setMinValue(0).setMaxValue(1000000000))
        .addBooleanOption(o => o.setName('linked-only').setDescription('Only linked players (default on).'))
        .addBooleanOption(o => o.setName('kit-list').setDescription('Only members on the kit list.'))
        .addBooleanOption(o => o.setName('once-per-wipe').setDescription('Once per wipe.'))
        .addStringOption(o => serverOption(o)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove an emote action.').addStringOption(o => o.setName('action-id').setDescription('Action.').setRequired(true).setAutocomplete(true)))
      .addSubcommand(sub => sub.setName('list').setDescription('All emote actions.')))
    .addSubcommandGroup(group => group.setName('location').setDescription('Teleport locations.')
      .addSubcommand(sub => sub.setName('add').setDescription('Save a teleport location.')
        .addStringOption(o => o.setName('name').setDescription('Name, e.g. Outpost.').setRequired(true).setMaxLength(32))
        .addNumberOption(o => o.setName('x').setDescription('X.').setRequired(true).setMinValue(-10000).setMaxValue(10000))
        .addNumberOption(o => o.setName('y').setDescription('Y (height).').setRequired(true).setMinValue(-10000).setMaxValue(10000))
        .addNumberOption(o => o.setName('z').setDescription('Z.').setRequired(true).setMinValue(-10000).setMaxValue(10000))
        .addStringOption(o => serverOption(o)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove a location.').addStringOption(o => o.setName('location').setDescription('Location.').setRequired(true).setAutocomplete(true)))
      .addSubcommand(sub => sub.setName('list').setDescription('All locations.')))
    .addSubcommandGroup(group => group.setName('automessage').setDescription('Automatic in-game messages.')
      .addSubcommand(sub => sub.setName('add').setDescription('Repeat a message in game.')
        .addStringOption(o => o.setName('text').setDescription('Message.').setRequired(true).setMaxLength(200))
        .addIntegerOption(o => o.setName('minutes').setDescription('Every N minutes.').setRequired(true).setMinValue(5).setMaxValue(1440))
        .addStringOption(o => serverOption(o)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove a message.').addStringOption(o => o.setName('message-id').setDescription('Message.').setRequired(true).setAutocomplete(true)))
      .addSubcommand(sub => sub.setName('list').setDescription('All messages.')))
    .addSubcommandGroup(group => group.setName('zorp').setDescription('Offline raid protection.')
      .addSubcommand(sub => sub.setName('settings').setDescription('ZORP settings (empty = show).')
        .addBooleanOption(o => o.setName('enabled').setDescription('ZORP on.'))
        .addIntegerOption(o => o.setName('radius').setDescription('Zone radius in metres.').setMinValue(10).setMaxValue(150))
        .addIntegerOption(o => o.setName('yellow-minutes').setDescription('Minutes offline before red.').setMinValue(1).setMaxValue(240))
        .addIntegerOption(o => o.setName('expiry-hours').setDescription('Hours offline before removal.').setMinValue(1).setMaxValue(168))
        .addBooleanOption(o => o.setName('require-list').setDescription('Only members on the ZORP list.')))
      .addSubcommand(sub => sub.setName('zones').setDescription('All ZORP zones.').addStringOption(o => serverOption(o, true)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove a ZORP zone.').addStringOption(o => serverOption(o, true))
        .addStringOption(o => o.setName('zone').setDescription('Zone name, e.g. ZORP_1a2b3c.').setRequired(true).setMaxLength(32))))
    .addSubcommandGroup(group => group.setName('access').setDescription('ZORP, kit and VIP lists.')
      .addSubcommand(sub => sub.setName('zorp').setDescription('Add or remove a member on the ZORP list.')
        .addUserOption(o => o.setName('member').setDescription('Member.').setRequired(true))
        .addBooleanOption(o => o.setName('remove').setDescription('Remove instead.')))
      .addSubcommand(sub => sub.setName('kit').setDescription('Add or remove a member on a kit list.')
        .addUserOption(o => o.setName('member').setDescription('Member.').setRequired(true))
        .addStringOption(o => o.setName('kit').setDescription('Kit name.').setRequired(true).setMaxLength(32))
        .addBooleanOption(o => o.setName('remove').setDescription('Remove instead.')))
      .addSubcommand(sub => sub.setName('show').setDescription('Show the lists of a member.').addUserOption(o => o.setName('member').setDescription('Member.').setRequired(true))))
    .addSubcommandGroup(group => group.setName('link').setDescription('Account links.')
      .addSubcommand(sub => sub.setName('set').setDescription('Link a member to a gamertag.')
        .addUserOption(o => o.setName('member').setDescription('Member.').setRequired(true))
        .addStringOption(o => o.setName('gamertag').setDescription('Gamertag or PSN ID.').setRequired(true).setMaxLength(32)))
      .addSubcommand(sub => sub.setName('remove').setDescription('Remove a link.').addUserOption(o => o.setName('member').setDescription('Member.').setRequired(true)))
      .addSubcommand(sub => sub.setName('list').setDescription('All linked members.')))
    .addSubcommandGroup(group => group.setName('delivery').setDescription('Store deliveries (KAOS/Tip4Serv format).')
      .addSubcommand(sub => sub.setName('channel').setDescription('Channel the store posts delivery lines in.')
        .addChannelOption(o => o.setName('channel').setDescription('Channel (empty = off).').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(sub => sub.setName('list').setDescription('Waiting deliveries and deliveries to check.'))
      .addSubcommand(sub => sub.setName('resolve').setDescription('Retry a delivery or mark it delivered.')
        .addStringOption(o => o.setName('id').setDescription('Delivery id.').setRequired(true).setMaxLength(24))
        .addStringOption(o => o.setName('action').setDescription('Action.').setRequired(true).addChoices({ name: 'Send again', value: 'retry' }, { name: 'Delivered (checked in game)', value: 'done' })))),

  autocomplete: rceAutocomplete,

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const name = interaction.options.getSubcommand();
    return runRceCommand(interaction, async () => {
      if (!group && name === 'settings') return settingsCommand(interaction);
      if (!group && name === 'rewards') return rewardsCommand(interaction);
      if (group === 'shop') return shopCommand(interaction, name);
      if (group === 'emote') return emoteCommand(interaction, name);
      if (group === 'location') return locationCommand(interaction, name);
      if (group === 'automessage') return automessageCommand(interaction, name);
      if (group === 'zorp') return zorpCommand(interaction, name);
      if (group === 'access') return accessCommand(interaction, name);
      if (group === 'link') return linkCommand(interaction, name);
      return deliveryCommand(interaction, name);
    });
  },
};

async function settingsCommand(interaction) {
  const options = interaction.options;
  const changes = {
    killfeedMode: options.getString('killfeed'),
    ingameKillfeed: options.getBoolean('ingame-killfeed'),
    ingameJoins: options.getBoolean('ingame-joins'),
    ingameEvents: options.getBoolean('ingame-events'),
    welcomeMessage: options.getString('welcome'),
    linkedRoleId: options.getRole('linked-role')?.id ?? null,
    announceClaims: options.getBoolean('announce-claims'),
    bounties: options.getBoolean('bounties'),
    bountyMin: options.getInteger('bounty-min'),
  };
  const role = options.getRole('linked-role');
  if (role && (role.managed || role.position >= (interaction.guild.members.me?.roles?.highest?.position ?? 0))) fail('Cloudy cannot give that role: move Cloudy\'s role above it.');
  const set = Object.fromEntries(Object.entries(changes).filter(([, value]) => value != null));
  if (set.welcomeMessage && /^off$/i.test(set.welcomeMessage.trim())) set.welcomeMessage = '';
  const { config } = Object.keys(set).length
    ? await updateRceConfig(interaction.client, interaction.guildId, current => { Object.assign(current.settings, set); })
    : { config: await getRceConfig(interaction.client, interaction.guildId) };
  const s = config.settings;
  return info(Object.keys(set).length ? 'Rust settings updated' : 'Rust settings', [
    `**Kill feed:** ${s.killfeedMode === 'all' ? 'All deaths' : 'Player kills'}`,
    `**In-game kill feed:** ${yesNo(s.ingameKillfeed)}`,
    `**In-game joins:** ${yesNo(s.ingameJoins)}`,
    `**In-game events:** ${yesNo(s.ingameEvents)}`,
    `**Welcome message:** ${s.welcomeMessage ? plain(s.welcomeMessage, 160) : 'Off'}`,
    `**Linked role:** ${s.linkedRoleId ? `<@&${s.linkedRoleId}>` : 'Off'}`,
    `**Announce emote kits:** ${yesNo(s.announceClaims)}`,
    `**Bounties:** ${yesNo(s.bounties)} (minimum ${s.bountyMin.toLocaleString('en-US')})`,
    `**Rewards:** kill ${s.rewards.kill} · NPC ${s.rewards.npcKill} · per hour ${s.rewards.playtimeHour}`,
  ]);
}

async function rewardsCommand(interaction) {
  const options = interaction.options;
  const set = Object.fromEntries([['kill', options.getInteger('kill')], ['npcKill', options.getInteger('npc-kill')], ['playtimeHour', options.getInteger('playtime-hour')]].filter(([, value]) => value != null));
  const { config } = await updateRceConfig(interaction.client, interaction.guildId, current => { Object.assign(current.settings.rewards, set); });
  const r = config.settings.rewards;
  return success(`Rewards for linked players: **${r.kill}** per kill, **${r.npcKill}** per NPC kill, **${r.playtimeHour}** per hour online.`);
}

async function shopCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'list') {
    const config = await getRceConfig(client, guildId);
    if (!config.shop.length) return info('Rust shop', ['The shop is empty. Add items with `/rceconfig shop add`.']);
    return info('Rust shop', config.shop.map(item => `**${plain(item.name, 40)}** · ${item.price.toLocaleString('en-US')}\n${SHOP_TYPES[item.type]}${item.value ? ` \`${plain(item.value, 60)}\`` : ''}${item.type === 'item' ? ` x${item.amount}` : ''}${item.type === 'vip' ? ` · ${item.vipDays ? `${item.vipDays} days` : 'permanent'}` : ''}${item.cooldownMinutes ? ` · cooldown ${formatDuration(item.cooldownMinutes * 60_000)}` : ''} · ${serverLabel(config, item.server)}`));
  }
  if (name === 'remove') {
    const id = options.getString('item');
    const { outcome } = await updateRceConfig(client, guildId, config => {
      const item = config.shop.find(entry => entry.id === id || entry.name.toLowerCase() === String(id).toLowerCase());
      if (!item) fail('That item is not in the shop.');
      config.shop = config.shop.filter(entry => entry !== item);
      return item;
    });
    return success(`**${plain(outcome.name, 40)}** was removed from the shop.`);
  }
  const type = options.getString('type');
  const rawValue = options.getString('value') || '';
  if (type !== 'vip' && !rawValue) fail('Enter the item short name, kit name or command in value.');
  const { outcome } = await updateRceConfig(client, guildId, config => {
    if (config.shop.length >= RCE_LIMITS.shop) fail(`The shop can hold ${RCE_LIMITS.shop} items.`);
    const value = checkValue(type, rawValue, config);
    const item = {
      name: options.getString('name').trim(), type, value, price: options.getInteger('price'),
      amount: options.getInteger('amount') || 1, cooldownMinutes: options.getInteger('cooldown') || 0,
      vipDays: options.getInteger('vip-days') || 0, server: serverId(config, options.getString('server')),
      description: options.getString('description') || '',
    };
    config.shop.push(item);
    return item;
  });
  return success(`**${plain(outcome.name, 40)}** was added to the shop for ${outcome.price.toLocaleString('en-US')}. Members buy it with \`/rust buy\`.`);
}

async function emoteCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'list') {
    const config = await getRceConfig(client, guildId);
    if (!config.emotes.length) return info('Emote actions', ['No emote actions yet. Add one with `/rceconfig emote add`, for example a starter kit on "Hello".']);
    return info('Emote actions', config.emotes.map(binding => `**${plain(QUICK_CHAT[binding.trigger], 40)}** → ${plain(binding.name || `${EMOTE_ACTIONS[binding.action]} ${binding.value}`, 60)}\n${EMOTE_ACTIONS[binding.action]} \`${plain(binding.value, 50)}\`${binding.action === 'item' ? ` x${binding.amount}` : ''} · cooldown ${formatDuration(binding.cooldownMinutes * 60_000)}${binding.price ? ` · price ${binding.price.toLocaleString('en-US')}` : ''}${binding.kitList ? ' · kit list' : ''}${binding.oncePerWipe ? ' · once per wipe' : ''}${binding.linkedOnly ? ' · linked' : ''} · ${serverLabel(config, binding.server)}`));
  }
  if (name === 'remove') {
    const id = options.getString('action-id');
    const { outcome } = await updateRceConfig(client, guildId, config => {
      const binding = config.emotes.find(entry => entry.id === id);
      if (!binding) fail('That emote action does not exist.');
      config.emotes = config.emotes.filter(entry => entry !== binding);
      return binding;
    });
    return success(`The action on **${plain(QUICK_CHAT[outcome.trigger], 40)}** was removed.`);
  }
  const trigger = options.getString('emote');
  if (!Object.hasOwn(QUICK_CHAT, trigger)) fail('Choose an emote from the list.');
  const action = options.getString('action');
  const { config: saved, outcome } = await updateRceConfig(client, guildId, config => {
    if (config.emotes.length >= RCE_LIMITS.emotes) fail(`You can add up to ${RCE_LIMITS.emotes} emote actions.`);
    const binding = {
      trigger, action, value: checkValue(action, options.getString('value'), config),
      name: options.getString('name') || '', amount: options.getInteger('amount') || 1,
      cooldownMinutes: options.getInteger('cooldown') ?? 60, price: options.getInteger('price') || 0,
      linkedOnly: options.getBoolean('linked-only') ?? true, kitList: options.getBoolean('kit-list') === true,
      oncePerWipe: options.getBoolean('once-per-wipe') === true, server: serverId(config, options.getString('server')),
    };
    if (binding.kitList && action !== 'kit') fail('A kit list only works with the Kit action.');
    config.emotes.push(binding);
    return binding;
  });
  const clash = saved.zorp.enabled && ZORP_EMOTES.has(trigger);
  return success(`Players who use **${plain(QUICK_CHAT[outcome.trigger], 40)}** get ${plain(outcome.name || `${EMOTE_ACTIONS[outcome.action].toLowerCase()} ${outcome.value}`, 60)}.${clash ? '\nNote: ZORP also uses this emote; ZORP goes first right after "Can I build around here?".' : ''}`);
}

async function locationCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'list') {
    const config = await getRceConfig(client, guildId);
    if (!config.locations.length) return info('Teleport locations', ['No locations yet. Add one with `/rceconfig location add`.']);
    return info('Teleport locations', config.locations.map(entry => `**${plain(entry.name, 32)}** · (${entry.x}, ${entry.y}, ${entry.z}) · ${serverLabel(config, entry.server)}`));
  }
  if (name === 'remove') {
    const wanted = String(options.getString('location')).toLowerCase();
    await updateRceConfig(client, guildId, config => {
      if (!config.locations.some(entry => entry.name.toLowerCase() === wanted)) fail('That location does not exist.');
      config.locations = config.locations.filter(entry => entry.name.toLowerCase() !== wanted);
    });
    return success('The location was removed.');
  }
  const location = { name: options.getString('name').trim(), x: options.getNumber('x'), y: options.getNumber('y'), z: options.getNumber('z') };
  await updateRceConfig(client, guildId, config => {
    if (config.locations.length >= RCE_LIMITS.locations && !config.locations.some(entry => entry.name.toLowerCase() === location.name.toLowerCase())) fail(`You can save up to ${RCE_LIMITS.locations} locations.`);
    config.locations = config.locations.filter(entry => entry.name.toLowerCase() !== location.name.toLowerCase());
    config.locations.push({ ...location, server: serverId(config, options.getString('server')) });
  });
  return success(`**${plain(location.name, 32)}** was saved. Use it with the Teleport emote action or \`/rce player teleport\`.`);
}

async function automessageCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'list') {
    const config = await getRceConfig(client, guildId);
    if (!config.automessages.length) return info('Automatic messages', ['No automatic messages yet.']);
    return info('Automatic messages', config.automessages.map(message => `**Every ${formatDuration(message.intervalMinutes * 60_000)}** · ${serverLabel(config, message.server)}\n${plain(message.text, 200)}`));
  }
  if (name === 'remove') {
    const id = options.getString('message-id');
    await updateRceConfig(client, guildId, config => {
      if (!config.automessages.some(entry => entry.id === id)) fail('That message does not exist.');
      config.automessages = config.automessages.filter(entry => entry.id !== id);
    });
    return success('The automatic message was removed.');
  }
  await updateRceConfig(client, guildId, config => {
    if (config.automessages.length >= RCE_LIMITS.automessages) fail(`You can add up to ${RCE_LIMITS.automessages} automatic messages.`);
    config.automessages.push({ text: options.getString('text').trim(), intervalMinutes: options.getInteger('minutes'), server: serverId(config, options.getString('server')) });
  });
  return success(`The message is sent in game every ${formatDuration(options.getInteger('minutes') * 60_000)}.`);
}

async function zorpCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'settings') {
    const set = Object.fromEntries([
      ['enabled', options.getBoolean('enabled')], ['radius', options.getInteger('radius')],
      ['yellowMinutes', options.getInteger('yellow-minutes')], ['expiryHours', options.getInteger('expiry-hours')],
      ['requireList', options.getBoolean('require-list')],
    ].filter(([, value]) => value != null));
    const { config } = Object.keys(set).length
      ? await updateRceConfig(client, guildId, current => { Object.assign(current.zorp, set); })
      : { config: await getRceConfig(client, guildId) };
    const z = config.zorp;
    return info(Object.keys(set).length ? 'ZORP updated' : 'ZORP', [
      `**ZORP:** ${yesNo(z.enabled)}`, `**Radius:** ${z.radius} m`, `**Red after:** ${z.yellowMinutes} minutes offline`,
      `**Removed after:** ${z.expiryHours} hours offline`, `**Only the ZORP list:** ${yesNo(z.requireList)}`,
      '', 'Players create a zone as team leader with **Can I build around here?** and confirm with **Yes**; **Goodbye** removes it.',
    ]);
  }
  const config = await getRceConfig(client, guildId);
  const server = findServer(config, options.getString('server'));
  if (!server) fail('That game server does not exist.');
  if (name === 'zones') {
    const { zones } = await getZones(client, guildId, server.id);
    const list = Object.values(zones);
    if (!list.length) return info(`ZORP zones · ${plain(server.name, 40)}`, ['No ZORP zones.']);
    return info(`ZORP zones · ${plain(server.name, 40)}`, list.slice(0, 40).map(zone => `**${zone.name}** · ${code(zone.ownerName)} · ${zone.state}\n(${Math.round(zone.position.x)}, ${Math.round(zone.position.z)}) · ${zone.members.length} member(s)`));
  }
  const runtime = requireRuntime();
  const removed = await runtime.zorp.removeZone(guildId, server.id, options.getString('zone').trim(), runtime.session(guildId, server.id), 'removed');
  if (!removed) fail('That zone does not exist.');
  return success(`The ZORP zone of ${code(removed.ownerName)} was removed.`);
}

async function accessCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  const member = options.getUser('member');
  if (name === 'show') {
    const lists = await getLists(client, guildId);
    const kits = Object.entries(lists.kitLists).filter(([, ids]) => ids.includes(member.id)).map(([kit]) => kit);
    const vip = lists.vip[member.id];
    return info('Rust access', [
      `**Member:** <@${member.id}>`, `**ZORP list:** ${lists.zorp.includes(member.id) ? 'Yes' : 'No'}`,
      `**Kit lists:** ${kits.length ? kits.map(kit => `\`${plain(kit, 32)}\``).join(', ') : 'None'}`,
      `**VIP:** ${vip ? (vip.until ? `until <t:${Math.floor(vip.until / 1000)}:f>` : 'Permanent') : 'No'}`,
      `**Rider list:** ${lists.rider.includes(member.id) ? 'Yes' : 'No'}`,
    ]);
  }
  const remove = options.getBoolean('remove') === true;
  if (name === 'zorp') {
    await mutateLists(client, guildId, lists => {
      const set = new Set(lists.zorp);
      if (remove) set.delete(member.id); else set.add(member.id);
      lists.zorp = [...set];
    });
    return success(`<@${member.id}> was ${remove ? 'removed from' : 'added to'} the ZORP list.`);
  }
  const kit = safeKitName(options.getString('kit'));
  await mutateLists(client, guildId, lists => {
    const set = new Set(lists.kitLists[kit] || []);
    if (remove) set.delete(member.id); else set.add(member.id);
    lists.kitLists[kit] = [...set];
  });
  return success(`<@${member.id}> was ${remove ? 'removed from' : 'added to'} the kit list of \`${plain(kit, 32)}\`.`);
}

async function linkCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'list') {
    const links = await getLinks(client, guildId);
    const entries = Object.entries(links.byDiscord);
    if (!entries.length) return info('Linked members', ['Nobody is linked yet. Members link with `/rust link`.']);
    return info('Linked members', [`**${entries.length} linked**`, '', ...entries.slice(0, 60).map(([id, link]) => `<@${id}> · ${code(link.gamertag)}`)]);
  }
  const member = options.getUser('member');
  if (name === 'remove') {
    const previous = await removeLink(client, guildId, member.id);
    if (!previous) fail('That member is not linked.');
    return success(`<@${member.id}> is no longer linked to ${code(previous.gamertag)}.`);
  }
  let gamertag;
  try { gamertag = safePlayerName(options.getString('gamertag')); } catch (error) { if (error instanceof RceCommandError) fail(error.message); throw error; }
  await setLink(client, guildId, member.id, gamertag, { method: 'staff', force: true });
  await requireRuntime().deliveries.onLinked(guildId, member.id).catch(() => undefined);
  return success(`<@${member.id}> is linked to ${code(gamertag)}.`);
}

async function deliveryCommand(interaction, name) {
  const { client, guildId, options } = interaction;
  if (name === 'channel') {
    const channel = options.getChannel('channel');
    if (channel && !channel.permissionsFor?.(interaction.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions])) {
      fail('Cloudy needs View Channel, Read Message History and Add Reactions in that channel.');
    }
    await updateRceConfig(client, guildId, config => { config.delivery.channelId = channel?.id || null; });
    return channel
      ? success(`Delivery lines in <#${channel.id}> are delivered in game, for example \`[KAOS][ADD][<@id>][1]=[KIT][starter][1]\`. Point your store's Discord message there.`)
      : success('Store deliveries are off.');
  }
  if (name === 'list') {
    const state = await getDeliveries(client, guildId);
    const review = state.done.filter(entry => entry.status === 'needs_review' || entry.status === 'failed').slice(-15);
    const describe = entry => `\`${entry.id}\` <@${entry.discordId}> · ${entry.kind}${entry.value ? ` ${plain(entry.value, 30)}` : ''}${entry.amount > 1 ? ` x${entry.amount}` : ''} · ${entry.serverId}${entry.lastError ? ` · ${plain(entry.lastError, 60)}` : ''}`;
    return info('Store deliveries', [
      `**Waiting (${state.pending.length}):** for a link or for the player to join`,
      ...state.pending.slice(0, 15).map(describe),
      '',
      `**To check (${review.length}):**`,
      ...(review.length ? review.map(entry => `${entry.status === 'failed' ? 'Failed' : 'Check in game'} · ${describe(entry)}`) : ['None']),
    ]);
  }
  const result = await requireRuntime().deliveries.staffAction(guildId, options.getString('id').trim(), options.getString('action'));
  return success(`The delivery was ${result}.`);
}
