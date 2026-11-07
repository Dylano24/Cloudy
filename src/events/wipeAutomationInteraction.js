import { Events, MessageFlags } from 'discord.js';
import {
  AUTO_WIPE_GUILD_ID, autoWipeGiveawayPayload, changeAutoWipeEntry,
} from '../services/wipeAutomationService.js';
import { logger } from '../utils/logger.js';

const BUTTON_PREFIX = 'wipeauto_';

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    if (!interaction.isButton?.() || !interaction.customId?.startsWith(BUTTON_PREFIX)) return;
    if (interaction.guildId !== AUTO_WIPE_GUILD_ID) return;
    const match = /^wipeauto_(enter|leave):([a-f0-9]{20})$/.exec(interaction.customId);
    if (!match) return;
    const userId = interaction.user?.id;
    if (!userId) return;
    try {
      // Acknowledge first: DB mutex + Discord edits can exceed three seconds.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { status, session } = await changeAutoWipeEntry(
        interaction.client, interaction.guildId, match[2], userId, match[1] === 'enter',
      );
      const texts = {
        entered: 'You entered the wipe giveaway.',
        left: 'You left the wipe giveaway.',
        already: 'You have already entered.',
        'not-entered': 'You are not participating.',
        ended: 'This wipe giveaway has ended.',
        missing: 'This wipe giveaway is no longer available.',
        invalid: 'Invalid wipe giveaway.',
      };
      // This must update the original giveaway, never post another panel.
      if (status === 'entered' || status === 'left') {
        if (session?.messageId && interaction.message?.id === session.messageId) {
          // Always use the latest stored session to avoid showing stale counts.
          const payload = autoWipeGiveawayPayload(session);
          await interaction.message.edit(payload);
        }
      }
      await interaction.editReply({ content: texts[status] || 'Could not change participation.' });
    } catch (error) {
      logger.error('[WIPE_AUTO] Participation failed:', error);
      if (interaction.deferred) {
        await interaction.editReply({ content: 'Could not change participation.' }).catch(() => {});
      }
    }
  },
};
