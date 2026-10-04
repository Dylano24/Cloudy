import { Events, PermissionFlagsBits } from 'discord.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { CLOUDY_GUILD_ID } from '../services/messageLogDestination.js';
import { startupLog, logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const guild = client.guilds.cache.get(CLOUDY_GUILD_ID);
    if (!guild) return;
    const ids = [];
    for (const key of ['ownerModMessageLogs', 'memberMessageLogs']) {
      const channel = await resolveCloudyChannel(client, key, { guild, textOnly: true });
      const permissions = channel?.permissionsFor(guild.members.me);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles])) {
        logger.warn(`Message deletion log destination unavailable or missing permissions: ${key}`);
        return;
      }
      ids.push(channel.id);
    }
    startupLog(`Message deletion logs linked: owner/mod/bot=${ids[0]}, member=${ids[1]}; all accessible source channels enabled.`);
  },
};
