import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { discoverMissingChannelEmbed } from '../services/embedMissingChannelService.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TARGET_GUILD_ID = '1532882647838228723';
const RECOVERY_KEY = `guild:${TARGET_GUILD_ID}:embed-builder-channel-recovery`;
const RECOVERY_VERSION = 2;
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

function hasRealChannelRecord(records, channelId) {
    return records.some(record =>
        String(record?.source || '') !== 'system-catalog'
        && String(record?.backingChannelId || record?.channelId || '') === String(channelId),
    );
}

async function recoverMissingChannelEmbeds(guild, botUserId) {
    const records = await getEmbedRegistry(guild.id);

    let checked = 0;
    let recovered = 0;

    for (const channel of readableTextChannels(guild)) {
        // A system-catalog record can be virtually placed under #faq/#rules/etc.
        // That does NOT mean the real embed message in that channel is registered.
        if (hasRealChannelRecord(records, channel.id)) continue;

        checked += 1;
        const found = await discoverMissingChannelEmbed(guild, channel.id, botUserId).catch(error => {
            logger.debug(`[EMBED_BUILDER] Recovery skipped #${channel.name}: ${error?.message || error}`);
            return null;
        });

        if (found) {
            recovered += 1;
            records.push(found.record);
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
                logger.info(`[EMBED_BUILDER] Target guild recovery complete: checked ${result.checked}, restored ${result.recovered} real channel embed(s).`);
            } catch (error) {
                logger.error('[EMBED_BUILDER] Target guild recovery failed:', error);
            }
        }, 10_000);

        timer.unref?.();
    },
};
