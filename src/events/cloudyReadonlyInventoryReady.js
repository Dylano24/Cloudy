import { Events } from 'discord.js';
import { main } from '../../scripts/cloudy-readonly-inventory.mjs';

// Temporary read-only inventory, approved 2026-09-29. Remove after collection.
export default {
  name: Events.ClientReady,
  once: true,
  execute() {
    if (Date.now() > Date.parse('2026-09-29T18:00:00Z')) return;
    void main().catch(() => {
      console.log(JSON.stringify({ inventory: 'cloudy-v1', kind: 'failed', data: { code: 'INVENTORY_INCOMPLETE' } }));
    });
  },
};
