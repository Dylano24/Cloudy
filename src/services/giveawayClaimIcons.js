// Cloudy's private giveaway claim icons: transparent 40x40 PNGs with
// white Lucide-style strokes. Application emojis render consistently in
// Discord mobile and desktop, unlike the colorful system emoji variants.
import { logger } from '../utils/logger.js';

const SOURCES = {
  gift: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAACKUlEQVR42u2YIXDbQBBFnzuZybGYRaxiFWtgoKFhWMPqMrEWBhYWBgY6qIaGhoKGMXOYoKDDFLQl687OVZLPljx2Z/Rnbnye27372l3vfWsgIpwzPnDmOHuCF3vYDoFbIAI2wBIoAn0j9R2qz1L32A0RCRk/RWQj/2IuIkmDXyIiiwq/jYg8hJwdQm4mzShF5K7C717XmjBtS3DiEXkUkVQjuvbWxsbvziOyVp9U97DE79sQXJqNxt6aE5EnL22RDlsOj2prfcdmfdmGYBmwydRL2SwwhS8m+gcRdOagrMFuKCJFRX0Vulbnlxlbd2gEc/OUUYPdjwqCaYN9bLKTN3Fo6oMOmAPfgUsgAx6AlwrbDHhXO3SeAXGF7Q3wy9jO9KwytA8mGv5dLaJLlNovY5/PwBMLDlgDH090s71qhMu6q25kyL0CuSE+NKMOV/r5VrNe6tjo2BKJgU86RsCiLsW2MU8Cr8Gj+vZyq2u5ZSXQWGVSXNNafNx6tewCfG60zhOvTv/C/xVH6nB5ooC9K9m8LsUFMFHDU5BLLbmqCNpIjoDf+n0FPAWk+KvOn1U1NyEFPuv8m7aWYh9F7Tzl3HWbmYeIhb7N9AR7gj3BnmAY3BHOdm0JlkYZJx2TdKpktuq7PPTt1gL4on8DMmDakdyaANfmjFoMdrxh3WrBqyOV2JvRhAfVYK7RWB2B3Er3zttE0E/hrlqMzYM11fY6QI7tTbDvg/8lwT8AMZEUK69kygAAAABJRU5ErkJggg==',
  info: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAACQElEQVR42u1YLY/bQBB9F1U6s4Y1rAsNDcMu0NDwoGFgf8r9hIOGBwPDetDHDF12ZTmWolcyqaajtZNd23EqdaSR1sp+vMzM7ryZO5K4ZVngxuXTgLUZgBzAGkAKwAG4l99+AWgBNABeAewA1FGnkAzRhOSWZM1wqWVtEnLmXUAMFgCeAHz1/PZTLHaQ76VY9bNn7g8A3wC8jGXBJcnKY5E9yZKk61nrZM7es76SvXvPPwfOkWzMxi8k08DQAMlM1lq3u1iAjmSrNnsnmUcAs1rIXidp+0D2ubUJ+aeB6sxFq7vc3bVBdcnigWqNUF0KsDBudROA05bU7i7OAUxM3OUTgvMZpLXvpJ28Nbc11BrtuaDvUH27yz6AOnCzAZZ4DFybmpj3AszUpF2EqxKST6JJxPq9zziaLORqXEWk9aOksFipADzIeHMiF5purdV4PwOz2qnxxscHU5P4ry0tgA+D5S+ATk2MlbXxRKg0BssfgIkim4cB4L6LxoI8nX0vmEal/GnHeJSa5Cg0/UQ255KlKhmO1oKt9f8Mktp7sPAE6JeZQDpVIjQ+gK++d+iKkvve4UXHQ1nOAPDRh0UDrAG8yfhB6t5rSabS3Jt28T9HtyxhLW6NsM5B+Q8hlH/Oouk5tOzU7LqZoOxshpSdXYV7MVLMHUzcrYa0PmpP6yMbsfWxGtKbGaN5tO1oHj1fEttjtd8+JMG/y/fK5NZJ22/2nSwHNDDLKRuYvvS0Ee1rAe8ltzYxhwwB+L/LDwC/Abu7T9Zbr5cAAAAAAElFTkSuQmCC',
  key: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAACJUlEQVR42u1YK1DDQBB9MMw0jjgqIyMjkUhkHZVIZCUSiaxEVhaHrCyuEllcZGXqinoItsPOklyvyaWJYGdukvtk7+X23u7enZFEn+UcPZe+AMwA5FIS3XHRE3BLAJcG7I+Q7LJkJAv+ypJkpMd0DW5jwMV2XFfgRiR3h8CRxFkHbiYDsAIwkPoWQApg0wcWZwAWChyEHHMAUekXHe65jxKCdLYHqwhxkCh9IIR1NYtTAswMuILk0MMfpqcAaM1X6YzV+BXJ2SlWsBYhmvjBawC3EshjAIXEy4X4tDJXciX1dwAj+basvXDOfOAPHkjmdEtO8t4zfDkJUVaqOoayH44RXzNWEsIXYFKyuefiLlKZNCU5lnYeQQQnIXwAxiTXaqK1KDtEiNzDldQqtmFqTBZ7KhqaVX9uA2CinGqdVUjU3tpJvTFAnc2MVZbxXJX+OCQHMJX3gbiQ5qLQLpWJ6u6hxBAl6Aqm8vyssXp6FT+NvmDHzr2H3zTUuTH6ggH8kmfUUGdk9AUDuP/zpKHOJJAl/gBcKdNkNfVdK9OuQgN8U++PNfVNKvQFcTORCVmjGqm9znCiNkLd2MTUG09FNyZDGbcVi0HyRU20I/nkiMmxxF197ngJmZ2XZdQRgBmAO9W2lWz4QzLgWIh0q26lAOAVwD2AXbCjvgP9ozGbSwqSkzbONz5p1NSR9ufSP2zrdHjM5VFacmhat32Z08Xt1v8l+knlGw6bv1pIgp9UAAAAAElFTkSuQmCC',
  clock: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAACfklEQVR42u1YoXLbQBB98XQmYjU060GziFUwUGWChYKGhoX5hMDClBk6qClzmcsEBVWWMoe56JWsOtf1SdZJJzmgO7MzJ/v29unutPt2r0jiNcsMr1zeDLCNAaQAEgBLAAbAtfz3G0AFoASwB/AEoOjlhaSPRiRXJAv6SyG2kY/PK487mAG4B/DO8d8v2bGDPM9lV9865v4EsAawDbWDc5Ibx47sSOYkTYutkTk7h/1G1m71fw6cIVmqhbckl55XAyRjsdXHbvoCNCQra7FnkmkPYFozWauWqg1k27GWPm8qmoh2OZlCrT/3AbjpYuwAV0vS8W6X6k52ApipYzUdjy637PKONkYdd6bn6EwSSSipJZfwMZZUAFbW871gaEx1uRXnHiUDjC1b8QXx/bENoP02dxOm3E/WeN0EMAZwI+NvvXNnPykBfJfxjWA5AZha480FiIvt89YFMLHGuwsAfDoHcKkS/9RSAXhRWP4BaKyJl5JSYfkLMLLI5iGAo7W6012l9n1dx8PZCG9ff4lfhU2nQxatAR6Fptdks4/sAXwA8MP67b0n0LlVMhw1YS2t/DuUUqUk9w6Suj1jd5B5pYss2GTSBADpAno8QxxOXmSmjugkDgWIbYkc/RfJ9U2SOuOwouR2vYGJ1a5blk180Ga58YTgYkWQG/ng5wuxmTvFCRvLzkgVStkEu5epAioai/L3UWOFFueGhCyafFUXTQ++Zaf9wZSBd9I4ytp5iMI9C3TnDureLYa0PgpHuooDtj4WQ3ozIZpHq4bm0UOXux2q/fYiRPdZnhdCOidpv+k4mQ9oYOZjNjBdLeBb0bYW8E5IQ9nHyRCA/7v8APAHR9Thin0XDWgAAAAASUVORK5CYII=',
};

export const DEFAULT_CLAIM_ICONS = Object.freeze({
  gift: '⊞', info: 'ⓘ', key: '⚿', clock: '◷',
});

let cachedIcons = null;
let pendingIcons = null;

// The application-emoji upload path follows the same pattern as
// termsIconService, and runs once per process (not per winner).
export async function getGiveawayClaimIcons(client) {
  if (cachedIcons) return cachedIcons;
  if (pendingIcons) return pendingIcons;
  if (!client?.application?.emojis && typeof client?.fetchApplication !== 'function') {
    return DEFAULT_CLAIM_ICONS;
  }

  pendingIcons = (async () => {
    const icons = { ...DEFAULT_CLAIM_ICONS };
    try {
      const app = client.application?.emojis ? client.application : await client.fetchApplication();
      const collection = await app.emojis.fetch();
      for (const [kind, png] of Object.entries(SOURCES)) {
        const name = 'cloudy_claim_' + kind + '_white';
        try {
          let emoji = collection.find(entry => entry.name === name);
          if (!emoji) {
            emoji = await app.emojis.create({
              name,
              attachment: Buffer.from(png, 'base64'),
            });
          }
          if (emoji?.id) icons[kind] = '<:' + name + ':' + emoji.id + '>';
        } catch (error) {
          logger.warn('Could not create white claim icon ' + name, error);
        }
      }
    } catch (error) {
      logger.warn('Could not fetch application claim icons', error);
    }
    cachedIcons = Object.freeze(icons);
    return cachedIcons;
  })().finally(() => { pendingIcons = null; });

  return pendingIcons;
}
