// Cloudy's private giveaway claim icons: transparent 40x40 PNGs with
// white Lucide-style strokes. Application emojis render consistently in
// Discord mobile and desktop, unlike the colorful system emoji variants.
import { logger } from '../utils/logger.js';

const SOURCES = {
  gift: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAADMklEQVR42u2YvYtdRRiHn/fuJhpdxNavDSZxRQutRIxFRAjpBRcrezubqAhCwEJB8KPxD9BOm00TwRBLwUoRNIXGuGSXTZPKzSru3vNY+A6Mh3vu90qK+4PLzJnzm3feeb9mzoUFFlhgKGKaSWov5xoRzby4M0ONXPA/CrTHusZzLA7FgmpEhNk/BTwAbEXE9bJ4sVCrfwJ4CNiJiF/bsuZluV62q+pF9bb/4g/1C3W1bTX1uPplcsw5G+ojtcx5uTXU+9WrDsbv6lo153F1s4P7c8qKSd3dpeBytm/nAvvqh+oZ9RO1qRa+S7272kijfpzcj3Ku6lu17Jndm7u9rPbVK633b1TWeU99v3o+3+J+kzK+TplL81DwSLZf5aKXBnA+T2sd5K9RPxvAu1TLKLKHYXmMzN1X7wO2cvis+iZwBVgC+sAGsA6UBfeBDfUZoAc0wIvA2Xy/pa5ExO7UGV1l46vqdmbhfrqojYMqvkqcHgzg9fPdbfWGuj4qo6NLuYho1IeBa8DRQ6r9fwInI2Knrp3juLgo/mgq1wDvAlfTrQHck+6LdPNjQEmKD4BfkmvO38t+H3gCeAc4BpwEdiY6dkt2qc9XZWRtxJy1ypWnxuQ26ul6zYmSpLKWwLk8BZq0Qs3pA09VY+fUB6t3NbcHPJkyI8eYNgaPZwwucXg4ERHXu2JwYPakcr2I2AReB3arWJoVTcraA84PU27kbabUqLTkReBp4DJwIa3a5Cb7+e7TnPoa8OMAzoWshT8AL6VyQ+vg0BhM5ZYjYlO9lcM3I+LbAZv5q3r8LiK+H8C5md1bqdxyRBxMfZIUl2QhLdwjmXElAUq7Us1Z6eCUk2Y5ZY4MmbHuZBkfxQ1GRB/ot9p6saaDU8sYK5573OG44xWc6sJY4kulauvN9jo4h6pgOVGixFWO91Pp3Yq728HpVSfI3BQswraz/4L6CnAjn6OqgwXPqseqy4LAKnAm+duzfJd33QtPOxr9jvtiG8/N+8uuKLmu/ub0uKa+PIlyk3y4lwvEvXkbOdqKJ6uQOWiNB/A38FNE7A07e2e15NL/LSOmWCBmqJ/NXP/yWGCBBeAfEjLF3+TE+3sAAAAASUVORK5CYII=',
  info: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAADE0lEQVR42u2Y30pVQRTGvzlH66I0jtqN+C+htCizDLLbRLuIguodFN9BfYeyXqCiniEhia7rtkjLyFK6qASPhifi/Lpo7Rh2e87frSKcgWEv9p751jdrz59vjdQojbK/xdULADhJmQQsJBWdc+zLyIAskE2rXWoRBDKSiCIDtEo6LemEpA5r9k3SR0lvnXObXqSdc664q1Hz7GvAI2CVcPkEPAYmkjB2hRxwAVhIILMDfLe6k/B9Abi4KyQ9ctPAT8/pKvAAuAUMAh1WB4GbwLxFMSrbwHSqJD1yc56jPDADtFfQv83abnr9Z1Mh6ZGb8sCXgBGvTZOt1EysZoEmr90IsOzhTNVF0iM3BBQM9D3QZe+bbWX6+2GiDTSb3WUYGOZQzSRtOxGwaIBbwPkoaoE+OSAX+BaRHDYsgEXfVy3RG/N+yYzvKGEgPbZoPgO9SY49krMe7ljVUfQIPgWKwBeg1eaWCxA84zk9GyDoDKMVWLO2T6oiGBEwkHUDuVsKxOszClyJz8PA4O8Z9pqdRsE+IYBRix7AdRt9ttzAyjmy1e2AG4ZdBC6HApApcT73m12QtGRnLyFyzjmAU8BJs0Mko3P8naRf5qM/pA1KrZ42e25L2vAk1H+r3Qj1SXol6TXQZ++S8COMDUlbMV+qhmC1iqhXUovVnrT0ZimCP+x5RFKuAoe/LTqYXW5AOUlHY74qIhj9ghWzD0saiPRcGcd+DbYzrAFJh8zHSmgKJRGMBOUbSV/NHq9AumN9i6HF9I/hX6xII66bL993mKBN7qwp4Rfm7I7tVaVWZ5PhZcwObUUAxyTdttcvnXN580m1J8lYgkQKHXWddtStAp1ljjpful2tSTAExMJwEsk6xMLzmsRCCbn1AeiuQ251G0aUIpxLSxNOer9kuUbBeikmWCfTVtWzMck/B3RU0L/d+uYTpFvqecmUJT6hpOm41Shpuh9LS7frlvoVpp3PEtLKgpd2FvY07Qwk7hPAw1haGUrcx2tN3NO4+mixq49+Se0JVx/5Pbv6OBCXRwfm+q1RGiWl8geq7A3iU7EumwAAAABJRU5ErkJggg==',
  key: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAADN0lEQVR42u2YP2hUQRDGv8m7RCUaNUaUKCISFf8EBE0hWIiNNhYpBC1MpSAIinZiZWmliIq9ib2IKKJgISgqSBAbISoq+BcTJTHRJPezmYXl8d7lcrm7WGTgeI+93Z1vZmd2vnnSnMzJ7IrVYlOgwfeO90dS0cyYNWuBBiCZYk4CWN09CCRmNunvqyTtkNQhab6kH5JeSnpuZmPBGDMr1stziT+3AteB72TLa+As0Byvqxe4Y8BwCtBX4D3wKzXeD3RG8VpzcKcj5cPAJWAXsAxYBKwBDgD3UuC31AxkBG53pHQA6Jpi3Ulg3Oe/Apo9uawWGdsIvACKwDdgvf/XGLLVfwlQiIw6ERl1xscKtfDe3kjRsQCuxDoLQIAHwCTwBlgQjKkWwKDksnvvY95R+Vh7iDP3pAHdkXG78rK60uAM99dmv0ufmdmIJAuVIgK6UtIdSSsCZp/zTNKwj3Xm3csVAYwu2BZ/fnJAFs0JJe2zpH2SvqSMG5I06O+teboKFR5xAPPXh5rNDIAcYz5lbDNP0gJ/H83TVekRF1zxgJOAbUCTpGJWoKfGGjweN0ha5mMDEaGoWoJ0AR88yH8BSzLAZK1v9OcVXzsErCxn7XTBxfX2cOr6sYxsNveygO3AiK/trUpdzgFXBHrichWXLb+gk1g5sAl46+tHgY0OvqGW4JpiIMDStEeAVuC4V5wgR2bsvXLApeYfdiLQD/QB14CbUbziFeRUPcA1Rt7ZD5xz5aXkMbCnGuCSMo7VgA5nMbF8AW4Aj4CnwH3gIrA3vf9Mmp6QbXng5nncXY0C/qeTgM5yjK8UXKBIi4F3Ucz0ZLEVoNf/fwKszmqOnDAUptswTRV3Bx3cOHA0TghgnbPmG95nTAAPI2BVY8ilanG7l54hSX1+LJNAm6QHktam5t8K/XDo7moNcNIJAV57f7uHdjq4MUn9kkYk3ZZ0wcnBRDWZeymAiVMjk9QafS1oiyjTITN7W8uusRTAQWc7CyU9j5hGEjGhPw48MbPxejXhIYuXekOUJ+fr0XxbHkgnoC2SuiUtj2LSJL0ys7vhypiVD0Jl8DqrB45yQGQdIdW8SuZkTv5n+QcqU5IN+R1nUAAAAABJRU5ErkJggg==',
  clock: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAADLUlEQVR42u2YTW9NURSG33VvO0KlSlIJAx21vqsSEh9NiJogMfILaMTAWKJ+gJlgIkYIIz9AhTG/QBShDUZoqErr4z4m68jKyb6n596eEklXsnPO2Xftd71n3X3Wx5aWZVn+rdhiAQCTVEtgIalhZvyTNwPqQL0qvco8CNQkkXkG6JI0IGmTpLWu9kHSa0nPzOxL8LSZWWNJvRbujwK3gSmayyRwBxhJYSwJOWAQGE+QmQM++phL/D4O7FoSkoHcWeBbMDoFXAdOAv1Ar49+4ARw1b2YySxwtlKSgdylYGgGuAj0lFi/xnW/hPVjlZAM5EYD+AQwFHQ6wjjn489c0BsCXgSc0UWRDOS2A/MO+hLY4POdgOX2ZiaDIcQY0OnPGxwDx9zeNkkPJwIeO+BXYEfmtcSLHAR++jiQ+OozkjsdC+BxtNWO9w4Hr1yMhhK6+4PuvpRnAsmxoHu4ZS8Go/eABvAW6AJqHnDbJWiO0QW8c927RQRrqdxqZr88Qwx7trnvGcEWk1t9rTnWfZ8eBrrcpi1IMMxtltTr9+OpxQVSL9pXjvXQH9d7qkzyqRXk5z6/n5c04W9f5L34+2fPuSmiWR5/Lum72+hrVhsUfT1r/DoraTqQaCYdbuCHpAvAVjP7bmaN3P7KMKYlfc3ZUisES39Tfp2U9FlSp6RTkp4AN4AtZvarXfAigp/8ukJSd7O/wD1kZvZG0h5JN93rKySdlvQUuJwF9oDRLWllzlZLIWavhxiAYzFrFGz87H6Le28mhJ58Bjru8w1gT+lYmBnyWPXeQa6UAfAYF7PHgFc057MYmmUhn8dj7Kr8S5b14t2FAnUZoolAvbpsoG4l1Y2lUl0Joh0BrzNRuh1qq2BoUizsbJXkAsXCo7aKhYJy6xWwMW72Mns6kNvoGFmLsK2qmvBM+EteJArWevgIsn1Wz5Vlu3MF65mqq+qxXMl/CVhbYn2Pr51JlG6V9yWj3vg0a5rW+ciapmu5tnR20aV+ybbzQaKtnA9t5/xfbTubNO4jwK1cW9mscT/SbuNexdHHKq/n+iT1JI4+Zv7a0cd/cXj03xy/LcuyVCS/AZuQXVqLG17ZAAAAAElFTkSuQmCC',
  // Tiny white outline icons matched to the approved claim preview.
  // The exact white outline star, scaled inside its 40px emoji canvas so its
  // visible stroke matches the key and clock in Discord's line-height.
  star: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAC8ElEQVR42u2Yz2udRRSGn5O0VCw09pe0i1YMggsXEhdSKIIo2k02UpBgBQloUbpV0FVBxX+hf0E37t20IkipUAiC1I00JVbBEKG0ukitzb2Pi7wXh0sS0tzcNot7YDh3zpw5c773OzPvfBdGMpKRjAS1og+0/Z2S3Fj0rPqjOtvaHztyaQfVRVdlMf3ajiQHDTBeVQIfAEeA5eizsddOQO+welPtBsFu+od7Po8LwQpK7wKTwN/AhehJ4MwjQbFXS2njze9SJ9SFoPZt/C+nv5Dxdedv2w7dYPxj/5dTsZ1qXvcng8RnM/CrTwL7054Gnkt7HjgJHAQuAdNAJ2XzDfAmcBu4CvwCzKf9CdwB7lTV8qAInlOvpOg7ri1ddTr+e6KnGxT7pZN4V9RzW0ZQnQB+Ap6JqQPcBf6JXgQWgO+ArwGrytRWAW8DrwHPAkeBp4AnoscT8xbwYlX9tVUEZ9UHQeNeau5ID6mHiLNHPZr59xLvQY91BqWw9xNMdV59OfbdvV253vyM707/JfVG4qyoZweixJaq1HfU+wm+pJ7c5C4fjz6h/pH5/6rvNQ9Rg26U3iIzCa56V319o5tLc8N5Vb3dJHemjbtdh/Wu6NPNYjfVQ2sh2SB/KH5m3ultT24NJL9Mkd9Sj7evqtWxH49fV/1iK8k9TIF2E3x/jpGlqvotyYxVlVXVDf+Oxf47sBT/A5nfHUqCSaADTMX0a5KoqlpR96ovqHuraiVJVc5KgKmq6uQBhnObCe1Npnu9qrqrZmeAy8B14FL6Zvzn+E9m/lCv9VPqcor+LfUV9ft1KO2q+kb8zLypoXwO9B01Pf6d6+PnOfUr9Yc+3p1reHlmKLu4YYPzWfR+k8QN9aPmyJlQP2xYw/h31PNtvGGcgxebRefVT9V9/Q+S3/vUz+LXk4ttvGHU4LR6Tf1cPdaWQONT7StUj8X/WnMtG94naUtt6q6NqK5F6pF8zDf8OrZZFFrfHfWPw0hGMpKRrMp/vnMUY5pCkLYAAAAASUVORK5CYII=',
  check: 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAABmJLR0QA/wD/AP+gvaeTAAAAyElEQVRYhe3XsQ6CMBRG4S7EhXdjdTDwPPouOLn7Vkya41Aaq7kk1Qi3Mf9JWOmXpr2EEJRSSrkFNMARuAKdt+elGTfybAJab1cIwcTVA1zA3YGDty3hzgZu8LYJJ9x/4YCOON1PQPMlzholP8G1xKGZGj9BropbABYjV8dlC/Xzi4uRm+GyBffA7W3BC7BbwG1/W0uQbrgSpDsuQw7YZ3K7M1eAtHayDlyGtHayDlzKQNaDSxHn5DQ/vbfHjPjF8f+HUEop5dsDvxrrbncy0K8AAAAASUVORK5CYII=',
};

export const DEFAULT_CLAIM_ICONS = Object.freeze({
  gift: '⊞', info: 'ⓘ', key: '⚿', clock: '◷',
  // Do not substitute Discord's system star for Cloudy's outline artwork.
  star: '', check: '',
});

let cachedIcons = null;
let pendingIcons = null;

// Synchronous reader for the existing Giveaway builder preview.
export function currentGiveawayClaimIcons() {
  return cachedIcons || DEFAULT_CLAIM_ICONS;
}

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
        const name = 'cloudy_claim_' + kind + (kind === 'star' ? '_white_sm3' : '_white_sm2');
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
