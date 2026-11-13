import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { DASHBOARD_PREFIX, canonicalString, createDashboardHandler, createNonceStore, planState } from '../src/web/dashboardApi.js';
import { BillingEventError, MONTH_DAYS, SUBSCRIPTION_GRACE_MS, applyBillingEvent, parseBillingEvent } from '../src/web/billingEntitlements.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const GUILD = '111111111111111111';
const BUYER = '222222222222222222';
const SECRET = 's'.repeat(48);

const oneTime = (over = {}) => parseBillingEvent({ eventKey: 'tip4serv:1:1:100::payment.success', event: 'grant', kind: 'one_time', guildId: GUILD, paymentRef: 'tip4serv:1:1:100', months: 1, buyerDiscordId: BUYER, ...over });
const sub = (over = {}) => parseBillingEvent({ eventKey: 'tip4serv:1:2:9:t1:subscription.created', event: 'grant', kind: 'subscription', guildId: GUILD, paymentRef: 'tip4serv:1:2:9:t1', subscriptionId: 'tip4serv:1:9', ...over });

test('billing events are validated strictly', () => {
  assert.throws(() => parseBillingEvent({}), BillingEventError);
  assert.throws(() => oneTime({ guildId: '123' }), /server ID/);
  assert.throws(() => oneTime({ months: 0 }), /months/);
  assert.throws(() => oneTime({ months: 1.5 }), /months/);
  assert.throws(() => oneTime({ event: 'renew' }), /one-time/);
  assert.throws(() => oneTime({ eventKey: 'short' }), /event key/);
  assert.throws(() => oneTime({ eventKey: 'has spaces in it!' }), /event key/);
  assert.throws(() => sub({ subscriptionId: undefined }), /subscription/);
  assert.throws(() => sub({ periodDays: 0 }), /period/);
  assert.equal(oneTime({ months: 3 }).days, 3 * MONTH_DAYS);
  assert.equal(sub().days, MONTH_DAYS);
  assert.equal(oneTime({ buyerDiscordId: 'not-an-id' }).buyerDiscordId, null);
});

test('a one-time purchase adds its months once, even when the webhook is retried', () => {
  const first = applyBillingEvent({}, oneTime({ months: 2 }), NOW);
  assert.equal(first.result, 'granted');
  const plan = planState(first.record, { nowMs: NOW });
  assert.equal(plan.status, 'premium');
  assert.equal(Date.parse(plan.until), NOW + 60 * DAY);
  assert.equal(plan.renews, undefined);

  const retry = applyBillingEvent(first.record, oneTime({ months: 2 }), NOW + 1000);
  assert.equal(retry.result, 'duplicate');
  assert.equal(retry.record, first.record, 'a duplicate never rewrites the record');

  // A manual resend gets a new event key but is the same payment: no extra time.
  const resend = applyBillingEvent(first.record, oneTime({ months: 2, eventKey: 'tip4serv:1:1:100::payment.success:resend' }), NOW + 2000);
  assert.equal(resend.result, 'already_granted');
  assert.equal(resend.record.billing.paidUntil, first.record.billing.paidUntil);
});

test('one-time time stacks on top of time that is left', () => {
  const a = applyBillingEvent({}, oneTime(), NOW).record;
  const b = applyBillingEvent(a, oneTime({ eventKey: 'tip4serv:1:1:101::payment.success', paymentRef: 'tip4serv:1:1:101' }), NOW + DAY).record;
  assert.equal(Date.parse(b.billing.paidUntil), NOW + 60 * DAY);
});

test('subscriptions renew from the end of the paid period and keep a short grace window', () => {
  const created = applyBillingEvent({}, sub(), NOW);
  assert.equal(created.result, 'granted');
  assert.equal(planState(created.record, { nowMs: NOW }).renews, true);
  const periodEnd = NOW + MONTH_DAYS * DAY;
  assert.equal(Date.parse(created.record.billing.subscription.periodEnd), periodEnd);

  // payment.success for the same first payment is not counted twice.
  const sameCheckout = applyBillingEvent(created.record, sub({ eventKey: 'tip4serv:1:2:9:t1:payment.success' }), NOW);
  assert.equal(sameCheckout.result, 'already_granted');

  // Renewal webhook arrives one day late: still Premium meanwhile, and the next period starts at the old end.
  assert.equal(planState(created.record, { nowMs: periodEnd + DAY }).status, 'premium');
  const renewed = applyBillingEvent(created.record, sub({ event: 'renew', eventKey: 'tip4serv:1:2:9:t2:subscription.renewed', paymentRef: 'tip4serv:1:2:9:t2' }), periodEnd + DAY);
  assert.equal(renewed.result, 'renewed');
  assert.equal(Date.parse(renewed.record.billing.subscription.periodEnd), periodEnd + MONTH_DAYS * DAY);

  // No renewal at all: Premium stops after the grace window.
  assert.equal(planState(created.record, { nowMs: periodEnd + SUBSCRIPTION_GRACE_MS + 1 }).status, 'expired');
});

test('an expired subscription ends Premium and never restarts the free trial', () => {
  const created = applyBillingEvent({}, sub(), NOW).record;
  const expired = applyBillingEvent(created, sub({ event: 'expire', eventKey: 'tip4serv:1:2:9::subscription.expired' }), NOW + 10 * DAY);
  assert.equal(expired.result, 'expired');
  const plan = planState(expired.record, { nowMs: NOW + 10 * DAY + 1 });
  assert.equal(plan.status, 'expired');
  assert.equal(plan.canSave, false);
  assert.equal(applyBillingEvent(expired.record, sub({ event: 'expire', eventKey: 'tip4serv:1:2:9::subscription.expired:2' }), NOW + 11 * DAY).result, 'unmatched');
});

test('a refund removes only what that payment added', () => {
  const owner = { premiumUntil: new Date(NOW + 10 * DAY).toISOString() };
  const paid = applyBillingEvent(owner, oneTime({ months: 1 }), NOW).record;
  assert.equal(Date.parse(planState(paid, { nowMs: NOW }).until), NOW + 30 * DAY);
  const refunded = applyBillingEvent(paid, oneTime({ event: 'refund', eventKey: 'tip4serv:1:1:100::payment.refund' }), NOW + DAY);
  assert.equal(refunded.result, 'refunded');
  // The owner's 10 days are untouched; paid time is gone.
  assert.equal(Date.parse(planState(refunded.record, { nowMs: NOW + DAY }).until), NOW + 10 * DAY);
  assert.equal(applyBillingEvent(refunded.record, oneTime({ event: 'refund', eventKey: 'tip4serv:1:1:100::payment.refund:2' }), NOW + DAY).result, 'already_refunded');
  assert.equal(applyBillingEvent(refunded.record, oneTime({ event: 'refund', eventKey: 'tip4serv:1:1:999::payment.refund', paymentRef: 'tip4serv:1:1:999' }), NOW + DAY).result, 'unmatched');
});

test('a refunded subscription payment ends that period', () => {
  const created = applyBillingEvent({}, sub(), NOW).record;
  const refunded = applyBillingEvent(created, sub({ event: 'refund', eventKey: 'tip4serv:1:2:9:t1:payment.refund' }), NOW + DAY).record;
  assert.equal(refunded.billing.subscription.status, 'refunded');
  assert.equal(planState(refunded, { nowMs: NOW + DAY + 1 }).status, 'expired');
});

test('a failed payment changes nothing but is recorded once', () => {
  const created = applyBillingEvent({}, sub(), NOW).record;
  const failed = applyBillingEvent(created, sub({ event: 'fail', eventKey: 'tip4serv:1:2:9:t3:payment.failed', paymentRef: 'tip4serv:1:2:9:t3' }), NOW + DAY);
  assert.equal(failed.result, 'recorded');
  assert.deepEqual(failed.record.billing.subscription, created.billing.subscription);
  assert.ok(failed.record.billing.processed.includes('tip4serv:1:2:9:t3:payment.failed'));
});

// ---------------------------------------------------------------- route

function signHeaders({ method, path, body, actor = BUYER }) {
  const timestamp = String(Math.floor(NOW / 1000));
  const nonce = randomBytes(16).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(canonicalString({ method, path, timestamp, nonce, actorId: actor, body })).digest('base64url');
  return { 'x-cloudy-dashboard-timestamp': timestamp, 'x-cloudy-dashboard-nonce': nonce, 'x-cloudy-dashboard-actor': actor, 'x-cloudy-dashboard-signature': signature };
}

function handler({ inGuild = true } = {}) {
  const store = new Map();
  const client = {
    isReady: () => true,
    user: { id: '777777777777777777' },
    application: { owner: { id: '999999999999999999' } },
    guilds: { cache: new Map(inGuild ? [[GUILD, { id: GUILD, name: 'Cloudy' }]] : []) },
    db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } },
  };
  const handle = createDashboardHandler({ client, env: { CLOUDY_DASHBOARD_API_SECRET: SECRET }, nonces: createNonceStore(() => NOW), modules: {}, insights: {}, now: () => NOW, identify: async () => '999999999999999999' });
  return { handle, store };
}

async function post(handle, payload, { headers } = {}) {
  const path = `${DASHBOARD_PREFIX}/billing/premium`;
  const body = JSON.stringify(payload);
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handle({ method: 'POST', originalUrl: path, headers: headers || signHeaders({ method: 'POST', path, body }), body: Buffer.from(body) }, res);
  return res;
}

const payload = { eventKey: 'tip4serv:1:1:100::payment.success', event: 'grant', kind: 'one_time', guildId: GUILD, paymentRef: 'tip4serv:1:1:100', months: 1, buyerDiscordId: BUYER };

test('billing route: only the signed website connection may grant Premium', async () => {
  const { handle, store } = handler();
  // Even Cloudy's owner, signed in with Discord, cannot call it.
  const viaDiscord = await post(handle, payload, { headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } });
  assert.equal(viaDiscord.statusCode, 403);
  assert.equal(store.size, 0);
  const unsigned = await post(handle, payload, { headers: {} });
  assert.equal(unsigned.statusCode, 401);

  const ok = await post(handle, payload);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.result, 'granted');
  assert.equal(ok.body.plan.status, 'premium');
  assert.equal(ok.body.inGuild, true);
  const audit = store.get(`guild:${GUILD}:dashboard:audit`);
  assert.deepEqual(audit[0].keys, ['billing:one_time:grant:granted']);
  assert.equal(audit[0].actor, BUYER);

  const again = await post(handle, payload);
  assert.equal(again.body.result, 'duplicate');
  assert.equal(store.get(`guild:${GUILD}:dashboard:audit`).length, 1, 'a duplicate is not audited again');
});

test('billing route: invalid events are refused and paying before inviting Cloudy still counts', async () => {
  const { handle, store } = handler({ inGuild: false });
  const bad = await post(handle, { ...payload, months: 99 });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.body.path, 'months');
  const early = await post(handle, payload);
  assert.equal(early.statusCode, 200);
  assert.equal(early.body.inGuild, false);
  assert.equal(store.get(`guild:${GUILD}:dashboard:plan`).billing.grants['tip4serv:1:1:100'].days, 30);
});
