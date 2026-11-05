import { MessageFlags } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { CLOUDY_RED_COLOR, setPreservedEmbedColor } from '../../utils/embedColorPolicy.js';
import { CHANGE_LOG_MODAL_ID, buildChangeLog, changeLogChannel } from '../../services/changeLogService.js';

// The /changelog form: posts in #change-logs, then a 10-second notice.
export default {
  name: CHANGE_LOG_MODAL_ID,
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.guild && changeLogChannel(interaction.guild);
    let embed;
    if (!channel?.send) {
      embed = setPreservedEmbedColor(warningEmbed('Warning', 'The #change-logs channel was not found.'), CLOUDY_RED_COLOR);
    } else {
      const value = name => interaction.fields.getTextInputValue(name);
      await channel.send(buildChangeLog({
        server: value('server'), changes: value('changes'), note: value('note'), userId: interaction.user.id,
      }));
      embed = successEmbed('Success', `The change log was posted in <#${channel.id}>.`);
    }
    await interaction.editReply({ embeds: [embed] });
    const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, 10_000);
    timer.unref?.();
  },
};
