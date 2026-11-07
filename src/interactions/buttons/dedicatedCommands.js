import { buildGamblingCommandListText, buildShopCommandListText } from '../../config/gamblingCommands.js';
import { CLOUDY_LOGO_URL } from '../../services/cloudyLogoService.js';
import { replyPrivateGuide } from '../../services/gameHelpService.js';
import { buildMusicCommandsEmbed } from '../../services/music/musicEmbeds.js';

export default {
  name: 'dedicated_commands',
  async execute(interaction, _client, [key] = []) {
    if (!['gambling', 'shop', 'music'].includes(key)) return;
    if (key === 'music') {
      await replyPrivateGuide(interaction, {
        embeds: [buildMusicCommandsEmbed()],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    await replyPrivateGuide(interaction, {
      embeds: [{
        title: key === 'shop' ? 'Shop & Economy' : 'Games & Economy',
        description: key === 'shop' ? buildShopCommandListText() : buildGamblingCommandListText(),
        color: 0xFFFFFF,
        thumbnail: { url: CLOUDY_LOGO_URL },
        footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
      }],
      components: [],
    });
  },
};
