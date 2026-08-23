import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

function getGatewayPing(client) {
    const ping = Number(client?.ws?.ping);
    return Number.isFinite(ping) && ping > 0 ? Math.round(ping) : null;
}

export default {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription("Checks the bot's latency and API speed"),

    async prefixExecute(interaction) {
        try {
            const startTime = Date.now();
            const pingingMessage = await interaction.reply({ content: 'Pinging...' });
            const responseLatency = Math.max(0, Date.now() - startTime);
            const gatewayPing = getGatewayPing(interaction.client);

            const embed = createEmbed({ title: 'Pong!', description: null }).addFields(
                { name: 'Bot Latency', value: `${responseLatency}ms`, inline: true },
                { name: 'API Latency', value: gatewayPing === null ? 'N/A' : `${gatewayPing}ms`, inline: true },
            );

            await pingingMessage.edit({ content: null, embeds: [embed] });
        } catch (error) {
            logger.error('Ping prefix command error:', error);
            if (!interaction.replied && !interaction._replyMessage) {
                await interaction.channel.send({
                    embeds: [createEmbed({ title: 'System Error', description: 'Could not determine latency at this time.', color: 'error' })],
                }).catch(() => {});
            }
        }
    },

    async execute(interaction) {
        try {
            // Measure immediately, before any defer/reply/edit. The previous
            // implementation included Discord REST reply/edit time in this number,
            // which made the displayed bot latency look much higher than reality.
            const interactionLatency = Math.max(0, Date.now() - interaction.createdTimestamp);
            const gatewayPing = getGatewayPing(interaction.client);

            const embed = createEmbed({ title: 'Pong!', description: null }).addFields(
                { name: 'Bot Latency', value: `${interactionLatency}ms`, inline: true },
                { name: 'API Latency', value: gatewayPing === null ? 'N/A' : `${gatewayPing}ms`, inline: true },
            );

            // One response only: no defer + "Pinging..." + second edit round-trip.
            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            logger.error('Ping command error:', error);
            try {
                if (interaction.deferred || interaction.replied) {
                    return await InteractionHelper.safeEditReply(interaction, {
                        embeds: [createEmbed({ title: 'System Error', description: 'Could not determine latency at this time.', color: 'error' })],
                    });
                }

                return await InteractionHelper.safeReply(interaction, {
                    embeds: [createEmbed({ title: 'System Error', description: 'Could not determine latency at this time.', color: 'error' })],
                    flags: MessageFlags.Ephemeral,
                });
            } catch (replyError) {
                logger.error('Failed to send error reply:', replyError);
            }
        }
    },
};
