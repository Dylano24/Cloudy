import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { getEmbedRegistry, registerCloudyEmbedMessage } from './embedRegistryService.js';
import { withEmbedBuilderMessageMutation } from './embedBuilderMutationLock.js';
import { buildTicketPanelComponents, TICKET_FAQ_CHANNEL_ID } from './ticketPanelBuilder.js';
import { sameTicketComponents as sameRows } from '../utils/ticket/ticketComponentEquality.js';

const rowsOf = message => (message.components || []).map(row => row.toJSON?.() || row);
const hasCreate = message => rowsOf(message).some(row => row.components?.some(button => button.custom_id === 'create_ticket'));

function validateTargets(client, source, target) {
  if (!source?.id || !target?.id || source.id === target.id) throw new Error('Choose two distinct ticket panel messages');
  if (!source.guildId || source.guildId !== target.guildId || source.channelId !== target.channelId) {
    throw new Error('Both ticket panels must be in the same server and channel');
  }
  if (source.author?.id !== client.user?.id || target.author?.id !== client.user?.id) {
    throw new Error('Both selected messages must belong to Cloudy');
  }
  if (!hasCreate(source)) throw new Error('The source has no working create_ticket control');
  const title = String(target.embeds?.[0]?.title || '').replace(/<a?:[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '').trim().toLowerCase();
  if (title !== 'contact the staff team' || target.embeds.length !== 1) {
    throw new Error('Select the new Contact the staff team embed');
  }
}

function isKnownFaqToSupportUpgrade(previous, plan, guildId) {
  if (previous.length !== 1 || plan.length !== 1) return false;
  const before = previous[0]?.components || [];
  const after = plan[0]?.components || [];
  if (previous[0]?.type !== 1 || before.length !== 2 || after.length !== 2) return false;
  const oldLink = before[1];
  const newLink = after[1];
  if (oldLink.type !== 2 || oldLink.style !== 5 || oldLink.label !== 'FAQ'
    || oldLink.emoji?.name !== '❔'
    || oldLink.url !== `https://discord.com/channels/${guildId}/${TICKET_FAQ_CHANNEL_ID}`
    || newLink.label !== 'Support assistant' || newLink.url !== oldLink.url) return false;
  return sameRows([{type: 1, components: [before[0]]}], [{type: 1, components: [after[0]]}]);
}

// Explicit maintenance operation, never invoked by startup or history scans.
// Preview is read-only. Applying edits only message components, then records
// those same components for Builder and changes only the panel config fields.
export async function transferTicketPanelControls(client, {source, target}, {apply = false} = {}) {
  validateTargets(client, source, target);
  const preview = (from, to, config) => ({applied: false, guildId: to.guildId, channelId: to.channelId,
    sourceMessageId: from.id, targetMessageId: to.id,
    components: buildTicketPanelComponents(client, to.guildId, config, rowsOf(from)).map(row => row.toJSON())});
  if (!apply) return preview(source, target, {});
  return withEmbedBuilderMessageMutation(target.guildId, target.channelId, target.id, async () => {
    const freshTarget = target.fetch ? await target.fetch(true) : target;
    const freshSource = source.fetch ? await source.fetch(true) : source;
    validateTargets(client, freshSource, freshTarget);
    const config = {...await getGuildConfig(client, freshTarget.guildId, {}, {strict: true}),
      ticketFaqChannelId: TICKET_FAQ_CHANNEL_ID};
    const plan = preview(freshSource, freshTarget, config);
    const previous = structuredClone(rowsOf(freshTarget));
    if (previous.length && !sameRows(previous, plan.components)
      && !isKnownFaqToSupportUpgrade(previous, plan.components, freshTarget.guildId)) {
      throw new Error('The target already has different controls; review them before replacing anything');
    }
    if (sameRows(previous, plan.components) && config.ticketPanelMessageId === freshTarget.id) return plan;
    const records = await getEmbedRegistry(freshTarget.guildId);
    const prior = records.find(record => record.messageId === freshTarget.id && Number(record.embedIndex || 0) === 0);
    const registrySource = prior?.source || 'embed-builder';
    const registryOptions = {manualSave: true,
      ...(prior && Object.hasOwn(prior, 'explicitSave') ? {explicitSave: prior.explicitSave} : {})};
    let edited = freshTarget;
    let controlsChanged = false;
    try {
      if (!sameRows(previous, plan.components)) {
        edited = await freshTarget.edit({components: plan.components});
        controlsChanged = true;
      }
      if (!await registerCloudyEmbedMessage(edited, registrySource, registryOptions)) {
        throw new Error('Could not record the new ticket controls for Embed Builder');
      }
      const data = edited.embeds[0].toJSON?.() || edited.embeds[0];
      const create = plan.components.flatMap(row => row.components).find(button => button.custom_id === 'create_ticket');
      await updateGuildConfig(client, freshTarget.guildId, {ticketPanelChannelId: freshTarget.channelId,
        ticketPanelMessageId: freshTarget.id, ticketPanelTitle: data.title, ticketPanelMessage: data.description,
        ticketButtonLabel: create.label, ticketFaqChannelId: TICKET_FAQ_CHANNEL_ID});
      return {...plan, applied: true};
    } catch (error) {
      if (controlsChanged) {
        const restored = await freshTarget.edit({components: previous}).catch(() => null);
        const recorded = restored && await registerCloudyEmbedMessage(restored, registrySource, registryOptions);
        if (!recorded) throw new AggregateError([error], 'Ticket transfer failed; controls rollback needs verification');
      }
      throw error;
    }
  });
}
