import { AttachmentBuilder } from 'discord.js';

const escapeXml = value => String(value || '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));
const isRed = suit => suit === '♡' || suit === '♢';

function cardSvg(card, x, y) {
  if (!card) {
    return `<rect x="${x}" y="${y}" width="92" height="126" rx="12" fill="#173d70" stroke="#78b9ff" stroke-width="3"/><path d="M${x + 18} ${y + 20}h56v86H${x + 18}z" fill="none" stroke="#78b9ff" stroke-width="2"/><text x="${x + 46}" y="${y + 78}" text-anchor="middle" font-size="34" fill="#fff">?</text>`;
  }
  const color = isRed(card.suit) ? '#d93650' : '#1d2430';
  return `<rect x="${x}" y="${y}" width="92" height="126" rx="12" fill="#fff" stroke="#d9dde4" stroke-width="3"/><text x="${x + 13}" y="${y + 34}" font-size="28" font-weight="700" fill="${color}">${escapeXml(card.rank)}</text><text x="${x + 13}" y="${y + 58}" font-size="23" fill="${color}">${escapeXml(card.suit)}</text><text x="${x + 46}" y="${y + 88}" text-anchor="middle" font-size="46" fill="${color}">${escapeXml(card.suit)}</text><text x="${x + 79}" y="${y + 115}" text-anchor="end" font-size="22" fill="${color}">${escapeXml(card.rank)}</text>`;
}

/** Creates a small, self-contained card table image for a Discord embed. */
export function createCardVisual({ filename, rows }) {
  const body = rows.map((row, rowIndex) => {
    const y = 46 + rowIndex * 145;
    const cards = row.cards.map((card, index) => cardSvg(card, 165 + index * 105, y)).join('');
    return `<text x="22" y="${y + 58}" font-size="24" font-weight="700" fill="#f4f6fb">${escapeXml(row.label)}</text>${cards}`;
  }).join('');
  const height = Math.max(180, rows.length * 145 + 26);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${height}" viewBox="0 0 760 ${height}"><rect width="100%" height="100%" rx="18" fill="#171a21"/>${body}</svg>`;
  return new AttachmentBuilder(Buffer.from(svg), { name: filename });
}
