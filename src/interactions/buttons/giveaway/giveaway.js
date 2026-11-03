import { showGiveawayManagePicker } from '../../../services/giveawayManagePicker.js';
import {
  giveawayEnterHandler,
  giveawayLeaveHandler,
  giveawayManageHandler,
  giveawayAdminHandler,
  legacyGiveawayHandlers,
} from '../../../handlers/giveawayButtons.js';

function fromCustomId(handler) {
  return {
    name: handler.customId,
    execute: handler.execute,
  };
}

export default [
  giveawayEnterHandler,
  giveawayLeaveHandler,
  giveawayManageHandler,
  giveawayAdminHandler,
  {
    customId: 'gmanage_page',
    execute: (interaction, client, [requesterId, page]) =>
      showGiveawayManagePicker(interaction, client, Number(page), requesterId),
  },
  ...legacyGiveawayHandlers,
].map(fromCustomId);
