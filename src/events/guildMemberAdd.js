import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig, setBirthday as dbSetBirthday } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { logger } from '../utils/logger.js';
import { enforceProtectedIdentityProfile } from '../services/protectedIdentityService.js';

export default {
    name: Events.GuildMemberAdd,
    once: false,

    async execute(member) {
        const { guild, user } = member;

        try {
            console.log(`JOIN: ${user.tag}`);

            if (await enforceProtectedIdentityProfile(member)) {
                return;
            }

            const config = await getGuildConfig(member.client, guild.id);
            const welcome = await getWelcomeConfig(member.client, guild.id);


            // WELCOME MESSAGE

            if (welcome?.enabled && welcome.channelId) {

                const channel = guild.channels.cache.get(
                    welcome.channelId
                );

                if (channel?.isTextBased()) {

                    const perms = channel.permissionsFor(
                        guild.members.me
                    );

                    if (
                        perms?.has(PermissionFlagsBits.ViewChannel) &&
                        perms?.has(PermissionFlagsBits.SendMessages)
                    ) {

                        const data = {
                            user,
                            guild,
                            member
                        };


                        const message =
                            formatWelcomeMessage(
                                welcome.welcomeMessage ||
                                botConfig.welcome?.defaultWelcomeMessage ||
                                'Welcome {user} to {server}!',
                                data
                            ) ||
                            `Welcome ${user} to ${guild.name}`;

                        const cleanMessage = message.replace(/!+\s*$/, '');


                        const ping =
                            welcome.welcomePing
                            ? user.toString()
                            : undefined;


                        if (
                            perms.has(
                                PermissionFlagsBits.EmbedLinks
                            )
                        ) {

                            const rulesUrl =
                                'https://discord.com/channels/1532882647838228723/1533189582064062564';
                            const linkAccountUrl =
                                'https://discord.com/channels/1532882647838228723/1539189240074870835';
                            const shopUrl =
                                'https://discord.com/channels/1532882647838228723/1533192856909512774';
                            const contactUrl =
                                'https://discord.com/channels/1532882647838228723/1533197784725852181';

                            const embed =
                                new EmbedBuilder()
                                .setColor('#FFFFFF')
                                .setTitle('Welcome to Cloudy')
                                .setDescription(cleanMessage)
                                .addFields(
                                    {
                                        name: '📜 Rules',
                                        value: `[Check our rules](${rulesUrl})\n\u200b`,
                                        inline: false
                                    },
                                    {
                                        name: '🔗 Link Your Account',
                                        value: `[Claim free kits, purchases & alerts](${linkAccountUrl})\n\u200b`,
                                        inline: false
                                    },
                                    {
                                        name: '🛒 Subscriptions & Purchases',
                                        value: `[Official Cloudy website](${shopUrl})\n\u200b`,
                                        inline: false
                                    },
                                    {
                                        name: '📩 Support & Help',
                                        value: `[Contact us](${contactUrl})`,
                                        inline: false
                                    }
                                )
                                .setThumbnail(
                                    'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@e56cbead4b6d6ef364a56f421bab08f683d0965f/assets/cloudy-c-logo.png'
                                )
                                .setImage(
                                    'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@7f50573972506ca53b788829c270f4f73e458817/assets/cloudy-dynamic-banner.gif'
                                );

                            // Force the footer into the final Discord API payload so it
                            // always renders inside this embed, directly below the banner.
                            const embedPayload = embed.toJSON();
                            embedPayload.footer = {
                                text: '© Cloudy • Build. Compete. Dominate.'
                            };

                            await channel.send({
                                content: ping,
                                embeds: [embedPayload]
                            });

                        } else {

                            await channel.send({
                                content:
                                ping
                                ? `${ping}\n${message}`
                                : message
                            });

                        }


                        console.log('Welcome sent');

                    }
                }
            }


            // AUTO ROLE

            if (welcome?.roleIds?.length) {

                const role =
                    guild.roles.cache.get(
                        welcome.roleIds[0]
                    );

                if (role) {

                    await member.roles.add(role)
                    .catch(err =>
                        logger.warn(
                            'Role error:',
                            err
                        )
                    );

                }
            }            // VERIFICATION

            if (
                config?.verification?.enabled ||
                config?.verification?.autoVerify?.enabled
            ) {

                try {

                    const {
                        autoVerifyOnJoin
                    } = await import(
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



            // LOGGING

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



            // COUNTERS

            try {

                const counters =
                    await getServerCounters(
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



            // RESTORE BIRTHDAY

            try {

                const key =
                    `guild:${guild.id}:birthdays:left`;


                const backup =
                    await member.client.db.get(key) || {};


                if (backup[user.id]) {


                    const {
                        month,
                        day
                    } = backup[user.id];


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
