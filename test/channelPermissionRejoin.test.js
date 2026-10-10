import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { repairGuild } from '../src/events/cloudySelfReadPermissionsReady.js';

const GUILD_ID = '1532882647838228723';

function fixture({allowRepair=true,legacy=true}={}) {
  const edits=[];
  const channel=(id,name)=>{
    const allowed=new Set(allowRepair?[PermissionFlagsBits.ManageRoles]:[]);
    return {
      id,name,type:ChannelType.GuildText,
      isTextBased(){return true;},
      permissionsFor(){
        return {has(bit){return allowed.has(bit);}};
      },
      permissionOverwrites:{
        async edit(memberId,overwrites){
          edits.push({id,memberId,overwrites});
          for(const [key,ok] of Object.entries(overwrites)){
            if(ok)allowed.add(PermissionFlagsBits[key]);
          }
        }
      }
    };
  };
  const rust=channel(legacy?'1533886914459861103':'1666111111111111111','📰｜patch-notes');
  const nitrado=channel(legacy?'1539397467647377530':'1666222222222222222','🛰️｜nitrado-patch-notes');
  const general=channel('1666333333333333333','💬｜general');
  const cache=new Map([rust,nitrado,general].map(x=>[x.id,x]));
  const guild={
    id:GUILD_ID,
    members:{me:{id:'1555999999999999999'}},
    channels:{cache,async fetch(id){return id?cache.get(id)||null:cache;}}
  };
  const client={
    guilds:{cache:new Map([[GUILD_ID,guild]]),async fetch(){return guild;}},
    channels:{cache:new Map(),async fetch(id){return cache.get(id)||null;}}
  };
  return {client,edits,rust,nitrado,general};
}

test('rejoin restores read, send and embeds only in the two original patch channels',async()=>{
  const a=fixture();
  const summary=await repairGuild(a.client);
  assert.equal(summary.missingPatchChannels,0);
  assert.equal(summary.repaired,3);
  const byId=id=>a.edits.find(edit=>edit.id===id)?.overwrites;
  for(const channel of [a.rust,a.nitrado]){
    assert.deepEqual(byId(channel.id),{
      ViewChannel:true,ReadMessageHistory:true,SendMessages:true,EmbedLinks:true
    });
  }
  assert.deepEqual(byId(a.general.id),{ViewChannel:true,ReadMessageHistory:true});
  assert.equal((await repairGuild(a.client)).repaired,0,'recovery is idempotent');
  assert.equal(a.edits.length,3);
});

test('rejoin finds existing renamed-ID patch channels by decorated names without creating channels',async()=>{
  const a=fixture({legacy:false});
  const summary=await repairGuild(a.client);
  assert.equal(summary.missingPatchChannels,0);
  assert.equal(summary.repaired,3);
  assert.ok(a.edits.find(x=>x.id===a.rust.id)?.overwrites.EmbedLinks);
  assert.ok(a.edits.find(x=>x.id===a.nitrado.id)?.overwrites.SendMessages);
});

test('no Manage Roles: Cloudy leaves existing overwrites untouched and exposes the missing access',async()=>{
  const a=fixture({allowRepair:false});
  const summary=await repairGuild(a.client);
  assert.equal(summary.missingPatchChannels,0);
  assert.equal(summary.repaired,0);
  assert.equal(a.edits.length,0);
});

test('GuildCreate and ClientReady share one in-flight permission repair',async()=>{
  const a=fixture();
  const [first,second]=await Promise.all([repairGuild(a.client),repairGuild(a.client)]);
  assert.deepEqual(first,second);
  assert.equal(a.edits.length,3);
});
