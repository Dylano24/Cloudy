import { Events } from 'discord.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute() {
    // The Appeal Form is owner-managed through the Embed Builder.
    // Startup/redeploy must never create or replace an Appeal Form message.
    return undefined;
  },
};
