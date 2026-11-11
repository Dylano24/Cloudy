// Player event handlers for Riffy. Adapted from Musicify playerHandler (Apache-2.0).

import { logger } from '../../utils/logger.js';
import { getGuildMusicData, clearUpdateInterval } from './playerStore.js';
import { musicChannelFor } from './musicChannel.js';
import { finishRequestMessage, lastFinishedTrack } from './musicRequestMessages.js';
import {
    buildNowPlayingEmbed,
    buildPlayerButtonRows,
} from './musicEmbeds.js';

const UPDATE_INTERVAL_MS = 15 * 1000;
const IDLE_DISCONNECT_MS = 30 * 1000;
const SHUTDOWN_PANEL_REMOVAL_MS = 3_000;
const playerRefreshJobs = new WeakMap();
// The track Lavalink last reported as started (TrackStartEvent), per player.
const startedTracks = new WeakMap();

/** Lavalink reported that this track really started playing. */
export function markTrackStarted(player, track = player?.current) {
    if (player && track) startedTracks.set(player, track);
    if (player) {
        player.position = 0;
        player.cloudyPositionAt = Date.now();
    }
}

function hasStarted(player) {
    return Boolean(player?.current) && startedTracks.get(player) === player.current;
}

async function editOrSendPlayerMessage(client, guildData, channelId, embed, components) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        return;
    }

    const payload = { embeds: [embed], components, allowedMentions: { parse: [] } };
    // A refresh that would show exactly the same panel is not sent again (the
    // 15-second timer while paused, or a bar piece that did not move yet).
    const panel = JSON.stringify(payload);

    if (guildData.playerMessageId) {
        if (guildData.lastPanel?.messageId === guildData.playerMessageId && guildData.lastPanel.panel === panel) {
            return;
        }
        try {
            const msg = channel.messages.cache?.get(guildData.playerMessageId)
                || await channel.messages.fetch(guildData.playerMessageId);
            await msg.edit(payload);
            guildData.lastPanel = { messageId: guildData.playerMessageId, panel };
            return;
        } catch (error) {
            // A temporary API or permission failure must not create another
            // player message. Replace only a message Discord confirms is gone.
            if (Number(error?.code) !== 10008) throw error;
            guildData.playerMessageId = null;
            guildData.playerChannelId = null;
            clearUpdateInterval(guildData);
        }
    }

    try {
        const newMsg = await channel.send(payload);
        guildData.playerMessageId = newMsg.id;
        guildData.playerChannelId = channel.id;
        guildData.lastPanel = { messageId: newMsg.id, panel };
    } catch (error) {
        logger.error('Failed to send music player message:', error);
    }
}

export async function refreshPlayerMessage(client, guildId) {
    const guildData = getGuildMusicData(guildId);
    const running = playerRefreshJobs.get(guildData);
    if (running) {
        running.pending = true;
        return running.promise;
    }
    const job = { pending: true, promise: null };
    job.promise = (async () => {
      while (job.pending) {
        job.pending = false;
        const player = client.riffy?.players?.get(guildId);
        if (!player?.current) {
            return;
        }
        // A new player panel only appears once Lavalink says the song really
        // started: a song that cannot be streamed never shows as playing.
        if (!guildData.playerMessageId && !hasStarted(player)) {
            return;
        }

        const embed = buildNowPlayingEmbed(player.current, player, guildData);
        const components = buildPlayerButtonRows(player, guildData);
        // A new player panel goes to #music when the server has it (owner's
        // choice); an existing panel keeps its message.
        const guild = client.guilds?.cache?.get?.(guildId);
        const musicChannel = !guildData.playerMessageId && guild ? musicChannelFor(guild) : null;
        const channelId = musicChannel?.id || guildData.playerChannelId || player.textChannel;
        await editOrSendPlayerMessage(client, guildData, channelId, embed, components);
      }
    })().catch(error => {
        logger.error('Failed to refresh music player message:', error);
    }).finally(() => {
        if (playerRefreshJobs.get(guildData) === job) playerRefreshJobs.delete(guildData);
    });
    playerRefreshJobs.set(guildData, job);
    return job.promise;
}

function startUpdateInterval(client, guildId) {
    const guildData = getGuildMusicData(guildId);
    clearUpdateInterval(guildData);
    guildData.updateInterval = setInterval(() => {
        refreshPlayerMessage(client, guildId);
    }, UPDATE_INTERVAL_MS);
}

export function setupPlayerHandler(client) {
    if (!client.riffy) {
        logger.warn('Riffy not initialized; music player handlers not attached.');
        return;
    }

    // Lavalink nodes often flap (reconnect -> error -> reconnect). Throttle all
    // per-node messages to one line per interval, log the first connect only,
    // and skip reconnect noise entirely since it is meaningless during flapping.
    const nodeLogState = new Map();
    const NODE_LOG_INTERVAL_MS = 5 * 60 * 1000;

    const shouldLogNodeEvent = (nodeName) => {
        const prev = nodeLogState.get(nodeName) ?? { lastLogAt: 0, hasConnected: false };
        const now = Date.now();
        if (now - prev.lastLogAt < NODE_LOG_INTERVAL_MS) {
            return false;
        }
        nodeLogState.set(nodeName, { ...prev, lastLogAt: now });
        return true;
    };

    const markNodeConnected = (nodeName) => {
        const prev = nodeLogState.get(nodeName) ?? { lastLogAt: 0, hasConnected: false };
        nodeLogState.set(nodeName, { ...prev, hasConnected: true });
    };

    client.riffy.on('nodeConnect', (node) => {
        const prev = nodeLogState.get(node.name) ?? { lastLogAt: 0, hasConnected: false };
        if (prev.hasConnected) {
            return;
        }
        markNodeConnected(node.name);
        logger.info(`Lavalink node "${node.name}" connected.`);
    });

    client.riffy.on('nodeReconnect', () => {
        // Intentionally silent — reconnect spam is not actionable during flapping.
    });

    client.riffy.on('nodeError', (node, error) => {
        if (!shouldLogNodeEvent(node.name)) {
            return;
        }
        logger.warn(`Lavalink node "${node.name}" error: ${error?.message || error}`);
    });

    client.riffy.on('nodeDisconnect', (node, info) => {
        if (!shouldLogNodeEvent(node.name)) {
            return;
        }
        logger.warn(`Lavalink node "${node.name}" disconnected (code ${info?.event ?? '?'}${info?.reason ? `, ${info.reason}` : ''}).`);
    });

    // Riffy rejects play() when the voice connection never comes. Where nobody
    // awaits it (the next song starting by itself) that must never end up as an
    // unhandled rejection: it is logged, and play() answers false.
    client.riffy.on('playerCreate', (player) => {
        const play = player.play.bind(player);
        player.play = async (...args) => {
            try {
                return await play(...args);
            } catch (error) {
                logger.warn(`[MUSIC] Playback could not start in ${player.guildId}: ${error?.message || error}`);
                return false;
            }
        };
    });

    // The music node tells why its voice connection to Discord closed (4006 session
    // invalid, 4014 disconnected, 4017 encryption required ...): keep it in the log.
    client.riffy.on('socketClosed', (player, payload) => {
        logger.warn(`[MUSIC] Voice connection closed in ${player?.guildId}: code ${payload?.code} ${payload?.reason || ''} (by remote: ${payload?.byRemote})`);
    });

    // The node reports the position every few seconds; the time it arrived lets
    // the progress bar follow the song in between (livePlayerPosition).
    client.riffy.on('playerUpdate', (player) => {
        player.cloudyPositionAt = Date.now();
    });

    client.riffy.on('trackStart', async (player, track) => {
        try {
            markTrackStarted(player, track || player.current);
            const guildData = getGuildMusicData(player.guildId);

            // Keep the Lavalink player's loop mode aligned with the stored preference.
            // Skip temporarily clears track-loop so it can advance; restore it here.
            if (guildData.loop && player.loop !== guildData.loop) {
                player.setLoop(guildData.loop);
            }

            if (player.previous) {
                guildData.previousTracks.push(player.previous);
                if (guildData.previousTracks.length > 20) {
                    guildData.previousTracks.shift();
                }
            }

            if (guildData.idleTimeout) {
                clearTimeout(guildData.idleTimeout);
                guildData.idleTimeout = null;
            }

            await refreshPlayerMessage(client, player.guildId);
            startUpdateInterval(client, player.guildId);
        } catch (error) {
            logger.error('Music trackStart error:', error);
        }
    });

    client.riffy.on('trackEnd', (player, track, payload) => {
        const reason = String(payload?.reason || '').replace('_', '').toLowerCase();
        // A song on repeat is still playing.
        if (player?.loop === 'track' && reason === 'finished') return;
        void finishRequestMessage(client, track, reason === 'loadfailed' ? 'failed' : 'played');
    });

    client.riffy.on('queueEnd', async (player) => {
        try {
            void finishRequestMessage(client, lastFinishedTrack(player));
            const guildData = getGuildMusicData(player.guildId);
            clearUpdateInterval(guildData);

            if (guildData.autoplay) {
                player.autoplay(player);
                return;
            }

            if (guildData.playerMessageId && guildData.playerChannelId) {
                try {
                    const channel = client.channels.cache.get(guildData.playerChannelId);
                    if (channel) {
                        const msg = await channel.messages.fetch(guildData.playerMessageId);
                        await msg.delete();
                    }
                } catch {
                    // already deleted
                }
                guildData.playerMessageId = null;
                guildData.playerChannelId = null;
            }

            if (!guildData.twentyFourSeven) {
                if (guildData.idleTimeout) {
                    clearTimeout(guildData.idleTimeout);
                }
                guildData.idleTimeout = setTimeout(() => {
                    try {
                        const currentPlayer = client.riffy.players.get(player.guildId);
                        if (currentPlayer && !currentPlayer.playing && !currentPlayer.paused && !currentPlayer.current) {
                            currentPlayer.destroy();
                        }
                    } catch {
                        // player already destroyed
                    }
                    guildData.idleTimeout = null;
                }, IDLE_DISCONNECT_MS);
            }
        } catch (error) {
            logger.error('Music queueEnd error:', error);
        }
    });

    client.riffy.on('playerDisconnect', async (player) => {
        void finishRequestMessage(client, player.current);
        const guildData = getGuildMusicData(player.guildId);
        clearUpdateInterval(guildData);

        if (guildData.playerMessageId && guildData.playerChannelId) {
            try {
                const channel = client.channels.cache.get(guildData.playerChannelId);
                if (channel) {
                    const msg = await channel.messages.fetch(guildData.playerMessageId);
                    await msg.delete();
                }
            } catch {
                // already deleted
            }
        }

        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        guildData.previousTracks = [];
        guildData.autoPaused = false;
        if (guildData.idleTimeout) {
            clearTimeout(guildData.idleTimeout);
            guildData.idleTimeout = null;
        }
    });

    // Riffy skips a song that cannot be streamed by itself (stop() after the
    // event). Owner's choice: no public "Failed to play ... Skipping" message under
    // the player; the reason stays in the log.
    client.riffy.on('trackError', (player, track, payload) => {
        const exception = payload?.exception || payload?.error || payload;
        logger.warn(`[MUSIC] Track could not be streamed in ${player.guildId} ("${track?.info?.title || 'track'}", ${track?.info?.sourceName || 'unknown source'}, node ${player?.node?.name || '?'}): ${exception?.message || exception?.cause || JSON.stringify(exception)}`);
    });

    client.riffy.on('trackStuck', async (player, track, payload) => {
        logger.warn(`Track stuck in ${player.guildId} for "${track?.info?.title}" (${payload?.thresholdMs}ms)`);
    });
}

// A restart (deploy) ends every music session. Its player panel is removed
// before the client goes away, so no panel with dead buttons stays behind.
export async function shutdownMusic(client) {
    if (!client.riffy?.players) {
        return;
    }

    const removals = [];
    for (const [guildId, player] of [...client.riffy.players]) {
        const guildData = getGuildMusicData(guildId);
        clearUpdateInterval(guildData);
        const { playerMessageId, playerChannelId } = guildData;
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        guildData.lastPanel = null;
        const channel = playerMessageId && playerChannelId ? client.channels?.cache?.get(playerChannelId) : null;
        if (channel?.messages?.delete) {
            removals.push(channel.messages.delete(playerMessageId).catch(() => {}));
        }
        try {
            player.destroy();
        } catch (error) {
            logger.debug('Error destroying music player during shutdown:', error.message);
        }
    }
    if (removals.length) {
        let timer;
        await Promise.race([
            Promise.allSettled(removals),
            new Promise(resolve => { timer = setTimeout(resolve, SHUTDOWN_PANEL_REMOVAL_MS); }),
        ]);
        clearTimeout(timer);
    }
}
