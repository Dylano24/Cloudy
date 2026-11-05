import { showGiveawayManagePicker } from '../../../services/giveawayManagePicker.js';
import {
  giveawayEnterHandler,
  giveawayLeaveHandler,
  giveawayManageHandler,
  giveawayAdminHandler,
  giveawayCountryPageHandler,
  giveawayCountryTypeHandler,
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
  giveawayCountryPageHandler,
  giveawayCountryTypeHandler,
  {
    customId: 'gmanage_page',
    execute: (interaction, client, [requesterId, page, status]) =>
      showGiveawayManagePicker(interaction, client, Number(page), requesterId, status || null),
  },
  ...legacyGiveawayHandlers,
].map(fromCustomId);
