import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getWelcomeConfig, setBirthday as dbSetBirthday } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { logger } from '../utils/logger.js';

function toOrdinal(number) {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const value = number % 100;
    return number + (suffixes[(value - 20) % 10] || suffixes[value] || suffixes[0]);
}

export default {
    name: Events.GuildMemberAdd,
    once: false,

    async execute(member) {
        try {
            const { guild, user } = member;

            console.log(`Member joined: ${user.tag}`);

            const config = await getGuildConfig(
                member.client,
                guild.id
            );

            const welcomeConfig = await getWelcomeConfig(
                member.client,
                guild.id
            );

            /*
             * WELCOME MESSAGE
             */
            if (
                welcomeConfig?.enabled &&
                welcomeConfig.channelId
            ) {
                const channel = guild.channels.cache.get(
                    welcomeConfig.channelId
                );

                if (channel?.isTextBased()) {

                    const permissions = channel.permissionsFor(
                        guild.members.me
                    );

                    if (
                        permissions?.has(
                            PermissionFlagsBits.ViewChannel
                        ) &&
                        permissions?.has(
                            PermissionFlagsBits.SendMessages
                        )
                    ) {

                        const data = {
                            user,
                            guild,
                            member
                        };

                        const welcomeText =
                            formatWelcomeMessage(
                                welcomeConfig.welcomeMessage ||
                                botConfig.welcome?.defaultWelcomeMessage ||
                                'Welcome {user} to {server}!',
                                data
                            ) ||
                            `Welcome ${user} to ${guild.name}!`;


                        const content =
                            welcomeConfig.welcomePing
                                ? user.toString()
                                : undefined;


                        if (
                            permissions.has(
                                PermissionFlagsBits.EmbedLinks
                            )
                        ) {

                            const embed =
                                new EmbedBuilder()
                                .setColor('#FFFFFF')
                                .setTitle(
                                    formatWelcomeMessage(
                                        welcomeConfig.welcomeEmbed?.title ||
                                        '🎉 Welcome!',
                                        data
                                    )
                                )
                                .setDescription(
                                    `${welcomeText}\n\nYou are our **${toOrdinal(guild.memberCount)}** member!`
                                )
                                .setThumbnail(
                                    user.displayAvatarURL({
                                        dynamic: true
                                    })
                                )
                                .setTimestamp()
                                .setFooter({
                                    text:
                                    welcomeConfig.welcomeEmbed?.footer ||
                                    `Welcome to ${guild.name}`
                                });


                            if (welcomeConfig.welcomeImage) {
                                embed.setImage(
                                    welcomeConfig.welcomeImage
                                );
                            }


                            await channel.send({
                                content,
                                embeds: [embed]
                            });

                        } else {

                            await channel.send({
                                content:
                                    content
                                    ? `${content}\n${welcomeText}`
                                    : welcomeText
                            });

                        }

                        console.log(
                            'Welcome message sent'
                        );
                    }
                }
            }


            /*
             * AUTO ROLE
             */

            if (
                welcomeConfig?.roleIds?.length
            ) {

                const role =
                    guild.roles.cache.get(
                        welcomeConfig.roleIds[0]
                    );

                if (role) {
                    try {
                        await member.roles.add(role);
                        console.log(
                            `Role added: ${role.name}`
                        );
                    } catch (err) {
                        logger.warn(
                            'Role add failed:',
                            err
                        );
                    }
                }
            }
