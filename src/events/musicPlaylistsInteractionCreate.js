import { Events } from 'discord.js';
import { handleMusicPlaylistControls } from '../services/music/musicPlaylists.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.customId?.startsWith('musicpl:')) {
      await handleMusicPlaylistControls(interaction, client || interaction.client);
    }
  },
};
