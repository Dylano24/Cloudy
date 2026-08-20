import { SlashCommandBuilder } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    skipTrack,
    stopPlayback,
    pausePlayback,
    resumePlayback,
    shuffleQueue,
    setLoopMode,
    setVolume,
    seekTrack,
    removeFromQueue,
    moveInQueue,
    clearQueue,
    setTwentyFourSeven,
    leaveVoiceChannel,
    joinVoiceChannel,
    playQuery,
    buildNowPlayingReply,
    buildQueueReply,
    replyMusicSuccess,
} from '../../services/music/musicActions.js';
import {
    toggleAutoplay,
    reverseQueue,
    setAudioFilter,
    configureSessionMode,
    configureSessionLock,
    configureDjRole,
    configureMusicUser,
    musicPermissionStatus,
} from '../../services/music/advancedMusicActions.js';
import { hydrateMusicPolicy } from '../../services/music/musicSessionService.js';
import { deferMusicCommand } from '../../services/music/prefixSupport.js';

export default {
    category: 'Music',
    data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Manage playback, queue, filters, autoplay and session permissions')
        .addSubcommand((sub) => sub.setName('join').setDescription('Join your voice channel without starting playback'))
        .addSubcommand((sub) =>
            sub
                .setName('play')
                .setDescription('Play a song or add it to the queue')
                .addStringOption((opt) =>
                    opt.setName('query').setDescription('Song name or URL').setRequired(true),
                ),
        )
        .addSubcommand((sub) => sub.setName('nowplaying').setDescription('Show the currently playing track'))
        .addSubcommand((sub) =>
            sub
                .setName('queue')
                .setDescription('Show the current music queue')
                .addIntegerOption((opt) =>
                    opt.setName('page').setDescription('Page number').setMinValue(1),
                ),
        )
        .addSubcommand((sub) => sub.setName('pause').setDescription('Pause playback'))
        .addSubcommand((sub) => sub.setName('resume').setDescription('Resume playback'))
        .addSubcommand((sub) => sub.setName('skip').setDescription('Skip the current track'))
        .addSubcommand((sub) => sub.setName('stop').setDescription('Stop playback and clear the queue'))
        .addSubcommand((sub) => sub.setName('shuffle').setDescription('Shuffle the queue'))
        .addSubcommand((sub) => sub.setName('reverse').setDescription('Reverse the queued tracks'))
        .addSubcommand((sub) =>
            sub
                .setName('autoplay')
                .setDescription('Enable or disable automatic recommended tracks')
                .addBooleanOption((opt) =>
                    opt.setName('enabled').setDescription('Autoplay state').setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('loop')
                .setDescription('Set loop mode')
                .addStringOption((opt) =>
                    opt
                        .setName('mode')
                        .setDescription('Loop mode')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Off', value: 'none' },
                            { name: 'Track', value: 'track' },
                            { name: 'Queue', value: 'queue' },
                        ),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('volume')
                .setDescription('Set playback volume')
                .addIntegerOption((opt) =>
                    opt.setName('level').setDescription('Volume (0-100)').setRequired(true).setMinValue(0).setMaxValue(100),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('seek')
                .setDescription('Seek to a position in the current track')
                .addIntegerOption((opt) =>
                    opt.setName('seconds').setDescription('Position in seconds').setRequired(true).setMinValue(0),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Remove a track from the queue')
                .addIntegerOption((opt) =>
                    opt.setName('position').setDescription('Queue position').setRequired(true).setMinValue(1),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('move')
                .setDescription('Move a track in the queue')
                .addIntegerOption((opt) =>
                    opt.setName('from').setDescription('Current position').setRequired(true).setMinValue(1),
                )
                .addIntegerOption((opt) =>
                    opt.setName('to').setDescription('New position').setRequired(true).setMinValue(1),
                ),
        )
        .addSubcommand((sub) => sub.setName('clear').setDescription('Clear the queue'))
        .addSubcommand((sub) => sub.setName('leave').setDescription('Disconnect the bot from the voice channel'))
        .addSubcommand((sub) =>
            sub
                .setName('247')
                .setDescription('Toggle 24/7 mode')
                .addBooleanOption((opt) =>
                    opt.setName('enabled').setDescription('Enable or disable 24/7 mode').setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('filter')
                .setDescription('Apply an audio filter preset')
                .addStringOption((opt) =>
                    opt
                        .setName('preset')
                        .setDescription('Audio filter')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Off', value: 'off' },
                            { name: 'Bass Boost', value: 'bassboost' },
                            { name: 'Nightcore', value: 'nightcore' },
                            { name: 'Vaporwave', value: 'vaporwave' },
                            { name: 'Karaoke', value: 'karaoke' },
                            { name: 'Tremolo', value: 'tremolo' },
                            { name: 'Vibrato', value: 'vibrato' },
                            { name: '8D Rotation', value: '8d' },
                            { name: 'Low Pass', value: 'lowpass' },
                        ),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('session-mode')
                .setDescription('Set who controls music sessions')
                .addStringOption((opt) =>
                    opt
                        .setName('mode')
                        .setDescription('Permission mode')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Open - everyone in voice', value: 'open' },
                            { name: 'Owner - session owner only', value: 'owner' },
                            { name: 'DJ - session owner + DJ roles', value: 'dj' },
                        ),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName('session-lock')
                .setDescription('Lock/unlock the current music session')
                .addBooleanOption((opt) => opt.setName('locked').setDescription('Lock state').setRequired(true)),
        )
        .addSubcommand((sub) =>
            sub
                .setName('dj-role')
                .setDescription('Add or remove a DJ role')
                .addRoleOption((opt) => opt.setName('role').setDescription('DJ role').setRequired(true))
                .addBooleanOption((opt) => opt.setName('enabled').setDescription('Add or remove the role').setRequired(true)),
        )
        .addSubcommand((sub) =>
            sub
                .setName('user-permission')
                .setDescription('Allow, deny or reset a user for music controls')
                .addUserOption((opt) => opt.setName('user').setDescription('User').setRequired(true))
                .addStringOption((opt) =>
                    opt
                        .setName('state')
                        .setDescription('Permission state')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Allow', value: 'allow' },
                            { name: 'Deny', value: 'deny' },
                            { name: 'Reset', value: 'reset' },
                        ),
                ),
        )
        .addSubcommand((sub) => sub.setName('permissions').setDescription('Show current music session permissions')),

    async execute(interaction, config, client) {
        const deferred = await deferMusicCommand(interaction);
        if (deferred === false) return;

        await hydrateMusicPolicy(client, interaction.guild.id);
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'join') {
            const embed = await joinVoiceChannel(client, interaction);
            return replyMusicSuccess(interaction, embed);
        }

        if (subcommand === 'play') {
            const result = await playQuery(client, interaction, interaction.options.getString('query', true));
            return replyMusicSuccess(interaction, result.embed);
        }

        if (subcommand === 'nowplaying') {
            const payload = buildNowPlayingReply(client, interaction.guild.id);
            return InteractionHelper.safeEditReply(interaction, payload);
        }

        if (subcommand === 'queue') {
            const page = (interaction.options.getInteger('page') || 1) - 1;
            const payload = buildQueueReply(client, interaction.guild.id, page);
            return InteractionHelper.safeEditReply(interaction, {
                embeds: payload.embeds,
                components: payload.components,
            });
        }

        let embed = null;
        switch (subcommand) {
            case 'pause': embed = await pausePlayback(client, interaction); break;
            case 'resume': embed = await resumePlayback(client, interaction); break;
            case 'skip': embed = await skipTrack(client, interaction); break;
            case 'stop': embed = await stopPlayback(client, interaction); break;
            case 'shuffle': embed = await shuffleQueue(client, interaction); break;
            case 'reverse': embed = await reverseQueue(client, interaction); break;
            case 'autoplay': embed = await toggleAutoplay(client, interaction, interaction.options.getBoolean('enabled')); break;
            case 'loop': embed = await setLoopMode(client, interaction, interaction.options.getString('mode')); break;
            case 'volume': embed = await setVolume(client, interaction, interaction.options.getInteger('level')); break;
            case 'seek': embed = await seekTrack(client, interaction, interaction.options.getInteger('seconds')); break;
            case 'remove': embed = await removeFromQueue(client, interaction, interaction.options.getInteger('position')); break;
            case 'move':
                embed = await moveInQueue(client, interaction, interaction.options.getInteger('from'), interaction.options.getInteger('to'));
                break;
            case 'clear': embed = await clearQueue(client, interaction); break;
            case 'leave': embed = await leaveVoiceChannel(client, interaction); break;
            case '247': embed = await setTwentyFourSeven(client, interaction, interaction.options.getBoolean('enabled')); break;
            case 'filter': embed = await setAudioFilter(client, interaction, interaction.options.getString('preset')); break;
            case 'session-mode': embed = await configureSessionMode(client, interaction, interaction.options.getString('mode')); break;
            case 'session-lock': embed = await configureSessionLock(client, interaction, interaction.options.getBoolean('locked')); break;
            case 'dj-role': embed = await configureDjRole(client, interaction, interaction.options.getRole('role'), interaction.options.getBoolean('enabled')); break;
            case 'user-permission':
                embed = await configureMusicUser(client, interaction, interaction.options.getUser('user'), interaction.options.getString('state'));
                break;
            case 'permissions': embed = await musicPermissionStatus(client, interaction); break;
            default:
                return InteractionHelper.safeEditReply(interaction, { content: 'Unknown music subcommand.' });
        }

        return replyMusicSuccess(interaction, embed);
    },
};
