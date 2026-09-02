import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { discoverMissingChannelEmbed } from '../services/embedMissingChannelService.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TARGET_GUILD_ID = '1532882647838228723';
const RECOVERY_KEY = `guild:${TARGET_GUILD_ID}:embed-builder-channel-recovery`;
const RECOVERY_VERSION = 1;
const CHANNEL_DELAY_MS = 120;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readableTextChannels(guild) {
    const me = guild.members.me;
    return [...guild.channels.cache.values()]
        .filter(channel =>
            (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
            && channel.messages?.fetch
            && channel.permissionsFor(me)?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
            ]),
        )
        .sort((a, b) => a.position - b.position || String(a.name).localeCompare(String(b.name)));
}

async function recoverMissingChannelEmbeds(guild, botUserId) {
    const records = await getEmbedRegistry(guild.id);
    const registeredChannelIds = new Set(records.map(record => String(record.channelId)));

    let checked = 0;
    let recovered = 0;

    for (const channel of readableTextChannels(guild)) {
        if (registeredChannelIds.has(String(channel.id))) continue;

        checked += 1;
        const found = await discoverMissingChannelEmbed(guild, channel.id, botUserId).catch(error => {
            logger.debug(`[EMBED_BUILDER] Recovery skipped #${channel.name}: ${error?.message || error}`);
            return null;
        });

        if (found) {
            recovered += 1;
            registeredChannelIds.add(String(channel.id));
        }

        await wait(CHANNEL_DELAY_MS);
    }

    return { checked, recovered };
}

export default {
    name: Events.ClientReady,
    once: true,

    execute(client) {
        const timer = setTimeout(async () => {
            try {
                const completed = Number(await getFromDb(RECOVERY_KEY, 0) || 0);
                if (completed >= RECOVERY_VERSION) return;

                const guild = client.guilds.cache.get(TARGET_GUILD_ID)
                    || await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
                if (!guild) return;

                const result = await recoverMissingChannelEmbeds(guild, client.user.id);
                await setInDb(RECOVERY_KEY, RECOVERY_VERSION);
                logger.info(`[EMBED_BUILDER] Target guild recovery complete: checked ${result.checked}, restored ${result.recovered} channel embed(s).`);
            } catch (error) {
                logger.error('[EMBED_BUILDER] Target guild recovery failed:', error);
            }
        }, 10_000);

        timer.unref?.();
    },
};
