import { MessageFlags } from 'discord.js';
import { getBuilderButtonAction } from '../../services/embedBuilderButtonEditorService.js';

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
      return;
    }

    await interaction.reply({
      content: String(action.responseText).slice(0, 2000),
      flags: MessageFlags.Ephemeral,
    });
  },
};
