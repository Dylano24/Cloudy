// Player event handlers for Riffy. Adapted from Musicify playerHandler (Apache-2.0).

import { logger } from '../../utils/logger.js';
import { getGuildMusicData, clearUpdateInterval } from './playerStore.js';
import { musicChannelFor } from './musicChannel.js';
import { finishRequestMessage, lastFinishedTrack } from './musicRequestMessages.js';
import {
    buildNowPlayingEmbed,
    buildPlayerButtonRows,
    buildMusicRequestEmbed,
    msUntilNextBarPiece,
} from './musicEmbeds.js';

// The panel is refreshed when the bar reaches its next piece (owner's choice: no
// delay), at least every 15 seconds, and never more often than every 2 seconds
// (Discord allows 5 edits per 5 seconds in a channel).
const UPDATE_INTERVAL_MS = 15 * 1000;
const BAR_REFRESH_MIN_MS = 2_000;
const BAR_REFRESH_MARGIN_MS = 250;
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

const ENDED_TITLES = { played: 'Played', skipped: 'Skipped', stopped: 'Stopped', failed: 'Could not play' };

/** Skip and Stop say how the song ended, before the node reports the end. */
export function markTrackEnding(guildData, track, outcome) {
    if (track) guildData.endingTrack = { track, outcome };
}

function endedOutcome(guildData, track, fallback) {
    if (guildData.endingTrack?.track !== track) return fallback;
    const { outcome } = guildData.endingTrack;
    guildData.endingTrack = null;
    return outcome;
}

// Owner's choice: when a song ends its player panel stays in the channel as a
// record of that song ("Played", "Skipped", "Stopped" or "Could not play", the
// song's cover and details, no buttons) and the next song gets a new panel under
// it. Only the panel that shows this very song is changed; returns whether it was.
export async function retirePlayerPanel(client, guildId, track, outcome, player = null) {
    const guildData = getGuildMusicData(guildId);
    const messageId = guildData.playerMessageId;
    const channelId = guildData.playerChannelId;
    if (!messageId || !channelId || !track || guildData.panelTrack !== track) return false;
    const channel = client.channels?.cache?.get(channelId);
    if (!channel?.messages?.edit) return false;
    // From here on the next refresh posts a new panel; the old one is the record.
    guildData.playerMessageId = null;
    guildData.playerChannelId = null;
    guildData.lastPanel = null;
    guildData.panelTrack = null;
    clearUpdateInterval(guildData);
    if (player && startedTracks.get(player) === track) startedTracks.delete(player);
    // A refresh that is still being sent must not overwrite the record.
    await playerRefreshJobs.get(guildData)?.promise?.catch?.(() => {});
    const embed = buildMusicRequestEmbed(track, { playNow: true }).setTitle(ENDED_TITLES[outcome] || ENDED_TITLES.played);
    try {
        await channel.messages.edit(messageId, { embeds: [embed], components: [], allowedMentions: { parse: [] } });
        return true;
    } catch (error) {
        logger.debug(`[MUSIC] Could not mark the player panel as ${outcome}: ${error?.message || error}`);
        return false;
    }
}

async function deletePlayerPanel(client, guildData) {
    const { playerMessageId, playerChannelId } = guildData;
    guildData.playerMessageId = null;
    guildData.playerChannelId = null;
    guildData.lastPanel = null;
    guildData.panelTrack = null;
    if (!playerMessageId || !playerChannelId) return;
    await client.channels?.cache?.get(playerChannelId)?.messages?.delete?.(playerMessageId).catch(() => {});
}

// When the queue is done the bot leaves the voice channel after 30 seconds,
// unless 24/7 is on or something plays again. Riffy keeps the last song as
// player.current after the queue ends, so that is not a sign of activity.
function scheduleIdleLeave(client, player, guildData) {
    if (guildData.twentyFourSeven) return;
    if (guildData.idleTimeout) clearTimeout(guildData.idleTimeout);
    guildData.idleTimeout = setTimeout(() => {
        guildData.idleTimeout = null;
        try {
            const currentPlayer = client.riffy.players.get(player.guildId);
            if (currentPlayer && !currentPlayer.playing && !currentPlayer.paused && !currentPlayer.queue?.length) {
                currentPlayer.destroy();
            }
        } catch {
            // player already destroyed
        }
    }, IDLE_DISCONNECT_MS);
}

async function editOrSendPlayerMessage(client, guildData, channelId, embed, components, track = null) {
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
            guildData.panelTrack = track;
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
        guildData.panelTrack = track;
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
        await editOrSendPlayerMessage(client, guildData, channelId, embed, components, player.current);
      }
    })().catch(error => {
        logger.error('Failed to refresh music player message:', error);
    }).finally(() => {
        if (playerRefreshJobs.get(guildData) === job) playerRefreshJobs.delete(guildData);
        // Every refresh (timer, click, Resume, a new song in the queue) plans the
        // next bar step from the song's position at that moment.
        scheduleBarRefresh(client, guildId);
    });
    playerRefreshJobs.set(guildData, job);
    return job.promise;
}

export function nextBarRefreshDelay(player, now = Date.now()) {
    const untilPiece = msUntilNextBarPiece(player, now);
    if (untilPiece === null) return UPDATE_INTERVAL_MS;
    return Math.min(UPDATE_INTERVAL_MS, Math.max(BAR_REFRESH_MIN_MS, untilPiece + BAR_REFRESH_MARGIN_MS));
}

// Only while a song runs (startUpdateInterval at its start, cleared when it ends).
function scheduleBarRefresh(client, guildId, { start = false } = {}) {
    const guildData = getGuildMusicData(guildId);
    if (!start && !guildData.updateInterval) return;
    clearUpdateInterval(guildData);
    const timer = setTimeout(() => {
        refreshPlayerMessage(client, guildId);
    }, nextBarRefreshDelay(client.riffy?.players?.get(guildId)));
    timer.unref?.();
    guildData.updateInterval = timer;
}

function startUpdateInterval(client, guildId) {
    scheduleBarRefresh(client, guildId, { start: true });
}

// A click on the player panel (Pause, Resume, Shuffle, Loop) is answered with the
// new panel in one step: one Discord request instead of an acknowledgement and an
// edit after it. A click on another message is acknowledged and the panel edited.
export async function answerWithPlayerPanel(interaction, client, guildId) {
    const guildData = getGuildMusicData(guildId);
    const player = client.riffy?.players?.get(guildId);
    const onPanel = Boolean(player?.current && guildData.playerMessageId)
        && interaction.message?.id === guildData.playerMessageId;
    if (onPanel) {
        const embed = buildNowPlayingEmbed(player.current, player, guildData);
        const components = buildPlayerButtonRows(player, guildData);
        const payload = { embeds: [embed], components, allowedMentions: { parse: [] } };
        const panel = JSON.stringify(payload);
        try {
            await interaction.update(payload);
            guildData.lastPanel = { messageId: guildData.playerMessageId, panel };
            guildData.panelTrack = player.current;
        } catch (error) {
            logger.warn(`[MUSIC] Player click could not be answered with the panel: ${error?.message || error}`);
        }
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
    // Sends nothing when the panel already shows this; corrects a refresh that was
    // being sent with the old state, and plans the next bar step.
    return refreshPlayerMessage(client, guildId);
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

            // Previous (⏮️) goes back through this list; going back itself and a
            // song on repeat add nothing to it.
            if (guildData.goingBack) {
                guildData.goingBack = false;
            } else if (player.previous && player.previous !== player.current) {
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
        if (reason === 'replaced') return;
        // A song on repeat is still playing.
        if (player?.loop === 'track' && reason === 'finished') return;
        void finishRequestMessage(client, track, reason === 'loadfailed' ? 'failed' : 'played');
        const guildData = getGuildMusicData(player.guildId);
        const fallback = reason === 'finished' ? 'played' : reason === 'loadfailed' ? 'failed' : reason === 'stopped' ? 'skipped' : 'stopped';
        void retirePlayerPanel(client, player.guildId, track, endedOutcome(guildData, track, fallback), player);
        // A last song that could not be loaded ends without queueEnd.
        if (reason === 'loadfailed' && !player.queue?.length) scheduleIdleLeave(client, player, guildData);
    });

    client.riffy.on('queueEnd', async (player) => {
        try {
            // Riffy emits only queueEnd (no trackEnd) for the very last song.
            const last = lastFinishedTrack(player);
            void finishRequestMessage(client, last);
            const guildData = getGuildMusicData(player.guildId);
            clearUpdateInterval(guildData);

            if (guildData.autoplay) {
                player.autoplay(player);
                return;
            }

            const retired = await retirePlayerPanel(client, player.guildId, last, endedOutcome(guildData, last, 'played'), player);
            if (!retired) await deletePlayerPanel(client, guildData);

            scheduleIdleLeave(client, player, guildData);
        } catch (error) {
            logger.error('Music queueEnd error:', error);
        }
    });

    client.riffy.on('playerDisconnect', async (player) => {
        void finishRequestMessage(client, player.current);
        const guildData = getGuildMusicData(player.guildId);
        clearUpdateInterval(guildData);

        // The bot left the voice channel (Stop, kicked, idle): the song's panel
        // becomes its "Stopped" record, or goes away when it shows another song.
        const retired = await retirePlayerPanel(client, player.guildId, player.current, 'stopped', player);
        if (!retired) await deletePlayerPanel(client, guildData);

        guildData.previousTracks = [];
        // The bot left the voice channel: a jam ends with it.
        guildData.jam = null;
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

// A restart (deploy) ends every music session. Before the client goes away the
// player panel becomes the song's "Stopped" record (or is removed when it shows
// another song), so no panel with dead buttons stays behind.
export async function shutdownMusic(client) {
    if (!client.riffy?.players) {
        return;
    }

    const removals = [];
    for (const [guildId, player] of [...client.riffy.players]) {
        const guildData = getGuildMusicData(guildId);
        clearUpdateInterval(guildData);
        removals.push(retirePlayerPanel(client, guildId, player.current, 'stopped', player)
            .then(retired => retired || deletePlayerPanel(client, guildData))
            .catch(() => {}));
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
