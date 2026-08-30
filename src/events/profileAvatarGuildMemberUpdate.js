import { Events } from 'discord.js';
import { syncGuildMemberAvatar } from '../services/profileAvatarSyncService.js';

export default {
  name: Events.GuildMemberUpdate,
  once: false,

  async execute(oldMember, newMember) {
    await syncGuildMemberAvatar(oldMember, newMember);
  },
};
