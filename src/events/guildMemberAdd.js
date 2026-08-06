import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig, setBirthday as dbSetBirthday } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { logger } from '../utils/logger.js';

export default {
    name: Events.GuildMemberAdd,
    once: false,

    async execute(member) {
        const { guild, user } = member;

        try {
            console.log(`JOIN: ${user.tag}`);

            const config = await getGuildConfig(member.client, guild.id);
            const welcome = await getWelcomeConfig(member.client, guild.id);

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
                            `Welcome ${user} to ${guild.name}!`;

                        const ping =
                            welcome.welcomePing
                            ? user.toString()
                            : undefined;


                        if (
                            perms.has(
                                PermissionFlagsBits.EmbedLinks
                            )
                        ) {

                            const embed =
                                new EmbedBuilder()
                                .setColor('#FFFFFF')
                                .setTitle('Welcome to Cloudy!')
                                .setDescription(message)
                                .setThumbnail(
                                    user.displayAvatarURL({
                                        dynamic:true
                                    })
                                )
                                .setTimestamp()
                                .setFooter({
                                    text:
                                    welcome.welcomeEmbed?.footer ||
                                    `Welcome to ${guild.name}`
                                });


                            if (welcome.welcomeImage) {
                                embed.setImage(
                                    welcome.welcomeImage
                                );
                            }


                            await channel.send({
                                content: ping,
                                embeds:[embed]
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
            }
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


            try {

                await logEvent({
                    client:member.client,
                    guildId:guild.id,
                    eventType:EVENT_TYPES.MEMBER_JOIN,
                    data:{
                        title:'User joined',
                        lines:[
                            `**Created:** <t:${Math.floor(user.createdTimestamp / 1000)}:R>`,
                            `**Members:** ${guild.memberCount}`
                        ],
                        thumbnail:user.displayAvatarURL({
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
