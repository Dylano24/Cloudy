import { Events } from 'discord.js';

// Search in the Embed Builder is handled through the command autocomplete.
// Do not add a separate Search / magnifying-glass button to Modify embed.
export default {
  name: Events.ClientReady,
  once: true,
  execute() {},
};
