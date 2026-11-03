import { selectGiveawayToManage } from '../../../services/giveawayManagePicker.js';

export default {
  name: 'gmanage_select',
  execute: (interaction, client, [requesterId]) =>
    selectGiveawayToManage(interaction, client, requesterId),
};
