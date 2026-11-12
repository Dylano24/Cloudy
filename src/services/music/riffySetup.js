import { createRequire } from 'module';
import { GatewayDispatchEvents } from 'discord.js';
import { logger } from '../../utils/logger.js';
import lavalinkConfig from '../../config/music/lavalink.js';
import { setupPlayerHandler } from './playerHandler.js';
import { warmPlayerBarPictures } from './musicBarWarmup.js';
import { PLAYER_BAR_STEPS } from './musicEmbeds.js';

const require = createRequire(import.meta.url);
const { Riffy } = require('riffy');

const NODE_RECONNECT_BASE_MS = 10_000;
const NODE_RECONNECT_MAX_MS = 5 * 60_000;
// Serenetia closes with 4000 "Too many websocket connections attempt for this bot"
// when it is retried too often: such a node waits at least a minute.
const NODE_RATE_LIMITED_MS = 60_000;

// Each failed try doubles the pause before the next (10 s, 20 s, 40 s ... at most
// 5 minutes); a node that connects starts again at 10 seconds. Riffy reads
// node.reconnectTimeout when it schedules the next try, right after this event.
export function applyNodeReconnectBackoff(riffy) {
    riffy.on('nodeDisconnect', (node, info) => {
        node.cloudyFailedTries = (node.cloudyFailedTries || 0) + 1;
        let delay = Math.min(NODE_RECONNECT_BASE_MS * 2 ** (node.cloudyFailedTries - 1), NODE_RECONNECT_MAX_MS);
        if (Number(info?.event) === 4000) delay = Math.max(delay, NODE_RATE_LIMITED_MS);
        node.reconnectTimeout = delay;
    });
    riffy.on('nodeConnect', (node) => {
        node.cloudyFailedTries = 0;
        node.reconnectTimeout = NODE_RECONNECT_BASE_MS;
    });
}

export function initializeMusic(client) {
    if (!lavalinkConfig.nodes?.length) {
        logger.error('No Lavalink nodes configured. Add lavalink/nodes.json, set LAVALINK_NODES, or set LAVALINK_HOST in your environment.');
        return;
    }

    client.riffy = new Riffy(client, lavalinkConfig.nodes, {
        send: (payload) => {
            const guild = client.guilds.cache.get(payload.d.guild_id);
            if (guild) {
                guild.shard.send(payload);
            }
        },
        defaultSearchPlatform: lavalinkConfig.defaultSearchPlatform,
        restVersion: lavalinkConfig.restVersion,
        // The public nodes drop out now and then. By default Riffy gives a node up for
        // good after 3 failed tries (10 seconds) and only a restart brought it back;
        // now a node is never given up, with a growing pause between tries
        // (applyNodeReconnectBackoff).
        reconnectTimeout: NODE_RECONNECT_BASE_MS,
        reconnectTries: Infinity,
        bypassChecks: {
            nodeFetchInfo: true,
        },
    });

    applyNodeReconnectBackoff(client.riffy);
    setupPlayerHandler(client);

    client.on('raw', (packet) => {
        if (
            ![
                GatewayDispatchEvents.VoiceStateUpdate,
                GatewayDispatchEvents.VoiceServerUpdate,
            ].includes(packet.t)
        ) {
            return;
        }
        client.riffy.updateVoiceState(packet);
    });

    client.riffy.on('playerError', (player, error) => {
        logger.error(`Music player error in guild ${player.guildId}:`, error);
    });

    logger.info(`Music initialized with ${lavalinkConfig.nodes.length} Lavalink node(s).`);
}

export function initRiffyAfterReady(client) {
    if (client.riffy && client.user?.id) {
        client.riffy.init(client.user.id);
        logger.info('Riffy voice connection manager initialized.');
        // In the background: the player bar pictures are ready before the first song.
        void warmPlayerBarPictures()
            .then(count => logger.info(`[MUSIC] Player bar pictures ready: ${count}/${PLAYER_BAR_STEPS}.`))
            .catch(() => {});
    }
}
