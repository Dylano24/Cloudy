import { Events } from 'discord.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { logger } from '../utils/logger.js';

// Text is copied from the owner's #things-to-do request (7 November).
export function buildGuildBoostAnnouncement(userId, boostCount) {
  if (!/^\d{17,20}$/.test(String(userId))) throw new RangeError('Invalid booster');
  if (!Number.isSafeInteger(boostCount) || boostCount < 1) throw new RangeError('Invalid boost total');
  return {
    embeds: [{
      title: 'Cloudy Inc. just got a boost!',
      description: `<@${userId}> just boosted the server, helping us build something even better. Thank you for the support!\n\nTotal server boosts: ${boostCount}`,
      color: 0xFFFFFF,
    }],
    allowedMentions: { parse: [] },
  };
}

export default {
  name: Events.GuildMemberUpdate,
  once: false,
  async execute(oldMember, newMember) {
    if (newMember?.guild?.id !== '1532882647838228723') return;
    // A boost adds premiumSince, while role, name and other updates must not repost.
    if (oldMember?.premiumSinceTimestamp || !newMember.premiumSinceTimestamp) return;
    try {
      const guild = newMember.guild;
      const channel = await resolveCloudyChannel(newMember.client, 'boost', { guild, textOnly: true });
      if (!channel?.isSendable?.()) return;
      let count = guild.premiumSubscriptionCount;
      if (!Number.isInteger(count) || count < 1) {
        const fresh = await guild.fetch().catch(() => null);
        count = fresh?.premiumSubscriptionCount;
      }
      // Do not post a fabricated count when Discord has not provided one.
      if (!Number.isInteger(count) || count < 1) {
        logger.warn('[BOOST] Discord did not provide a valid server boost count');
        return;
      }
      await channel.send(buildGuildBoostAnnouncement(newMember.id, count));
    } catch (error) {
      logger.error('[BOOST] Announcement failed:', error);
    }
  },
};
