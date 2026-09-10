import fs from 'node:fs';

const path = 'src/services/ticketUiService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

const replacements = [
  {
    label: 'Ticket claimed initial color',
    green: "        title: 'Ticket claimed',\n        description: `${claimerMention} has claimed this ticket.`,\n        color: '#2ecc71',",
    white: "        title: 'Ticket claimed',\n        description: `${claimerMention} has claimed this ticket.`,\n        color: '#FFFFFF',",
  },
  {
    label: 'Ticket unclaimed initial color',
    green: "        title: 'Ticket unclaimed',\n        description: `${unclaimerMention} has unclaimed this ticket.`,\n        color: '#2ecc71',",
    white: "        title: 'Ticket unclaimed',\n        description: `${unclaimerMention} has unclaimed this ticket.`,\n        color: '#FFFFFF',",
  },
];

for (const { label, green, white } of replacements) {
  if (text.includes(green)) {
    text = text.replace(green, white);
  } else if (!text.includes(white)) {
    console.error(`[TICKET_STATUS_NO_FLICKER] marker not found (${label})`);
    process.exit(1);
  }
}

if (text !== before) fs.writeFileSync(path, text, 'utf8');
console.log(`[TICKET_STATUS_NO_FLICKER] ${text === before ? 'already current' : 'patched initial status colors to final white'}`);
