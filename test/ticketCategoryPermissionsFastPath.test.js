import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { categoryAlreadyGrantsTicketStaffAccess } from '../src/services/ticketReliabilityService.js';

const view = PermissionFlagsBits.ViewChannel;
const history = PermissionFlagsBits.ReadMessageHistory;

function category(allow = [], deny = []) {
  return {
    type: ChannelType.GuildCategory,
    permissionOverwrites: {
      cache: new Collection([['staff-role', {
        allow: new PermissionsBitField(allow),
        deny: new PermissionsBitField(deny),
      }]]),
    },
  };
}

test('ticket creation avoids writing an already correct explicit staff overwrite', () => {
  assert.equal(categoryAlreadyGrantsTicketStaffAccess(
    category([view, history]), 'staff-role',
  ), true);
});

test('ticket creation still repairs absent, partial and explicitly denied staff access', () => {
  assert.equal(categoryAlreadyGrantsTicketStaffAccess(
    { permissionOverwrites: { cache: new Collection() } }, 'staff-role',
  ), false);
  assert.equal(categoryAlreadyGrantsTicketStaffAccess(
    category([view]), 'staff-role',
  ), false);
  assert.equal(categoryAlreadyGrantsTicketStaffAccess(
    category([view, history], [history]), 'staff-role',
  ), false);
});
