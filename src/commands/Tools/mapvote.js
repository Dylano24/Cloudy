import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { parseDuration } from '../../services/giveawayService.js';
import { buildVoteMessage, saveVote } from '../../services/voteService.js';
import { featuredMaps, resolveMap } from '../../services/rustMapsService.js';

function removeAfterTenSeconds(interaction) {
  const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
  timer.unref?.();
}

async function notice(interaction, embed) {
  await interaction.editReply({ embeds: [embed], components: [] });
  removeAfterTenSeconds(interaction);
}

const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

// Your own map picture (e.g. a console screenshot): downloaded from Discord and
// sent again with the vote, so it never expires.
async function ownPicture(attachment, index, fetchImpl = fetch) {
  if (!String(attachment.contentType || '').startsWith('image/')) throw new Error(`Picture ${index} must be an image.`);
  if (attachment.size > MAX_PICTURE_BYTES) throw new Error(`Picture ${index} is larger than 10 MB.`);
  const response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Picture ${index} could not be downloaded.`);
  const extension = (String(attachment.name || '').match(/\.(png|jpe?g|gif|webp)$/i)?.[1] || 'png').toLowerCase();
  const name = `map${index}.${extension}`;
  return { mapId: `own-${index}`, own: true, image: `attachment://${name}`, file: { attachment: Buffer.from(await response.arrayBuffer()), name } };
}

// /mapvote (owner's choice): three Rust maps in one vote embed (small pictures,
// a click opens one in full size) with the numbered buttons. Your own pictures
// (picture1..3) or rustmaps.com maps you give are used; missing ones are picked
// from rustmaps.com.
export default {
  data: (() => {
    const command = new SlashCommandBuilder()
      .setName('mapvote')
      .setDescription('Start a vote between three Rust maps (picked from rustmaps.com).')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
    for (let index = 1; index <= 3; index += 1) {
      command.addStringOption(option => option
        .setName(`map${index}`)
        .setDescription(`Map ${index}: a rustmaps.com link or size_seed (optional, random if empty)`)
        .setRequired(false)
        .setMaxLength(100));
    }
    for (let index = 1; index <= 3; index += 1) {
      command.addAttachmentOption(option => option
        .setName(`picture${index}`)
        .setDescription(`Your own picture for map ${index}, e.g. a screenshot (optional)`)
        .setRequired(false));
    }
    return command.addStringOption(option => option
      .setName('duration')
      .setDescription('How long the vote stays open, e.g. 1h or 2d (optional)')
      .setRequired(false)
      .setMaxLength(10));
  })(),

  async execute(interaction, dependencies = {}) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const warn = text => notice(interaction, setPreservedEmbedColor(warningEmbed('Warning', text), CLOUDY_RED_COLOR));
    if (!interaction.inGuild?.() || !interaction.channel?.send) return warn('Votes only work in a server channel.');
    let endsAt = null;
    const duration = interaction.options.getString('duration')?.trim();
    if (duration) {
      try {
        endsAt = Date.now() + parseDuration(duration);
      } catch (error) {
        return warn(error?.userMessage || 'Use a duration like 30m, 1h or 2d.');
      }
    }
    const resolve = dependencies.resolveMap || resolveMap;
    const featured = dependencies.featuredMaps || featuredMaps;
    let maps;
    try {
      const given = [];
      for (let index = 1; index <= 3; index += 1) {
        const picture = interaction.options.getAttachment?.(`picture${index}`);
        const input = interaction.options.getString(`map${index}`)?.trim();
        if (picture) given.push(await ownPicture(picture, index, dependencies.fetchImpl));
        else given.push(input ? await resolve(input) : null);
      }
      const missing = given.filter(map => !map).length;
      const extra = missing ? await featured(missing, { exclude: given.filter(Boolean).map(map => map.mapId) }) : [];
      maps = given.map(map => map || extra.shift());
    } catch (error) {
      return warn(error?.message || 'Could not get the maps.');
    }
    if (new Set(maps.map(map => map.mapId)).size !== maps.length) return warn('Every map must be different.');
    const vote = {
      messageId: null, channelId: interaction.channelId, guildId: interaction.guildId,
      title: 'Map vote', question: 'Which map do you want to play next?',
      options: maps.map((_, index) => `Map ${index + 1}`),
      optionLinks: maps.map(map => map.pageUrl || null),
      optionNotes: maps.map(map => (map.own ? null : `Size ${map.size} · Seed ${map.seed}`)),
      images: maps.map(map => map.image),
      votes: {}, endsAt, ended: false,
      createdBy: interaction.user.id, createdAt: new Date().toISOString(),
    };
    const files = maps.filter(map => map.file).map(map => map.file);
    const message = await interaction.channel.send({ ...buildVoteMessage(vote), ...(files.length ? { files } : {}) });
    vote.messageId = message.id;
    try {
      await saveVote(interaction.client, interaction.guildId, vote);
    } catch (error) {
      await message.delete().catch(() => {});
      throw error;
    }
    return notice(interaction, successEmbed('Success', 'The map vote is live.'));
  },
};
