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
  ...legacyGiveawayHandlers,
].map(fromCustomId);
