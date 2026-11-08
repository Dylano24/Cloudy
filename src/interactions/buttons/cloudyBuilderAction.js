import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { getBuilderButtonAction } from '../../services/embedBuilderButtonEditorService.js';
import { CLOUDY_BRANDING } from '../../services/cloudyBrandingService.js';
import { CLOUDY_LOGO_URL } from '../../services/cloudyLogoService.js';

export function isBoostInstructionsAction(interaction, actionId) {
  // Only the named, owner-authored Reward boost Instructions action gets no logo.
  return interaction?.guildId === '1532882647838228723'
    && interaction?.channelId === '1554538607233073182'
    && String(actionId) === '8ff2465c22214a11b01ad798';
}

function buildButtonResponseEmbed(responseText, { hideThumbnail = false } = {}) {
  const embed = new EmbedBuilder()
    .setDescription(String(responseText || '').slice(0, 4096))
    .setColor(0xFFFFFF)
    .setFooter({ text: CLOUDY_BRANDING });
  if (!hideThumbnail) embed.setThumbnail(CLOUDY_LOGO_URL);
  return embed;
}

function scheduleReplyDeletion(interaction, delayMs) {
  const ms = Number(delayMs);
  if (!Number.isFinite(ms) || ms < 1_000 || ms > 15 * 60_000) return;
  const timer = setTimeout(() => {
    void interaction.deleteReply().catch(() => {});
  }, ms);
  timer.unref?.();
}

export default {
  name: 'cloudy_builder_action',

  async execute(interaction, client, args = []) {
    const actionId = String(args[0] || '');
    const action = await getBuilderButtonAction(interaction.guildId, actionId);

    if (!action?.responseText) {
      await interaction.reply({
        content: 'This button action is no longer available.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      scheduleReplyDeletion(interaction, 10_000);
      return;
    }

    const payload = {
      embeds: [buildButtonResponseEmbed(action.responseText, { hideThumbnail: isBoostInstructionsAction(interaction, actionId) })],
    };

    const actionUrl = String(action.url || '').trim();
    if (/^https?:\/\//i.test(actionUrl)) {
      payload.components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(String(action.linkLabel || 'Open link').slice(0, 80))
            .setStyle(ButtonStyle.Link)
            .setURL(actionUrl.slice(0, 512)),
        ),
      ];
    }
    if (action.visibility !== 'public') {
      payload.flags = MessageFlags.Ephemeral;
    }

    await interaction.reply(payload);
    scheduleReplyDeletion(interaction, action.deleteAfterMs);
  },
};
