import { Events, EmbedBuilder, PermissionFlagsBits, AuditLogEvent } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { getWelcomeConfig, getUserApplications, deleteApplication } from '../utils/database.js';
import { formatWelcomeMessage } from '../utils/welcome.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { getServerCounters, updateCounter } from '../services/serverstatsService.js';
import { getGuildBirthdays, deleteBirthday } from '../utils/database.js';
import { deleteUserLevelData } from '../services/leveling/leveling.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.GuildMemberRemove,
  once: false,
  
  async execute(member) {
    try {
        const { guild, user } = member;

        // Detect kicks performed directly through Discord.
        // Kicks executed by Cloudy are already logged by the moderation service,
        // so never create a second Kick log from GuildMemberRemove for those.
        try {
            await new Promise(resolve => setTimeout(resolve, 750));
            const auditLogs = await guild.fetchAuditLogs({
                type: AuditLogEvent.MemberKick,
                limit: 6,
            });
            const now = Date.now();
            const kickEntry = auditLogs.entries.find(entry =>
                entry.target?.id === user.id &&
                now - entry.createdTimestamp < 15_000
            );

            if (kickEntry && kickEntry.executor?.id !== member.client.user?.id) {
                const executor = kickEntry.executor;
                const reason = kickEntry.reason || 'No reason provided';

                await logEvent({
                    client: member.client,
                    guildId: guild.id,
                    eventType: EVENT_TYPES.MODERATION_KICK,
                    data: {
                        title: 'Kick log',
                        lines: [
                            `**User:** ${user.toString()} (${user.tag})`,
                            `**Kicked by:** ${executor ? `${executor.toString()} (${executor.tag})` : 'Unknown'}`,
                            `**Reason:** ${reason}`,
                            `**Date:** <t:${Math.floor(Date.now() / 1000)}:F>`,
                        ],
                        quoted: false,
                        thumbnail: user.displayAvatarURL({ size: 256 }),
                        userId: user.id,
                    },
                });
            }
        } catch (auditError) {
            logger.warn('Could not inspect audit logs for a member kick:', auditError.message);
        }
        
        const welcomeConfig = await getWelcomeConfig(member.client, guild.id);
        
        const goodbyeChannelId = welcomeConfig?.goodbyeChannelId;

        if (welcomeConfig?.goodbyeEnabled && goodbyeChannelId) {
            const channel = guild.channels.cache.get(goodbyeChannelId);
            if (channel?.isTextBased?.()) {
                const me = guild.members.me;
                const permissions = me ? channel.permissionsFor(me) : null;
                if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
                    return;
                }

                const formatData = { user, guild, member };
                const goodbyeMessage = formatWelcomeMessage(
                    welcomeConfig.leaveMessage || welcomeConfig.leaveEmbed?.description || botConfig.welcome?.defaultGoodbyeMessage || '{user} has left the server.',
                    formatData
                );

                const embedTitle = formatWelcomeMessage(
                    welcomeConfig.leaveEmbed?.title || '👋 Goodbye',
                    formatData
                );
                const embedFooter = welcomeConfig.leaveEmbed?.footer
                    ? formatWelcomeMessage(welcomeConfig.leaveEmbed.footer, formatData)
                    : `Goodbye from ${guild.name}!`;

                const canEmbed = permissions.has(PermissionFlagsBits.EmbedLinks);

                if (!canEmbed) {
                    await channel.send({
                        content: welcomeConfig?.goodbyePing ? `<@${user.id}> ${goodbyeMessage}` : goodbyeMessage,
                        allowedMentions: welcomeConfig?.goodbyePing ? { users: [user.id] } : { parse: [] }
                    });
                } else {
                    const embed = new EmbedBuilder()
                        .setTitle(embedTitle)
                        .setDescription(goodbyeMessage)
                        .setColor(welcomeConfig.leaveEmbed?.color || getColor('error'))
                        .setThumbnail(user.displayAvatarURL())
                        .addFields(
                            { name: 'User', value: `${user.tag} (${user.id})`, inline: true },
                            { name: 'Member Count', value: guild.memberCount.toString(), inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: embedFooter });

                    if (typeof welcomeConfig.leaveEmbed?.image === 'string') {
                        embed.setImage(welcomeConfig.leaveEmbed.image);
                    } else if (welcomeConfig.leaveEmbed?.image?.url) {
                        embed.setImage(welcomeConfig.leaveEmbed.image.url);
                    }

                    await channel.send({
                        content: welcomeConfig?.goodbyePing ? `<@${user.id}>` : undefined,
                        allowedMentions: welcomeConfig?.goodbyePing ? { users: [user.id] } : { parse: [] },
                        embeds: [embed]
                    });
                }
            }
        }

        try {
            await logEvent({
                client: member.client,
                guildId: guild.id,
                eventType: EVENT_TYPES.MEMBER_LEAVE,
                data: {
                    title: 'User left',
                    lines: [
                        `**User:** ${user.toString()} (${user.tag})`,
                        `**ID:** \`${user.id}\``,
                        `**Joined:** <t:${Math.floor((member.joinedTimestamp || Date.now()) / 1000)}:R>`,
                        `**Members:** ${guild.memberCount}`,
                    ],
                    quoted: false,
                    thumbnail: user.displayAvatarURL({ dynamic: true }),
                    userId: user.id,
                }
            });
        } catch (error) {
            logger.debug('Error logging member leave:', error);
        }

        try {
            const counters = await getServerCounters(member.client, guild.id);
            for (const counter of counters) {
                if (counter && counter.type && counter.channelId && counter.enabled !== false) {
                    await updateCounter(member.client, guild, counter);
                }
            }
        } catch (error) {
            logger.debug('Error updating counters on member leave:', error);
        }

        try {
            const birthdays = await getGuildBirthdays(member.client, guild.id);
            if (birthdays[user.id]) {
                const backupKey = `guild:${guild.id}:birthdays:left`;
                const backup = (await member.client.db.get(backupKey)) || {};
                backup[user.id] = birthdays[user.id];
                await member.client.db.set(backupKey, backup);
                await deleteBirthday(member.client, guild.id, user.id);
                logger.debug(`Birthday backed up and removed for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error handling birthday on member leave:', error);
        }

        try {
            const userApplications = await getUserApplications(member.client, guild.id, user.id);
            if (userApplications && userApplications.length > 0) {
                for (const app of userApplications) {
                    await deleteApplication(member.client, guild.id, app.id, user.id);
                }
                logger.debug(`Removed ${userApplications.length} applications for user ${user.id} in guild ${guild.id}`);
            }
        } catch (error) {
            logger.debug('Error handling applications on member leave:', error);
        }

        try {
            await deleteUserLevelData(member.client, guild.id, user.id);
            logger.debug(`Removed leveling data for user ${user.id} in guild ${guild.id}`);
        } catch (error) {
            logger.debug('Error handling leveling data on member leave:', error);
        }
        
    } catch (error) {
        logger.error('Error in guildMemberRemove event:', error);
    }
  }
};