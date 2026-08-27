import { EmbedBuilder } from 'discord.js';
import { getUpcomingBirthdays } from '../../../services/birthdayService.js';
import { deleteBirthday } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);

        const next5 = await getUpcomingBirthdays(client, interaction.guildId, 5);

        if (next5.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No Birthdays Found')
                .setDescription('No birthdays have been set up in this server yet. Use `/birthday set` to add birthdays!');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        const userIds = next5.map(birthday => birthday.userId);
        const fetchedMembers = await interaction.guild.members.fetch({ user: userIds }).catch(() => null);
        const birthdaysWithMembers = fetchedMembers
            ? next5.map(birthday => ({
                birthday,
                member: fetchedMembers.get(birthday.userId) || null,
            }))
            : await Promise.all(
                next5.map(async birthday => ({
                    birthday,
                    member: await interaction.guild.members.fetch(birthday.userId).catch(() => null),
                })),
            );

        const currentBirthdays = birthdaysWithMembers.filter(({ birthday, member }) => {
            if (member) return true;
            deleteBirthday(client, interaction.guildId, birthday.userId).catch(() => null);
            return false;
        });

        if (currentBirthdays.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No Upcoming Birthdays')
                .setDescription('No upcoming birthdays found for current server members.');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        let birthdayList = `🎂 **Next 5 Upcoming Birthdays**\n\nHere are the next 5 birthdays in ${interaction.guild.name}:\n\n`;
        let displayIndex = 0;
        for (const { birthday, member } of currentBirthdays) {
            displayIndex += 1;

            let timeUntil = '';
            if (birthday.daysUntil === 0) {
                timeUntil = '🎉 **Today!**';
            } else if (birthday.daysUntil === 1) {
                timeUntil = '📅 **Tomorrow!**';
            } else {
                timeUntil = `In ${birthday.daysUntil} day${birthday.daysUntil > 1 ? 's' : ''}`;
            }

            birthdayList += `${displayIndex}. **${member.displayName}**\n<@${birthday.userId}>\n📅 **Date:** ${birthday.monthName} ${birthday.day}\n⏰ **Time:** ${timeUntil}\n\n`;
        }

        birthdayList += `Use /birthday set to add your birthday!`;

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Next 5 Upcoming Birthdays')
            .setDescription(birthdayList);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed]
        });

        logger.info('Next birthdays retrieved successfully', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            upcomingCount: displayIndex,
            commandName: 'next_birthdays'
        });
    }
};
