import { showGiveawayManagePicker } from '../../../services/giveawayManagePicker.js';

// Manage > status: active or ended giveaways.
export default {
  name: 'gmanage_status',
  execute: (interaction, client, [requesterId]) =>
    showGiveawayManagePicker(interaction, client, 0, requesterId, String(interaction.values?.[0] || '')),
};
