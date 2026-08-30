import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig, updateWelcomeConfig, setBirthday as dbSetBirthday } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { logger } from '../utils/logger.js';
import { enforceProtectedIdentityProfile } from '../services/protectedIdentityService.js';
import { trackMemberInvite } from '../services/inviteTrackingService.js';
import { decorateEmbedWithSavedTemplate } from '../services/embedTemplateService.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';

const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const CLOUDY_BANNER_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-dynamic-banner.gif';

function getOrdinalSuffix(number) {
    const value = Math.abs(Number(number));
    const lastTwo = value % 100;
    if (lastTwo >= 11 && lastTwo <= 13) return 'th';

    switch (value % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

function normalizeBuiltInWelcomeMedia(embed) {
    const data = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
    const thumbnailUrl = String(data.thumbnail?.url || '');
    const imageUrl = String(data.image?.url || '');

    if (!thumbnailUrl || /cloudy-c-logo\.png/i.test(thumbnailUrl)) {
        data.thumbnail = { url: CLOUDY_LOGO_URL };
    }

    if (!imageUrl || /cloudy-dynamic-banner\.gif/i.test(imageUrl)) {
        data.image = { url: CLOUDY_BANNER_URL };
    }

    return new EmbedBuilder(data);
}

export default {
    name: Events.GuildMemberAdd,
    once: false,

    async execute(member) {
        const { guild, user } = member;

        try {
            console.log(`JOIN: ${user.tag}`);

            await trackMemberInvite(member);

            if (await enforceProtectedIdentityProfile(member)) {
                return;
            }

            const config = await getGuildConfig(member.client, guild.id);
            let welcome = await getWelcomeConfig(member.client, guild.id);

            if (!welcome?.enabled || !welcome?.channelId) {
                let recoveredChannel = guild.channels.cache.find(channel =>
                    channel?.isTextBased?.() &&
                    !channel?.isThread?.() &&
                    /(^|[^a-z])(welcome|welkom|arrivals)([^a-z]|$)/i.test(channel.name)
                );

                if (!recoveredChannel) {
                    const textChannels = guild.channels.cache.filter(channel =>
                        channel?.isTextBased?.() &&
                        !channel?.isThread?.() &&
                        channel.messages?.fetch
                    );

                    for (const channel of textChannels.values()) {
                        const recentMessages = await channel.messages.fetch({ limit: 15 }).catch(() => null);
                        const hasCloudyWelcome = recentMessages?.some(message =>
                            message.author?.id === member.client.user?.id &&
                            (
                                message.embeds?.some(embed => /^Welcome to Cloudy(?: Inc\.)?$/i.test(embed.title || '')) ||
                                message.attachments?.some(file => file.name === 'cloudy-dynamic-banner.gif')
                            )
                        );

                        if (hasCloudyWelcome) {
                            recoveredChannel = channel;
                            break;
                        }
                    }
                }

                if (recoveredChannel) {
                    welcome = await updateWelcomeConfig(member.client, guild.id, {
                        ...welcome,
                        enabled: true,
                        channelId: recoveredChannel.id,
                        welcomeMessage:
                            welcome?.welcomeMessage ||
                            botConfig.welcome?.defaultWelcomeMessage ||
                            'Welcome {user} to {server}!',
                    });
                    logger.info('Recovered welcome configuration from Discord', {
                        guildId: guild.id,
                        channelId: recoveredChannel.id,
                    });
                }
            }

            if (welcome?.enabled && welcome.channelId) {
                const channel = guild.channels.cache.get(welcome.channelId);

                if (channel?.isTextBased()) {
                    const perms = channel.permissionsFor(guild.members.me);

                    if (
                        perms?.has(PermissionFlagsBits.ViewChannel) &&
                        perms?.has(PermissionFlagsBits.SendMessages)
                    ) {
                        const data = { user, guild, member };
                        const message =
                            formatWelcomeMessage(
                                welcome.welcomeMessage ||
                                botConfig.welcome?.defaultWelcomeMessage ||
                                'Welcome {user} to {server}!',
                                data
                            ) ||
                            `Welcome ${user} to ${guild.name}`;

                        const memberNumber = guild.memberCount;
                        const memberPosition = `You are the **${memberNumber}**${getOrdinalSuffix(memberNumber)} member of the server`;
                        const ping = welcome.welcomePing ? user.toString() : undefined;

                        if (perms.has(PermissionFlagsBits.EmbedLinks)) {
                            const rulesUrl =
                                'https://discord.com/channels/1532882647838228723/1533189582064062564';
                            const linkAccountUrl =
                                'https://discord.com/channels/1532882647838228723/1539189240074870835';
                            const shopUrl =
                                'https://discord.com/channels/1532882647838228723/1533192856909512774';
                            const contactUrl =
                                'https://discord.com/channels/1532882647838228723/1533197784725852181';

                            const baseEmbed = new EmbedBuilder()
                                .setColor('#FFFFFF')
                                .setTitle('Welcome to Cloudy Inc.')
                                .setDescription(`${memberPosition} ${user}`)
                                .addFields(
                                    {
                                        name: '📜 Rules',
                                        value: `[Check our rules](${rulesUrl})\n\u200b`,
                                        inline: false
                                    },
                                    {
                                        name: '🔗 Link your account',
                                        value: `[Claim free kits, purchases & alerts](${linkAccountUrl})\n\u200b`,
                                        inline: false
                                    },
                                    {
                                        name: '🛒 Subscriptions & Purchases',
                                        value: `[Cloudy Inc. website](${shopUrl})\n\u200b`,
                                        inline: false
                                    },
                                    {
                                        name: '📩 Support & Help',
                                        value: `[Contact us](${contactUrl})`,
                                        inline: false
                                    }
                                )
                                .setThumbnail(CLOUDY_LOGO_URL)
                                .setImage(CLOUDY_BANNER_URL)
                                .setFooter({
                                    text: '© Cloudy Inc. • Quality. Innovation. Performance.'
                                });

                            const decorated = await decorateEmbedWithSavedTemplate(
                                guild.id,
                                channel.id,
                                baseEmbed,
                            );
                            const finalEmbed = decorated.matched
                                ? (decorated.embed || baseEmbed)
                                : normalizeBuiltInWelcomeMedia(baseEmbed);

                            const sentWelcome = await channel.send({
                                content: ping,
                                embeds: [finalEmbed]
                            });
                            await registerCloudyEmbedMessage(sentWelcome, 'welcome').catch(error => {
                                logger.error('Failed to register welcome embed:', error);
                            });
                        } else {
                            await channel.send({
                                content: ping ? `${ping}\n${message}` : message
                            });
                        }

                        console.log('Welcome sent');
                    }
                }
            }

            if (welcome?.roleIds?.length) {
                const role = guild.roles.cache.get(welcome.roleIds[0]);

                if (role) {
                    await member.roles.add(role)
                    .catch(err =>
                        logger.warn(
                            'Role error:',
                            err
                        )
                    );
                }
            }

            if (
                config?.verification?.enabled ||
                config?.verification?.autoVerify?.enabled
            ) {
                try {
                    const { autoVerifyOnJoin } = await import(
                        '../services/verificationService.js'
                    );

                    await autoVerifyOnJoin(
                        member.client,
                        guild,
                        member,
                        config.verification
                    );
                } catch(err) {
                    logger.error(
                        'Verification error:',
                        err
                    );
                }
            }

            try {
                await logEvent({
                    client: member.client,
                    guildId: guild.id,
                    eventType: EVENT_TYPES.MEMBER_JOIN,
                    data: {
                        title: 'User joined',
                        lines: [
                            `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
                            `**Members:** ${guild.memberCount}`
                        ],
                        thumbnail:
                        user.displayAvatarURL({
                            dynamic:true
                        }),
                        userId:user.id
                    }
                });
            } catch(err) {
                logger.debug(
                    'Join log error:',
                    err
                );
            }

            try {
                const counters = await getServerCounters(
                    member.client,
                    guild.id
                );

                for (const counter of counters) {
                    if (
                        counter?.enabled !== false &&
                        counter.channelId
                    ) {
                        await updateCounter(
                            member.client,
                            guild,
                            counter
                        );
                    }
                }
            } catch(err) {
                logger.debug(
                    'Counter error:',
                    err
                );
            }

            try {
                const key = `guild:${guild.id}:birthdays:left`;
                const backup = await member.client.db.get(key) || {};

                if (backup[user.id]) {
                    const { month, day } = backup[user.id];

                    await dbSetBirthday(
                        member.client,
                        guild.id,
                        user.id,
                        month,
                        day
                    );

                    delete backup[user.id];

                    await member.client.db.set(
                        key,
                        backup
                    );
                }
            } catch(err) {
                logger.debug(
                    'Birthday restore error:',
                    err
                );
            }
        } catch(error) {
            logger.error(
                'guildMemberAdd failed:',
                error
            );
        }
    }
};
