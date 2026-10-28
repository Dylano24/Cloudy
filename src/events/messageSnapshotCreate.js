import { Events } from 'discord.js';
import { captureMessageSnapshot } from '../services/messageSnapshotService.js';

// Keeps a short-lived copy of each guild message so a later deletion log can
// show its author, time, text and attachments even after a restart.
export default {
  name: Events.MessageCreate,
  once: false,
  execute(message) {
    if (!message?.guildId) return;
    void captureMessageSnapshot(message).catch(() => false);
  },
};
