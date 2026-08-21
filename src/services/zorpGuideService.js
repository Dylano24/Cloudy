import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getTermsTitleIcon } from './termsIconService.js';

export const ZORP_GUIDE_CHANNEL_ID = '1533212973034770462';

const ZORP_COLOR_EMOJIS = {
  white: {
    name: 'cloudy_zorp_white',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABZklEQVR42u2bMRaEIAxEZU5j7/2PYO9tdisbnwskRDaJM7VK5hMCT+OyUBRFvVhl5mDrun56rz2Oo6QAIDH9Dxhltul935v3b9s2DUZ52niPYQ0QKxDlKfMWxlsgLCCUCMafBFGszM8wXgOhhYCo5q/jancbRDVvBQGRzVtAQHTzoxCQwfwIBIwM4h2CGYCTpnfzVwg9WQBJ6kdUK35kSX1tvMg8+z0+kHH2JXFjebmQpfJrdwRmAAEkrv49vpCx+kt8cAkQAAEQAAEQAAEQwK1qX2kjqebjFsCs5oTZuvPFJUAAjXSJXgfO+H8ta2bAaBWNWv27AGTZDWo+YEkz2ux3AYieBa34IXlIlCxoVf6hXcA7BGl80KSSVwiarjFo15M3CNqWOYwUFS8QRvoFVSdBTxBGmyXVR2EPECw6RdkrbBXUa7vFaxCsQIT4X6AFQgIk7B8jUhhW53nXALQwsr6YpSjKl760JOFiats5aQAAAABJRU5ErkJggg=='
  },
  green: {
    name: 'cloudy_zorp_green',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABaklEQVR42u2byxGDMAxE8c6kF9eWglKbe8khOXFhiD+ycCSxewasfZZlD4htoyiKurHSysFyzp/ea0spKQSAEdP/gJFWm36/cvP+x7Msg5GuNt5jWAJEC0S6yryG8RYIDQjJg/ErQSQt8yuM10BIIcCr+eO40t0GXs1rQYBn8xoQ4N38LAREMD8DATODWIegBmCnad38EUJPFmAk9T2qFT+ipL40XkSe/R4fiDj7I3Fju7kQpfJLdwRmAAEErv49vhCx+o/44BIgAAIgAAIgAAIggFPVvtJ6Us3HKYBVzQmrdeaLS4AAGunivQ7s8f9a1syA2Srqtfp3AYiyG9R8QJOmt9nvAuA9C1rxY+QhXrKgVfmndgHrEEbjgySVrEKQdI1Bup6sQZC2zGGmqFiBMNMvKDoJWoIw2ywpPgpbgKDRKcpeYa2gbtstXoOgBcLF/wItECNA3P4xMgpD6zxvGoAURtQXsxRF2dIXKXLhYkp4k44AAAAASUVORK5CYII='
  },
  yellow: {
    name: 'cloudy_zorp_yellow',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABbUlEQVR42u2bOxLCMAxE453hLum5EEfjQvS5CwVUNEzwR1KMpOzWSax9lmVPoiwLRVHUiVVmDrau66v32m3bSgoAI6b/AaPMNv24P5v3X2+XaTDK0cZ7DEuAWIEoR5m3MN4CYQGhRDB+JIhiZX6G8RoIKQRENf89rnS3QVTzVhAQ2bwFBEQ3r4WADOY1EKAZxDsEMwAfmt7Nf0PoyQKMpH5EteJHltSXxovMs9/jAxlnfyRuLCcXslR+6Y7ADCCAxNW/xxcyVv8RH1wCBEAABEAABEAABLCr2lfaSKr52AUwqzlhtvZ8cQkQQCNdoteBT/y/ljUzQFtFo1b/LgBZdoOaD1jSjDb7XQCiZ0Erfow8JEoWtCq/ahfwDmE0PkhSySsESdcYpOvJGwRpyxw0RcULBE2/oOgk6AmCtllSfBT2AMGiU5S9wlZBnbZbvAbBCkSI/wVaIEaAhP1jZBSG1XneNQApjKwvZimK8qU3M3/hYp2YXdoAAAAASUVORK5CYII='
  },
  red: {
    name: 'cloudy_zorp_red',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABbklEQVR42u2bvRXCMAyE41uAmg2yCTOzSTagZgKoaHjBP5JiJOWuTmLdZ1n2S5RloSiKOrHKzMHWdX31XrttW0kBYMT0P2CU2abvl2vz/tvzMQ1GOdp4j2EJECsQ5SjzFsZbICwglAjGjwRRrMzPMF4DIYWAqOa/x5XuNohq3goCIpu3gIDo5rUQkMG8BgI0g3iHYAbgQ9O7+W8IPVmAkdSPqFb8yJL60niRefZ7fCDj7I/EjeXkQpbKL90RmAEEkLj69/hCxuo/4oNLgAAIgAAIgAAIgAB2VftKG0k1H7sAZjUnzNaeLy4BAmikS/Q68In/17JmBmiraNTq3wUgy25Q8wFLmtFmvwtA9CxoxY+Rh0TJglblV+0C3iGMxgdJKnmFIOkag3Q9eYMgbZmDpqh4gaDpFxSdBD1B0DZLio/CHiBYdIqyV9gqqNN2i9cgWIEI8b9AC8QIkLB/jIzCsDrPuwYghZH1xSxFUb70Brr+4WLGH3zcAAAAAElFTkSuQmCC'
  }
};

let cachedZorpColorEmojis = null;
let pendingZorpColorEmojis = null;

async function getZorpColorEmojis(client) {
  if (cachedZorpColorEmojis) return cachedZorpColorEmojis;
  if (pendingZorpColorEmojis) return pendingZorpColorEmojis;

  pendingZorpColorEmojis = (async () => {
    try {
      const application = client.application ?? await client.fetchApplication();
      const emojis = await application.emojis.fetch();
      const result = {};

      for (const [key, config] of Object.entries(ZORP_COLOR_EMOJIS)) {
        let emoji = emojis.find(item => item.name === config.name);

        if (!emoji) {
          emoji = await application.emojis.create({
            name: config.name,
            attachment: Buffer.from(config.base64, 'base64')
          });
          logger.info(`[ZORP] Created application emoji ${config.name} (${emoji.id}).`);
        }

        result[key] = emoji.toString();
      }

      cachedZorpColorEmojis = result;
      return result;
    } catch (error) {
      logger.warn('[ZORP] Could not load/create ZORP color emojis; falling back to Unicode.', error);
      return {
        white: '⚪',
        green: '🟢',
        yellow: '🟡',
        red: '🔴'
      };
    } finally {
      pendingZorpColorEmojis = null;
    }
  })();

  return pendingZorpColorEmojis;
}

function buildZorpSections(colorEmojis) {
  return [
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
    },
    {
      name: 'Important information',
      value: [
        '• ZORP zones expire after 24 hours.',
        '• The timer is automatically reset while the team is online.',
        '• A team cannot create a ZORP zone that overlaps with another team’s zone.',
        '• If a player switches teams, their existing ZORP zone will be removed to prevent abuse.',
      ].join('\n'),
    },
    {
      name: 'How to remove a ZORP zone',
      value: [
        'To delete an existing ZORP zone:',
        '',
        '• Use `Can I build around here?`',
        '• Select `Good Bye` to confirm the removal.',
      ].join('\n'),
    },
    {
      name: 'Zone colors',
      value: [
        `${colorEmojis.white} **White**`,
        'Newly created zone that will turn green shortly.',
        `${colorEmojis.green} **Green**`,
        'Team is currently online.',
        `${colorEmojis.yellow} **Yellow**`,
        'Team is offline; zone is about to turn red.',
        `${colorEmojis.red} **Red**`,
        'Team is offline and the zone is protected.',
      ].join('\n'),
    },
  ];
}

function buildZorpGuideEmbed(titleIcon = '', colorEmojis) {
  const title = titleIcon ? `${titleIcon} ZORP Guide` : 'ZORP Guide';
  const footerText = '© Cloudy Inc. • Quality. Innovation. Performance.';
  const sections = buildZorpSections(colorEmojis);

  const embed = new EmbedBuilder()
    .setColor('#FFFFFF')
    .setTitle(title)
    .setDescription(
      'ZORP is a zone protection system that protects your team’s building area while your team is offline.'
    )
    .addFields(
      sections.map(section => ({
        name: `\u200b\n${section.name}`,
        value: section.value,
        inline: false,
      }))
    )
    .setFooter({ text: footerText });

  const payload = embed.toJSON();
  payload.footer = { text: footerText };
  return payload;
}

async function findExistingGuide(channel, clientUserId) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;

  return messages.find(message =>
    message.author?.id === clientUserId &&
    message.embeds?.some(embed =>
      embed.title === 'ZORP Guide' ||
      embed.title === '🛡️ ZORP Guide' ||
      embed.title?.endsWith(' ZORP Guide')
    )
  ) || null;
}

export async function reconcileZorpGuide(client) {
  try {
    const channel = await client.channels.fetch(ZORP_GUIDE_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) {
      logger.warn(`[ZORP] Channel ${ZORP_GUIDE_CHANNEL_ID} is missing or is not a text channel.`);
      return { ok: false, reason: 'channel_missing' };
    }

    const me = channel.guild?.members?.me;
    const permissions = me ? channel.permissionsFor(me) : null;

    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions?.has(PermissionFlagsBits.SendMessages) ||
      !permissions?.has(PermissionFlagsBits.EmbedLinks)
    ) {
      logger.warn(`[ZORP] Missing View Channel, Send Messages, or Embed Links in ${ZORP_GUIDE_CHANNEL_ID}.`);
      return { ok: false, reason: 'missing_permissions' };
    }

    const [titleIcon, colorEmojis] = await Promise.all([
      getTermsTitleIcon(client),
      getZorpColorEmojis(client)
    ]);
    const embed = buildZorpGuideEmbed(titleIcon, colorEmojis);
    const existing = permissions.has(PermissionFlagsBits.ReadMessageHistory)
      ? await findExistingGuide(channel, client.user.id)
      : null;

    if (existing) {
      await existing.edit({ embeds: [embed], attachments: [] });
      logger.info(`[ZORP] Updated ZORP Guide message ${existing.id}.`);
      return { ok: true, action: 'updated', messageId: existing.id };
    }

    const sent = await channel.send({ embeds: [embed] });
    logger.info(`[ZORP] Sent ZORP Guide message ${sent.id}.`);
    return { ok: true, action: 'sent', messageId: sent.id };
  } catch (error) {
    logger.error('[ZORP] Failed to reconcile ZORP Guide:', error);
    return { ok: false, reason: 'error' };
  }
}
