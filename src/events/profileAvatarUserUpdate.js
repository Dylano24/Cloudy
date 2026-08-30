import { Events } from 'discord.js';
import { syncGlobalUserAvatar } from '../services/profileAvatarSyncService.js';

export default {
  name: Events.UserUpdate,
  once: false,

  async execute(oldUser, newUser, client) {
    await syncGlobalUserAvatar(client, oldUser, newUser);
  },
};
