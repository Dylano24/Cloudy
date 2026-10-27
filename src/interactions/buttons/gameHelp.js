import { GAME_HELP, replyPrivateGuide } from '../../services/gameHelpService.js';

export default {
  name: 'game_help',
  async execute(interaction, _client, [game] = []) {
    if (!Object.hasOwn(GAME_HELP, game)) return;
    await replyPrivateGuide(interaction, { content: GAME_HELP[game] });
  },
};
