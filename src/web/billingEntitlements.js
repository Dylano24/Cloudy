// Cloudy Bot Premium entitlements bought on Cloudy Store (Tip4Serv).
//
// The website verifies Tip4Serv's webhook signature, maps the paid product to
// an entitlement event and sends it here over the signed dashboard connection
// (shared secret only; a Discord login can never reach this route). Every
// event carries a stable key, so a webhook retry or a manual resend from
// Tip4Serv changes nothing a second time. Owner grants (`premiumUntil` set on
// the Plan page) and paid time are kept apart, so a refund or an expired
// subscription only removes what that payment added.

const SNOWFLAKE = /^\d{17,20}$/;
const DAY_MS = 86_400_000;
// A renewal webhook may arrive a little after the period ends; Premium keeps
// working meanwhile. Tip4Serv sends subscription.expired when it really ends.
export const SUBSCRIPTION_GRACE_MS = 3 * DAY_MS;
export const MONTH_DAYS = 30;
const MAX_PROCESSED = 500;
const MAX_GRANTS = 500;
const EVENTS = new Set(['grant', 'renew', 'expire', 'refund', 'fail']);
const KINDS = new Set(['one_time', 'subscription']);
const KEY = /^[A-Za-z0-9:._-]{8,200}$/;
const REF = /^[A-Za-z0-9:._-]{1,200}$/;

export class BillingEventError extends Error {
  constructor(message, path) {
    super(message);
    this.name = 'BillingEventError';
    this.path = path;
  }
}

/** Validates the website's entitlement event. Throws BillingEventError. */
export function parseBillingEvent(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const fail = (message, path) => { throw new BillingEventError(message, path); };
  const eventKey = typeof input.eventKey === 'string' ? input.eventKey : '';
  if (!KEY.test(eventKey)) fail('Invalid event key.', 'eventKey');
  const event = typeof input.event === 'string' ? input.event : '';
  if (!EVENTS.has(event)) fail('Invalid event.', 'event');
  const kind = typeof input.kind === 'string' ? input.kind : '';
  if (!KINDS.has(kind)) fail('Invalid kind.', 'kind');
  const guildId = typeof input.guildId === 'string' ? input.guildId.trim() : '';
  if (!SNOWFLAKE.test(guildId)) fail('Invalid server ID.', 'guildId');
  const paymentRef = typeof input.paymentRef === 'string' ? input.paymentRef : '';
  if (!REF.test(paymentRef)) fail('Invalid payment reference.', 'paymentRef');
  const buyerDiscordId = typeof input.buyerDiscordId === 'string' && SNOWFLAKE.test(input.buyerDiscordId) ? input.buyerDiscordId : null;
  const subscriptionId = typeof input.subscriptionId === 'string' && REF.test(input.subscriptionId) ? input.subscriptionId : null;
  if (kind === 'subscription' && !subscriptionId) fail('Invalid subscription.', 'subscriptionId');
  let days = 0;
  if (event === 'grant' || event === 'renew') {
    if (kind === 'one_time') {
      const months = input.months;
      if (!Number.isInteger(months) || months < 1 || months > 36) fail('Choose 1 to 36 months.', 'months');
      days = months * MONTH_DAYS;
    } else {
      const periodDays = input.periodDays === undefined ? MONTH_DAYS : input.periodDays;
      if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 366) fail('Invalid subscription period.', 'periodDays');
      days = periodDays;
    }
  }
  if (kind === 'one_time' && (event === 'renew' || event === 'expire')) fail('A one-time purchase cannot renew or expire.', 'event');
  return { eventKey, event, kind, guildId, paymentRef, buyerDiscordId, subscriptionId, days };
}

const iso = ms => new Date(ms).toISOString();
const ms = value => Date.parse(value || '') || 0;

/** Premium end from paid billing alone (one-time time and an active subscription). */
export function billingPremiumEnd(record, nowMs) {
  const billing = record?.billing;
  if (!billing) return 0;
  let end = ms(billing.paidUntil);
  const subscription = billing.subscription;
  if (subscription?.status === 'active') {
    const periodEnd = ms(subscription.periodEnd);
    // Within the grace window Premium keeps working, but the shown end stays the real period end.
    if (periodEnd + SUBSCRIPTION_GRACE_MS > nowMs) end = Math.max(end, periodEnd > nowMs ? periodEnd : nowMs + 1);
  }
  return end;
}

function trim(list, max) {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * Applies one entitlement event to the stored plan record. Pure: returns the
 * next record and a short result; the caller stores it under the plan lock.
 */
export function applyBillingEvent(record, event, nowMs) {
  const base = record && typeof record === 'object' ? record : {};
  const billing = {
    processed: Array.isArray(base.billing?.processed) ? [...base.billing.processed] : [],
    grants: { ...(base.billing?.grants || {}) },
    paidUntil: base.billing?.paidUntil || null,
    subscription: base.billing?.subscription ? { ...base.billing.subscription } : null,
    lastBuyerId: base.billing?.lastBuyerId || null,
  };
  if (billing.processed.includes(event.eventKey)) return { record: base, result: 'duplicate' };

  let result = 'recorded';
  const grantFor = billing.grants[event.paymentRef];
  if (event.event === 'grant' || event.event === 'renew') {
    if (grantFor && !grantFor.revoked) {
      // The same payment already added its time (e.g. payment.success and subscription.created for one checkout).
      result = 'already_granted';
    } else if (event.kind === 'one_time') {
      billing.paidUntil = iso(Math.max(nowMs, ms(billing.paidUntil)) + event.days * DAY_MS);
      billing.grants[event.paymentRef] = { kind: 'one_time', days: event.days, at: iso(nowMs) };
      result = 'granted';
    } else {
      const current = billing.subscription;
      // A renewal continues the billing cycle from the end of the paid period,
      // also when its webhook arrives late (within the grace window): webhook
      // delays must not shift the cycle and add free days.
      const sameActive = current?.status === 'active' && current.id === event.subscriptionId && ms(current.periodEnd) + SUBSCRIPTION_GRACE_MS > nowMs;
      const from = sameActive ? ms(current.periodEnd) : nowMs;
      billing.subscription = { id: event.subscriptionId, status: 'active', periodEnd: iso(from + event.days * DAY_MS), updatedAt: iso(nowMs) };
      billing.grants[event.paymentRef] = { kind: 'subscription', subscriptionId: event.subscriptionId, days: event.days, at: iso(nowMs) };
      result = event.event === 'renew' ? 'renewed' : 'granted';
    }
    if (event.buyerDiscordId) billing.lastBuyerId = event.buyerDiscordId;
  } else if (event.event === 'expire') {
    const current = billing.subscription;
    if (current && (!event.subscriptionId || current.id === event.subscriptionId) && current.status === 'active') {
      billing.subscription = { ...current, status: 'expired', periodEnd: iso(Math.min(ms(current.periodEnd), nowMs)), updatedAt: iso(nowMs) };
      result = 'expired';
    } else {
      result = 'unmatched';
    }
  } else if (event.event === 'refund') {
    if (!grantFor) {
      result = 'unmatched';
    } else if (grantFor.revoked) {
      result = 'already_refunded';
    } else {
      const removeMs = grantFor.days * DAY_MS;
      if (grantFor.kind === 'one_time') {
        billing.paidUntil = iso(Math.max(nowMs, ms(billing.paidUntil) - removeMs));
      } else if (billing.subscription && billing.subscription.id === grantFor.subscriptionId) {
        const end = Math.max(nowMs, ms(billing.subscription.periodEnd) - removeMs);
        billing.subscription = { ...billing.subscription, periodEnd: iso(end), status: end <= nowMs ? 'refunded' : billing.subscription.status, updatedAt: iso(nowMs) };
      }
      billing.grants[event.paymentRef] = { ...grantFor, revoked: true, revokedAt: iso(nowMs) };
      result = 'refunded';
    }
  }
  // 'fail' only records the event: an active subscription keeps its paid period.

  billing.processed = trim([...billing.processed, event.eventKey], MAX_PROCESSED);
  const grantKeys = Object.keys(billing.grants);
  if (grantKeys.length > MAX_GRANTS) for (const key of grantKeys.slice(0, grantKeys.length - MAX_GRANTS)) delete billing.grants[key];
  return { record: { ...base, billing }, result };
}
