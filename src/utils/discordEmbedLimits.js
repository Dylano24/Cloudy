export const DISCORD_EMBED_TOTAL_TEXT_LIMIT = 6000;

function embedData(embed) {
  if (typeof embed?.toJSON === 'function') return embed.toJSON();
  return embed && typeof embed === 'object' ? embed : {};
}

function textLength(value) {
  return typeof value === 'string' ? value.length : 0;
}

export function getEmbedTextLength(embed) {
  const data = embedData(embed);
  const fieldLength = Array.isArray(data.fields)
    ? data.fields.reduce((total, field) =>
      total + textLength(field?.name) + textLength(field?.value), 0)
    : 0;

  return textLength(data.title)
    + textLength(data.description)
    + textLength(data.footer?.text)
    + textLength(data.author?.name)
    + fieldLength;
}

export function getEmbedsTextLength(embeds) {
  return Array.isArray(embeds)
    ? embeds.reduce((total, embed) => total + getEmbedTextLength(embed), 0)
    : 0;
}

export function fitEmbedToTextBudget(embed, maxTextLength) {
  const source = embedData(embed);
  const data = structuredClone(source);
  const budget = Math.max(0, Math.floor(Number(maxTextLength) || 0));
  let overflow = Math.max(0, getEmbedTextLength(data) - budget);

  const reduceText = (owner, key, minimumLength = 0) => {
    if (!owner || overflow <= 0) return;
    const current = typeof owner[key] === 'string' ? owner[key] : '';
    if (!current) return;

    const nextLength = Math.max(minimumLength, current.length - overflow);
    overflow -= current.length - nextLength;
    if (nextLength > 0) owner[key] = current.slice(0, nextLength);
    else delete owner[key];
  };

  // This is used for private previews. Keep their identity and structured
  // fields visible for as long as possible, shortening free-form text first.
  reduceText(data, 'description');

  if (overflow > 0 && data.footer) {
    reduceText(data.footer, 'text');
    if (!data.footer.text) delete data.footer;
  }

  if (overflow > 0 && Array.isArray(data.fields)) {
    for (let index = data.fields.length - 1; index >= 0 && overflow > 0; index -= 1) {
      const field = data.fields[index];
      reduceText(field, 'value', 1);
      reduceText(field, 'name', 1);
      if (overflow > 0) {
        overflow -= textLength(field.name) + textLength(field.value);
        data.fields.splice(index, 1);
      }
    }
    if (!data.fields.length) delete data.fields;
  }

  if (overflow > 0 && data.author) {
    reduceText(data.author, 'name');
    if (!data.author.name) delete data.author;
  }
  reduceText(data, 'title');

  return data;
}
