import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { handleReportAction, reportActionAllowed } from '../src/services/reportActionService.js';
import { registerReport, reportKey, reportCaseControls, REPORT_CATEGORY_ID, REPORT_CASE_MS, restoreReportCaseTimers, handleReportCaseControl } from '../src/services/reportCaseService.js';
import { withCloudyFooter, CLOUDY_STANDARD_FOOTER } from '../src/utils/cloudyFooter.js';
import { resolveDiscordAppealIdentity } from '../src/services/appealIdentityService.js';

function fixture() {
  const values = new Map(), payloads = [], removed = [];
  const storage = { get: async key => structuredClone(values.get(key) || null), set: async (key,value) => { values.set(key,structuredClone(value)); return true; }, list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const staff = { id: 'staff', user: { id: 'staff' }, permissions: new PermissionsBitField(), roles: { cache: new Collection([['staff-role',{}]]) } };
  const reporter = { id: 'reporter', user: { id: 'reporter' }, permissions: new PermissionsBitField(), roles: { cache: new Collection() } };
  const client = { db: storage, user: { id: 'bot' } };
  const channels = new Collection();
  const guild = { id: 'report-lifecycle-guild', ownerId: 'owner', client, roles: { everyone: { id: 'everyone' }, cache: new Collection([['staff-role',{id:'staff-role',name:'Staff'}]]) },
    members: { fetch: async id => id === staff.id ? staff : reporter }, channels: { fetch: async id => channels.get(id), create: async data => { const ch = channel(`case-${channels.size}`,data.name); ch.creation = data; channels.set(ch.id,ch); return ch; } } };
  client.guilds = { cache: new Collection([[guild.id,guild]]) };
  values.set(`guild:${guild.id}:config`,{ticketStaffRoleId:'staff-role'});
  function channel(id,name=id) { const messages = new Collection(); const ch = { id,name,guild,permissionsFor:()=>({has:()=>false}),messages:{fetch:async id=>messages.get(id)},
    delete:async()=>removed.push(id),send:async payload=>{const msg={id:`sent-${payloads.length}`,author:client.user,channelId:id,channel:ch,...payload,edit:async update=>Object.assign(msg,update)};payloads.push(msg);messages.set(msg.id,msg);return msg;}};return ch; }
  const reports = channel('reports'), originalChannel = channel('original');
  originalChannel.messages.fetch = async id => ({ id, guild, delete: async () => removed.push(id) });
  channels.set(reports.id,reports);channels.set(originalChannel.id,originalChannel);channels.set(REPORT_CATEGORY_ID,{id:REPORT_CATEGORY_ID,type:ChannelType.GuildCategory});
  const report = {id:'report',author:client.user,channelId:reports.id,channel:reports,components:[],delete:async()=>removed.push('report-embed')};
  const interaction = {guild,guildId:guild.id,channel:reports,channelId:reports.id,member:staff,user:staff.user,message:report,inGuild:()=>true,deferReply:async()=>{},deleteReply:async()=>{},editReply:async payload=>payloads.push(payload)};
  // Discord interaction properties are not enumerable.
  for (const key of ['guild', 'user']) Object.defineProperty(interaction, key, { value: interaction[key], writable: true, enumerable: false });
  return {values,client,guild,staff,reporter,reports,channels,report,interaction,payloads,removed};
}

test('report Delete targets original message; separate member/staff controls survive restart and expire at 24 hours',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const f=fixture();
  await registerReport(f.client,f.report,{guildId:f.guild.id,reporterId:'reporter',targetId:'target',sourceChannelId:'original',sourceMessageId:'original-message'});
  await handleReportAction(f.interaction,f.client,['delete','target']);
  assert.deepEqual(f.removed,['original-message']);
  let record=await f.client.db.get(reportKey(f.guild.id,f.report.id));
  assert.equal(record.number,1);assert.equal(record.actions.delete.notified,true);assert.equal(record.expiresAt-Date.now(),REPORT_CASE_MS);
  const ch=f.channels.get(record.caseChannelId);assert.equal(ch.creation.parent,REPORT_CATEGORY_ID);assert.equal(ch.name,'report-1');
  const staffNotice=f.payloads.find(p=>p.channelId==='reports');
  const memberNotice=f.payloads.find(p=>p.id===record.memberMessageIds[0]);
  assert.deepEqual(staffNotice.components[0].toJSON().components.map(b=>b.label),['Read','Delete']);
  assert.deepEqual(memberNotice.components[0].toJSON().components.map(b=>[b.label,b.style]),[['Read',2]]);
  assert.match(staffNotice.content,/<@reporter> <@&staff-role>/);assert.match(JSON.stringify(memberNotice.embeds),/automatically deleted after 24 hours/);
  await restoreReportCaseTimers(f.client);
  t.mock.timers.tick(REPORT_CASE_MS-1);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.removed,['original-message']);
  t.mock.timers.tick(1);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.removed,['original-message',record.caseChannelId]);
  record=await f.client.db.get(reportKey(f.guild.id,f.report.id));assert.ok(record.closedAt);
  assert.equal(staffNotice.components[0].toJSON().components.every(b=>b.disabled),true);
});

test('member Read is recorded once; forged Delete is rejected; staff can delete the linked case',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture();
  await registerReport(f.client,f.report,{guildId:f.guild.id,reporterId:'reporter',targetId:'target',sourceChannelId:'original',sourceMessageId:'original-message'});
  await handleReportAction(f.interaction,f.client,['delete','target']);
  const key=reportKey(f.guild.id,f.report.id), record=await f.client.db.get(key);
  const memberNotice=f.payloads.find(p=>p.id===record.memberMessageIds[0]);
  Object.assign(f.interaction,{user:f.reporter.user,message:memberNotice,channelId:record.caseChannelId});
  await handleReportCaseControl(f.interaction,f.client,['read','report']);
  assert.equal((await f.client.db.get(key)).readBy.reporter.notified,true);
  const count=f.payloads.length;await handleReportCaseControl(f.interaction,f.client,['read','report']);assert.equal(f.payloads.length,count);
  await handleReportCaseControl(f.interaction,f.client,['delete','report']);assert.deepEqual(f.removed,['original-message']);
  Object.assign(f.interaction,{user:f.staff.user,message:f.payloads.find(p=>p.id===record.staffMessageIds[0]),channelId:'reports'});
  await handleReportCaseControl(f.interaction,f.client,['delete','report']);assert.deepEqual(f.removed,['original-message',record.caseChannelId]);
  assert.deepEqual(reportCaseControls(record)[0].toJSON().components.map(b=>b.label),['Read']);
});

test('standard footer preserves body, handles plain text and long content without truncation',()=>{
  assert.equal(withCloudyFooter({embeds:[{title:'Saved title',description:'Saved text',footer:{text:'old'}}]}).embeds[0].footer.text,CLOUDY_STANDARD_FOOTER);
  const plain=withCloudyFooter({content:'Hello'});assert.equal(plain.content,`Hello\n\n${CLOUDY_STANDARD_FOOTER}`);assert.deepEqual(withCloudyFooter(plain),plain);
  const long=withCloudyFooter({content:'x'.repeat(2000)});assert.equal(long.content.length,2000);assert.equal(long.embeds[0].footer.text,CLOUDY_STANDARD_FOOTER);
});

test('appeal identity resolves banned username and rejects ambiguous usernames',async()=>{
  const users=new Collection([['first',{user:{id:'12345678901234567',username:'player'}}]]);
  const guild={members:{cache:new Collection(),fetch:async()=>new Collection()},bans:{fetch:async()=>users}};
  assert.equal(await resolveDiscordAppealIdentity(guild,'@player'),'12345678901234567');
  assert.equal(await resolveDiscordAppealIdentity(guild,'<@12345678901234567>'),'12345678901234567');
  users.set('second',{user:{id:'12345678901234568',username:'player'}});
  await assert.rejects(resolveDiscordAppealIdentity(guild,'player'),/ambiguous/);
});


test('Owner role can use all report actions; ordinary staff cannot use Ban', () => {
  const f = fixture();
  const config = { ticketStaffRoleId: 'staff-role' };
  assert.equal(reportActionAllowed(f.interaction, 'ban', config), false);
  f.staff.roles.cache = new Collection([['owner-role', { name: 'Owner' }]]);
  for (const action of ['ban', 'timeout', 'delete']) assert.equal(reportActionAllowed(f.interaction, action, config), true);
  f.staff.roles.cache.clear();
  for (const action of ['ban', 'timeout', 'delete']) assert.equal(reportActionAllowed(f.interaction, action, config), false);
});

test('report case has one member notification and no staff-only Delete button in the shared channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await registerReport(f.client, f.report, { guildId: f.guild.id, reporterId: 'reporter', targetId: 'target', sourceChannelId: 'original', sourceMessageId: 'original-message' });
  await handleReportAction(f.interaction, f.client, ['delete', 'target']);
  const record = await f.client.db.get(reportKey(f.guild.id, f.report.id));
  const notices = f.payloads.filter(p => p.channelId === record.caseChannelId);
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /<@reporter> <@&staff-role>/);
  assert.deepEqual(notices[0].components[0].toJSON().components.map(b => b.label), ['Read']);
  const privateNotice = f.payloads.find(p => p.channelId === 'reports');
  assert.deepEqual(privateNotice.components[0].toJSON().components.map(b => b.label), ['Read', 'Delete']);
});

test('unmute username resolution needs member access without requiring ban-list access', async () => {
  const user = { id: '12345678901234567', username: 'mutedplayer' };
  const guild = { members: { cache: new Collection([['target', { user }]]), fetch: async () => new Collection() }, bans: { fetch: async () => { throw new Error('Missing BanMembers'); } } };
  assert.equal(await resolveDiscordAppealIdentity(guild, 'mutedplayer', { includeBans: false }), user.id);
});

