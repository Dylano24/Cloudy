import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { appealReviewKey, buildAppealActions } from '../services/appealPresentationService.js';

const APPEALS_CHANNEL_ID = '1539372283418910810';
const CLOUDY_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const SOURCE_HEADER = 'cloudy-store-appeal-v1';

function clean(value, max = 1000) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function shown(value) {
  const text = clean(value) || 'Not provided';
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function validEmail(value) {
  const email = clean(value, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function registerAppealsApi(app, client) {
  app.post('/api/appeals', async (req, res) => {
    try {
      if (req.get('x-cloudy-source') !== SOURCE_HEADER) {
        return res.status(403).json({ error: 'Forbidden.' });
      }

      const appeal = req.body || {};
      const scope = appeal.scope === 'rust' ? 'rust' : appeal.scope === 'discord' ? 'discord' : '';
      const action = (scope === 'rust' ? ['Ban'] : ['Mute', 'Ban']).includes(appeal.action) ? appeal.action : '';
      const discordIdentity = scope === 'discord' ? clean(appeal.discordIdentity, 100) : '';
      const gamertag = scope === 'rust' ? clean(appeal.gamertag, 100) : '';
      const email = clean(appeal.email, 254);
      const punishmentReason = clean(appeal.punishmentReason);
      const punishmentJustified = clean(appeal.punishmentJustified);
      const acceptanceReason = clean(appeal.acceptanceReason);
      const futureChanges = clean(appeal.futureChanges);
      const evidence = clean(appeal.evidence);
      const additionalInfo = clean(appeal.additionalInfo);

      if (!scope || !action || !validEmail(email) || !punishmentReason || !punishmentJustified || !acceptanceReason || !futureChanges) {
        return res.status(400).json({ error: 'Please complete every required field correctly.' });
      }
      if (scope === 'discord' && !discordIdentity) {
        return res.status(400).json({ error: 'Discord username / ID is required.' });
      }
      if (scope === 'rust' && !gamertag) {
        return res.status(400).json({ error: 'Gamertag is required.' });
      }

      if (!client.isReady()) {
        return res.status(503).json({ error: 'Cloudy is still starting. Please try again in a moment.' });
      }

      const channel = await resolveCloudyChannel(client, 'banTimeoutAppeals', { textOnly: true });
      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        logger.error(`[Appeals] Channel ${APPEALS_CHANNEL_ID} is unavailable or not text based.`);
        return res.status(503).json({ error: 'Appeal delivery is temporarily unavailable.' });
      }

      const id = `CLD-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
      const scopeLabel = scope === 'discord' ? 'Discord' : 'Rust server';

      const review = { id, guildId: channel.guild.id, channelId: channel.id, scope, action, discordIdentity, gamertag, status: 'pending' };
      const sent = await channel.send({
        components: buildAppealActions(review),
        allowedMentions: { parse: [] },
        ...([punishmentReason, punishmentJustified, acceptanceReason, futureChanges, evidence, additionalInfo].some(value => value.length > 500)
          ? { files: [{ attachment: Buffer.from(JSON.stringify({ id, scope, action, ...(scope === 'discord' ? { discordIdentity } : { gamertag }), email, punishmentReason, punishmentJustified, acceptanceReason, futureChanges, evidence, additionalInfo }, null, 2)), name: `${id}.txt` }] }
          : {}),
        embeds: [{
          title: `${scopeLabel} appeal — ${action}`,
          description: `A new appeal was submitted through the Cloudy website.\n\n**Appeal ID:** ${id}`,
          color: 0xFFFFFF,
          thumbnail: { url: CLOUDY_LOGO_URL },
          fields: [
            ...(scope === 'discord' ? [{ name: 'Discord username / ID', value: shown(discordIdentity), inline: true }] : []),
            ...(scope === 'rust' ? [{ name: 'Gamertag', value: shown(gamertag), inline: true }] : []),
            { name: 'Email', value: shown(email), inline: false },
            { name: 'Why were you muted/banned?', value: shown(punishmentReason), inline: false },
            { name: 'Was the punishment justified?', value: shown(punishmentJustified), inline: false },
            { name: 'Why should the appeal be accepted?', value: shown(acceptanceReason), inline: false },
            { name: 'What will you do differently if your appeal is accepted?', value: shown(futureChanges), inline: false },
            { name: 'Evidence', value: shown(evidence), inline: false },
            { name: 'Additional information', value: shown(additionalInfo), inline: false },
          ],
          footer: { text: `Cloudy Inc. • ${id}` },
          timestamp: new Date().toISOString(),
        }],
      });

      if (await client.db.set(appealReviewKey(review.guildId, id), { ...review, messageId: sent.id }) === false) throw new Error('Appeal review could not be saved.');

      logger.info(`[Appeals] Delivered ${id} to channel ${channel.id}.`);
      return res.status(200).json({ ok: true, id });
    } catch (error) {
      logger.error('[Appeals] Delivery failed:', error);
      return res.status(500).json({ error: 'Your appeal could not be delivered to staff. Please try again in a moment.' });
    }
  });
}
