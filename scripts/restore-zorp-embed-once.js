import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
if (!token || !guildId) {
  console.error('[ZORP_RESTORE] Missing DISCORD_TOKEN or GUILD_ID');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function customEmoji(guild, name, fallback = '•') {
  const emoji = guild.emojis.cache.find(item => item.name === name);
  if (!emoji) return fallback;
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

client.once('ready', async () => {
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    await guild.emojis.fetch().catch(() => null);

    const channel = guild.channels.cache.find(ch =>
      String(ch?.name || '').includes('zorp-off-raid-protection') && ch?.messages?.fetch
    );
    if (!channel) throw new Error('Channel containing zorp-off-raid-protection not found');

    const messages = await channel.messages.fetch({ limit: 50 });
    const target = messages.find(message =>
      message.author?.id === client.user.id &&
      message.embeds?.some(embed => /ZORP Guide/i.test(embed.title || ''))
    );
    if (!target) throw new Error('ZORP Guide embed not found in recent messages');

    const index = target.embeds.findIndex(embed => /ZORP Guide/i.test(embed.title || ''));
    const current = target.embeds[index].toJSON();

    const redDot = customEmoji(guild, 'W8733476glowingdotred', '🔴');
    const whiteDot = customEmoji(guild, 'W87205667glowingdotwhite', '⚪');

    const restored = new EmbedBuilder({
      ...current,
      title: '☑️ ZORP Guide',
      description: 'ZORP (Offline raid protection) is a zone protection system that protects your team’s building area while your team is offline.',
      fields: [
        {
          name: 'How to claim a ZORP zone',
          value: [
            'To create a ZORP zone, the player must:',
            '',
            '• Be part of a team.',
            '• Be the Team Leader.',
            '• Use `Can I build around here?`',
            '• Confirm the zone by selecting `Yes`.',
            '',
            '*You can find `Can I build around here?` and `Yes` in the Emote Wheel.*',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Important information',
          value: [
            '• ZORP zones expire after 24 hours.',
            '• The timer is automatically reset while the team is online.',
            '• A team cannot create a ZORP zone that overlaps with another team’s zone.',
            '• If a player switches teams, their existing ZORP zone will be removed to prevent abuse.',
          ].join('\n'),
          inline: false,
        },
        {
          name: 'How to remove a ZORP zone',
          value: [
            'To delete an existing ZORP zone:',
            '',
            `${redDot} Use \`Can I build around here?\``,
            `${redDot} Select \`Good Bye\` to confirm the removal.`,
          ].join('\n'),
          inline: false,
        },
        {
          name: 'Zone colors',
          value: [
            `${whiteDot} **White**`,
            'Newly created zone that will turn green shortly.',
            '🟢 **Green**',
            'Team is currently online.',
            '🟡 **Yellow**',
            'Team is offline; zone is about to turn red.',
            '🔴 **Red**',
            'Team is offline and the zone is protected.',
          ].join('\n'),
          inline: false,
        },
      ],
    });

    const embeds = target.embeds.map((embed, i) => i === index ? restored : new EmbedBuilder(embed.toJSON()));
    await target.edit({ embeds });
    console.log(`[ZORP_RESTORE] RESTORE_ZORP_OK message=${target.id} channel=${channel.id}`);
  } catch (error) {
    console.error('[ZORP_RESTORE] Failed:', error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

await client.login(token);
