import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { rememberMessageDeleter, resolveMessageDeleter, isBotActionFeedback } from '../src/services/deletionAttributionService.js';
import { messageLogDestination, messageLogAuthorType, CLOUDY_GUILD_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

test('explicit staff and AutoMod deletion intents identify the real actor',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const message={id:'deletion-intent',guild:{id:'attribution-guild'}};
  rememberMessageDeleter(message,{id:'staff'});
  assert.deepEqual(await resolveMessageDeleter(message),{id:'staff',label:'<@staff>',source:'staff'});
  rememberMessageDeleter(message,{id:'bot'},'automod');
  assert.deepEqual(await resolveMessageDeleter(message),{id:'bot',label:'AutoMod',source:'automod'});
});

test('audit attribution matches channel and author and refuses ambiguous executors',async()=>{
  const entry={id:'audit-delete',executor:{id:'staff'},target:{id:'member'},createdTimestamp:Date.now(),extra:{channel:{id:'channel'},count:1}};
  const entries=new Collection([['one',entry]]);
  const message={id:'audit-message',channelId:'channel',author:{id:'member'},guild:{id:'audit-guild',fetchAuditLogs:async()=>({entries})}};
  assert.equal((await resolveMessageDeleter(message)).id,'staff');
  assert.equal((await resolveMessageDeleter({...message,id:'another'})).label,'Unknown');
  entries.set('two',{...entry,id:'other-entry',executor:{id:'another-staff'}});
  assert.equal((await resolveMessageDeleter(message)).label,'Unknown');
});

test('staff deleting a member message routes to staff; author types are Staff/Bot/Member',()=>{
  const guild={id:CLOUDY_GUILD_ID,ownerId:'owner'}, member={id:'member',permissions:new PermissionsBitField()};
  const staff={id:'staff',permissions:new PermissionsBitField(PermissionFlagsBits.ManageMessages)};
  assert.equal(messageLogDestination(guild,'member',member,{},false,staff),OWNER_MOD_MESSAGE_LOG_ID);
  assert.deepEqual([messageLogAuthorType(guild,'owner',null),messageLogAuthorType(guild,'bot',null,{},true),messageLogAuthorType(guild,'member',member)],['Staff','Bot','Member']);
});

test('bot action acknowledgements are excluded while actual bot content is logged',()=>{
  const message={client:{user:{id:'cloudy'}},author:{id:'cloudy',bot:true},embeds:[{title:'Report submitted'}]};
  assert.equal(isBotActionFeedback(message),true);
  assert.equal(isBotActionFeedback({...message,embeds:[{title:'Rust update',description:'Actual published content'}]}),false);
  assert.equal(isBotActionFeedback({...message,author:{id:'other-bot',bot:true}}),false);
});
