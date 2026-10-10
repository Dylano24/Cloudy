import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { inspectCloudyChannelLinks, formatCloudyChannelAudit } from '../src/services/cloudyChannelAuditService.js';

const readable=new Set([
  PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,
]);
function channel(id,name,grant=readable) {
  return {id,name,type:ChannelType.GuildText,isTextBased:()=>true,
    permissionsFor:()=>({has:flag=>grant.has(flag)})};
}
function mock(channels){
  const cache=new Map(channels.map(c=>[c.id,c]));
  return {guild:{id:'1532882647838228723',channels:{cache}},member:{id:'bot_mock'}};
}
test('audits existing Rust, Nitrado, ZORP and reports by original IDs or renamed channels without writes',()=>{
  const rust=channel('1533886914459861103','📰｜patch-notes');
  const nitrado=channel('1777777777777777777','🛰️｜nitrado-patch-notes');
  const zorp=channel('1888888888888888888','🛡️｜zorp-off-raid-protection');
  const reports=channel('1999999999999999999','📊｜reports');
  const {guild,member}=mock([rust,nitrado,zorp,reports]);
  const before=JSON.stringify([...guild.channels.cache.values()].map(c=>({id:c.id,name:c.name})));
  const result=inspectCloudyChannelLinks(guild,member);
  assert.equal(result.textChannels,4);
  assert.equal(result.readableTextChannels,4);
  for(const key of ['rustPatch','nitradoPatch','zorp','reports'])assert.equal(result.links[key].ok,true,key);
  assert.equal(result.links.nitradoPatch.id,nitrado.id);
  assert.equal(result.links.zorp.id,zorp.id);
  assert.equal(JSON.stringify([...guild.channels.cache.values()].map(c=>({id:c.id,name:c.name}))),before);
  assert.match(formatCloudyChannelAudit(result),/rustPatch=ok/);
  assert.match(formatCloudyChannelAudit(result),/zorp=ok/);
});
test('read-only health report distinguishes inaccessible and missing channels',()=>{
  const rust=channel('1533886914459861103','patch-notes',new Set([
    PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,
  ]));
  const {guild,member}=mock([rust]);
  const summary=inspectCloudyChannelLinks(guild,member);
  assert.equal(summary.unreadableTextChannels,0);
  assert.equal(summary.links.rustPatch.found,true);
  assert.equal(summary.links.rustPatch.ok,false);
  assert.equal(summary.links.nitradoPatch.found,false);
  assert.match(formatCloudyChannelAudit(summary),/rustPatch=permissions/);
  assert.match(formatCloudyChannelAudit(summary),/nitradoPatch=missing/);
  assert.match(formatCloudyChannelAudit(summary),/zorp=missing/);
});
test('missing member or channels safely produces unavailable summary',()=>{
  assert.equal(inspectCloudyChannelLinks(null,null),null);
  assert.match(formatCloudyChannelAudit(null),/not available/);
});
