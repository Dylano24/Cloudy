import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const STAFF_REVIEWS_CHANNEL_ID = '1533965979682476082';
export const COMMUNITY_REVIEWS_CHANNEL_ID = '1540625438601379961';
export const STAFF_REVIEW_MEMBER_ID = 'staff_review_member';
export const STAFF_REVIEW_RATING_ID = 'staff_review_rating';
export const STAFF_REVIEW_MODAL_ID = 'staff_review_modal';
export const STAFF_REVIEW_LOGO_NAME = 'cloudy-c-logo.png';
export const STAFF_REVIEW_LOGO_PATH = join(MODULE_DIR, '../../assets/cloudy-c-logo.png');
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'cloudy_review_star_glow_v2';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';
const PENDING_REVIEW_TTL_MS = 15 * 60 * 1000;
const STAFF_REVIEW_STAR_GIF_BASE64 = 'R0lGODlhgACAAIIAAAAAAP/BB//OI/+qAP/OIwAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJCAAAACwAAAAAgACAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqVLggJiyhTwsmbGmTht6pyIs+fOnw17CgVKFGHPAT6LKhUoFGnSpUSPBnA6E2pUqVSrWt0pNcDUp1tfNvX6NWfYml29DiAA9uzKtGrbukXZk8AAsmrZmp2bEi7ZrDH59sVpF+9fuYJF+v2rV2vikXXvGj6893HIxXjXIra8EXPmzZwxRp5sGDDN0B49Z24sEzXH0aRLg3YtUbXsyrQt2l49O3dQwpJj33bsmyfO4MJ54y7uEHby4a2ZR9xN2rR0iM6fKyd+XSH12Na7L/8cq70668DiYQqVWbh89fXo3cKfPx+5+8/083NXrL//+vb3lXaefwR2RuCBMwEYoIAINnhaRQ4iSICCCzI2YIT0QYihfhNOaF+FFk64oX4UjZighwOkqKKKIFa34oodmrjfb/Oh+OKNL7aoY2Y49piiiPnVNpOPOxZppHY+AibkkEc26WSF4U133JNUVvnecs0d9aGVXOqY4lDGZdflmAtqBmaYwJGp5n1m9jbef1uuKWde8IkmFIVzytkmliWuF2eeXJoWnYFN/Qlok1+u9xF8eB6K6IXxpQano1TuySehYlLqJaQPQnanoZqWZ+mgJsEHaqjCCRrpSaaeiupfqnb/OtinryLJqViT1grerWjlqut2btJF6690nvmTqcTGulSrryZqbFGMutrlqKQu6yug1K4K1X+NkrkWpIINmye1ln1nZZSJmVsluuEmKO2653GWpqOWljulpuzKdy+l+Z41L7/xputuqPW2yySq/Vql7rTBAvUvvgHP9TDAlyq18JgJW7wvwg3rNHGL76YacVgfl7lWijsWTPLGUH7bYciTZewwywGOahfMlM0I7cAtc3ozlCNvy3PNnA7tnspCH8xmrH6GLLPHNKeaLX3dXqnzsUYnN3V/KNtaMdTsneqsourBCSrSOysN3tayMlXj2R2/FTVjGXpX359P46o2j3UzfkR1nHm79PGPfWfJLINX97r3VEW3/dDbMcctrNpjP4tmofglLvi+bGMamWSBy81k5ZLTiGzoKh1H+tcX0aci6ywdF6Sn9cEuOoms+qcx7rMWPvN8mwOfdOkg1bmytmA7nt7yzDfv/PPQRy/99NRXb/312Gev/fbcd+/99xAFBAAh+QQJCAAAACwAAAAAgACAAIIAAAD/wgf/ziP/qwD/ziMAAAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzZUIBLljBDupxJM6bNjDRzvrzJc6LOnD2DPvypU6jRhD8H/DzKlGDSpU2ZJg2gFGjUo1OrWr0aVOeAAGC1zuTaNSeBr2GhkrXpFWxYAkXXxtR51m3arXJX0kXrdgBcvHlPTrV7t2bglHsJv4172GRbxVT/Gm5MMjFkqowpi3x82W9mzR4tX8YMGDRH0Z0l7zQdOiff0Z5Ls76IGvbn2bRdjyYcezJui7Vhq179u2Jw27KLD+W8u+9wAcopHt8tlnj05TRfN3d++7rC6dSfe//HPlP79r7dxxsE37z3WPVOic6sex5y9fRS5euXT7++Yvf7BQhdZQIWyJ95/kVm4IL4RcTgg/MhmKCCED6YW4ULEtDfhHb59RyG+xkH4n4alrghhx2a+OGIyS3EoIowmjjAjDTWiKJ9NdYY444WOqhfiTkGKeSNRHYo5JEzmhiij+UdWeSTUG6HZHUSMRfllVjWd1+VVmbp5ZeF+UZek2CWieWMajFploRmtnkegO/59NOJbtYZHlHAEUWnnXxyh2eec7LZZ5twxgkoe4N+Wah1F64paKJRJvlnRwdCWuaiA35UqaVZYjrSppxC6SmBgYb65KglgWrqhKgKFuijqxr/uSJMqsaamnxs6Qmrqa3Sqqut9q2Y6U212torsb8CS2GaQum6q5uSMovVnHv26eGkV+lZbZ3XShuVts92qiG2a1Eb7pnjNvjtmpzCCRq7lgL4LryQuksZomba21iXg255r26h+nsYvoSKNzC98RocGL+JCpwXw/2qOy1N21qrcLkIt3sxWRA3LHGzAMfqMFcESynqxutSfC6OZ63MG8pNdSylh0AWOXLK5RHZbYQuh8lofiqjGO2rHOqLs0sV3xpg0v/BbJTM/2G617k3T5yzllIXi5yYViP9bNYkzvim0z3hO/SkYT9qdNcCqJ31QWG397Gv2d25JNw/it3Z3HplgtzX2wzFHSzfiPl9trdI5W3e2mXV/XKAchZbNU/MHU443s52eLmrji9LrogHojU5snWjebdGcY+ea5P3be5QgDS2uLpLrcuO+n5UAl2gYwvGvHvhAh79Oee4Zlv8XMcbzzXphsLn/PPQRy/99NRXb/312Gev/fbcd+/99+CHLz5KAQEAIfkECQgAAAAsAAAAAIAAgACCAAAA/8cH/84j/84j/68AAAAAAAAAAAAACP8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcuVCAy5cCWMr0CLOmy5k4L9rcmbOnxJ02fQptCJTn0KMHdxIwirQpAKBLmTodqjRA1JpTj+4cQMCq1Kw5bXINQPYqTLA+xXYtOyAoWpxqybJti/WtzLhyrdI9a3el2LF5Cex92ddvTcB59botbPLv2sSCFzMmiTex3sE3J1M+/Nhy5LqaQ1a2rBh06I+jSX/me7qjY9KBMcds7Zoz7NiYadeGifh2ada6ddr2LXc14eAYU98WLBu5xdfEizd3TlG5b+OZqUeEHl26ZO1Eh3f/924aPEPrxJl/N48QfXTss9knBdp7PNuioYvq31rf/u/9+6kE4ID69ecffAQmyFGCDPLXmX9zNSjhcRVNOOEABkKonoUNVshhghhi+CCEc2H4oYI/nchfiCxmSCJzLZqo4lfh7RfjjTESoOOOPJIIG49A4iikjACmuKKIQCaZpI9Meqbkkzq2qJ+RLkHZ5JVY2gelWfE9ZNOIWYYpppbrnfflmGimeR2NZn4JpppwXqkjUBPR92aceGopW3bbOZjnnxoSWZ6X9LkI6KER0lldoXci+ueGbPa5VaOOwokgn8JNSmmlYUaJ34KMcoonpGUmF6qoaZI66EZFiYjqmKoC/4faqa/KKeiqNLW6aa3L7UlhSbruymtxl3Z5UquGDiudr8aihKywr8b6q2F+KqvarbKy9Ky1kGE77UzbcnvZp1TZCe2oxU4VbrTeYorUupxK625ThSZraYiKvkWro/IyNim7kYLl3qPTTTZwnvDlx5u9caqq8EsMj5qbweKhmrC/FYt6cWGHRdzwrRRDfO7HuKqbscUF63uyximj1fHI905s18ool/wuzSyXejNvMKuW5cYCL9xzYILpaKvMQYssJ4yuNomdyjw7jaPRPgLt1ME/Sovkiy3TKzTXzAoQ4sgOJ+2Sx2XJ+/K5T2eFNbHtwpte1+VG3R2MF3K1q9VafaydntoEbn0dyCYrfR3gxhbYdK82w4XzZWE3+5TiVF+rs+N2Oxn3vATZmCHfaZ0cZeQOeV45edmGDtOIeE8JkemeXX7XmXCTviijnXHJObi0j+v6c5SvpbvkmK9uVbHferjt8Du/tOOAue73fOPUOg+9aADq3jyKIk3oNYHOct/39SmBf3WAs/9+fsDl5yvf+/DHL//89Ndv//3456///vz37///AAygAAdol4AAACH5BAkIAAAALAAAAACAAIAAggAAAP/OB//OI//OI/+1AP/OIwAAAAAAAAj/AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKBcKWJmy5cmVMGO6nOkxpk2ZNHNavMmTpc6fEXvyBEq0odCeRZMeFEoAqdKnApkKhfq0J4EATYdSLdpzwFUCA5xu/cnTa4CzYLWOzVnWLNoBYW2u1XkT7tWzWOGqnZuy7V28YOPi5NvXJly3gPXeJFw4pl28kAMvZmzSL+TEgmFSrmwY8WXJkzeHtHwZc2jRH+t6Lg1aLurUnf+WfpvZ52uOpGfTPn07o2rZulsP7n0xt+7drokXj338s+Lhyicaby5cc3SKqldTf279usTfzVlz/+/u3eH08HlrCygPETx65+rZm3f/3jRv+QW7aq9fnfzmowA6tt97/QV4H2cGJijggASOp6CBHT0oIXP1zRaYehNCuFOGEx4GXIW0OcghgBWN+OBhDFZ4IYYmitVei/qheFgBH4KIVgEyHgbjVEElmOOPQKJIo43HEYBjkEjKqGCPQiWZJAFQRiklkcFJKaWTSZL4UJMyWunll1SGydqXZEL5I4/zxVSmmGy2qWKZBybEU41u1mknf3sxZNWdfPZJnYt6lgWln4T2aSaggdJX6KJhFrgek52lyOikFuqYZ5qR0knpppixiF2MmnI66YVofgeqqKimx+KjJYIaaqp1mv8pom3LtSUprGKSimit2b2KK5G6Xurbqb/GaqmwGnF5a7HhBRvnRsr6ymxwxz6Lm6vTvlltciVFmy16znL7ErHfVjorqy15Wy58q9JF7rrhQjeTuuXG6x9b2E4ra7tKxbjsoivuSlSMQ+Jq5Lb39mtrwagePCtfC0tr6JEYMnYepwVSdvGmGWtMIaz9/adowyJ6LKDEhYZs8ccGO2gyTI8VqzJhI6c681w1g+wyxCz/evNYOdu8M849txwf0SfXO/RWQet8NNBFU4lykUtT1TR/Rg6aa9VVRa0tilOL9zRUVzcLpNbAcp1U2VU+GXZ61pLl9XYICwC2jT+vPXfb567U5OHUeQ+892cBB3g3f2oDxXaIq+Zr9th6J92svQaC/WrgckteZOEjHk415IrvzTmahtulKeb4ak543eJGdZTn8MXtUs37No7uUq+bLrbs6Rr24egC55d7zJGB7q7vkVEur0rDo50XsvPW9RfwvOOurFd3pVU9gjZ9pXzCL17/VfCz3xQl68t/mnuU0Jff/ZIRJphV68dPOFqGXUtIEv4Kw8+9hv0LUO8AmL9SDdCAZGtfY9KHnwY68IEQjKAEJ0jBClrwghjMoAY3yMEOevCDILxOQAAAIfkECQgAAAAsAAAAAIAAgACCAAAA/9YH/84j/84j/7wA/84jAAAAAAAACP8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQzIUQLKkAJEoUzo0yZKkypcwAbSc6TKmTY80c97cqTEnTZ5AK/rUGbToyqFEjSpFiDTp0qcChxIYCrWqVKpVl/ocQCAAgQFOswbNOYCr17Jhxd4kazbAWbAz1Y6dWbbtW7gt5fKkWbar27s/9drk2/ev269o8wqOSdju4bqBF6ds7NcwYMWSURIuUNkwYrwsM2tuWbez5wKJMYvGSbew5b+f467+2Nrx69iyZ2+k/Noy7tC6d7fm3NszZNXBLfIuDhs1aJPJMW42Xfw39OjKSbtmDvs4cuwPl3P/P+w8MniItYmP7576+vnwtalzJ1A+9/uRw+XP9+7+vkLx67H3XEnvNQVggF7VZ2B/QC3ooAClIXgbfw/6xFqFGEYo4WkUYmigUB5WWJd6GwoYYoUSnShiWSSWSF6HKmJ1VIxI1cWifgjS51x7NKaVUI9s2Xiji7cVsCOMQNaEn4NCNumkkEa2SGSCRj5ppZAYNmTglVzaGKWROJaoY5VdlvnhQjWW2WSUBLTp5ptT3vbmm1Gq6SRSSzZW2px88hnnn4f1KWibd1qI5kyDAqrooswNOpV9TNEUJqOUVuqbjwX5NKmlnCr6qHmR8tVmp6RSSqih/wW5aamsNoqkkqke/9jqrPvxCFye2m1H664TvnqSlltpyOuwdw14K6652kYsq58ZyyCyLNk46rKlEurrrxEN5eWq1LpIn40yphjskN2aemS4E6U5gJTlTvmtrd+lq62w7RLZLJ49zatrvRLei25G+nLFLb/WwvuscEGuO3C57xpMoEgBs8svh9eqpK7EEzeMr8UBL7yrv6i+pK6y7YKM6WTjCkywyZCuNS6YJZPp7MNF6QsztTpWrNXLGDMr8781B3nzsDk7jC1UQnts7qt6Tdftu6CK5TTOCh6r1tTLQt1yVvGVDONiXTP8tWBhPz1209r1TKvWVnOdq9KcWkez1G8TfDbd0e6L891u5/+t9sdVz21V3Rnz/VTZ9coNK9KEAwq3b4bv7PfjsNE3rbuBLy65SfR6O+bQ9kYedN4k5yjzupw9rvjRm5fUeY4Nr3l5v6LPNbm3R1r5d5HwDk66xwXb2uTs663O+O/9xp6ywrT3fnjj48U+M+fSrmr887dH3+z0tSk8KdsH79Xa98pnuG30BrdO0usUXzuyytXVPhj0nm0P5Pm9XW8U4oGemySE1euVsZRCGOpIb0EDWZCQDJi+0eWtM8Hj3sG2FED2RM1ldKmM/c4UqvdN6ysngwlZuhJBBEJLT2YB4QXnh6gScnBGI3NTCEUmKQ9RxEOfihcLe3SRJBGQRvmKkfo9UNQRIQ7RhBfKEvYehDIiLrEpjHEQ3oDGsY31bWs7maF/tsjFLnrxi2AMoxjHSMYymvGMaEyjGtfIRjMGBAAh+QQJCAAAACwAAAAAgACAAIIAAAD/3gj/ziP/ziP/ziP/wwD/ziMAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIseNCASBBehxJUmPIkygFlFzJkmHKlyJbypQJs2bMmTg92qyZs+fGnTZ9Cq0IdOfQoxCLBkXKVKFSo02jFgRaAKjUqwCADigwwCrWpjYHbA3AtSvPr0jDii1AVqzZl2jTwnTLNkBbsWfj+pxL1+5dvHD19qzZ129ZwIEFz+Q7gEBdw27folS8mLFjv3YLEHALkzLNl24vY868GfFkzyUJixU9WjPnxKh1gl79uDWB0p1jj7Rc2/brlLo78h7t2/TJ4ByHE8fs2nhI5BlV3+5NvLnk49AvKl9u+Lbzm9kpbv/nTvr36fASx5MnW/r6c/TpZzemzl0z7tzwHUpnvb78d5X56Scff/2xZx52ATq1H33rWZdXbE/tFBqDDbYX4YOfXfjUhAVW591/GsKmXYgactihhweSWJR4Kl4YGoEnsmdhixFGRGOEkU0XI4op3oihgj5q9SKFHdoXWZAruoSkajnquKNtHx65JH4JqRjZlVhieRuMT8rYXpZg9qiUkkWFaeaVW95mAJEnFmBAml+eGeZTHwkpZ5Zwwrlml/W9mWeUd2KZJEJ2NvnnoQUkquiifC636KOHRgqmV4SqNeSjmGLa6KbMZeppooCCCJ5BNX3K6amoFvhpVVSSWmqqsMb/2iWrrU5FGJuy5gorV0tVyleiugaba6KiAinfWMImy+lh7iHo67G4Kitta1LW6ipj802rbX/WNfuescdyua223UJVJ5PZjqtuub2ei65j0ap7KqjV/lilhEPKm6yRYjrbUKFO6isrv6KOKqCljYkrMJ8Ee+uvjQgHvPCmDZtrEcDxTuzol5RihHHGGpPFbrvR4buawiEzB2jHP5mcMMj6VmyxcC5LnLLKHM+8W8QoLyyzvSTZaXPIBLPcktDwpgzqjCRXZumWMA+7Zb/f7mUy1D5PXTCAR12tZtSouqm1wwYP9TQBe8orNtMigmVZz/tGCTRTb4OdatFtX8XX0Nvy/2ut3rPxTe6Hf0s1oN27sl01Wodr7CBwgjU+8ePnMR443Mr6nXdUeyMea3OF052SiY4rXjbno9OmtOlcY7U35tJqDrnrgXs+8H2zA44S6USzbvnuqocdtu+0py54jImu6bnslbtt/PL2YU0x7s2LDny6DCNqN+UPy3U97K1F316awD7J/eLeA388edGHKT3yhG9u9fPmN+x+0vD/Z3jq2Ktq/3VaAt/5Tje/k/CuQqFC18uiNcDWpS8kB3SU/crUpPKxj3jWux6blnYlF72oZ4cJndM0iMCclaiCFAqh/HDCGAZxsF4hQpO4VJg7s8mHOi+kGo5QWB0xZRB4OEzglJ1kiEMQPdCAyMpMt7b2rQ3lyIJ3mVuGUvcYZumwe0rJUvnKIsWj3UpkgqLTs1zWF151kSU2UVSWxOguMm4lUU3LSRoF0EE2/muHZqHVCr04JQcebElHvNGIkPTDFpkkSM6jEc0UmcgQBc2QqHMkGkmkuxqNcEzFG5QcMRmXM16yewkKpShHScpSmvKUqEylKlfJyla68pWwjKUsARAQACH5BAkIAAAALAAAAACAAIAAggAAAP/lCP/OI//OI//OI//JAP/OIwAAAAj/AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3MixI0IBIEOKFOCxpEmLI1OKPMmyZUKVMFe6nMkypk2QNHN6vGlTp8+MPG/+HDoxKE+iSB0aFZq06celTJ1KFRi0QNCpU3kOGFBg61GsTW1u5Rqgq9eYYJOKHVug7NgBaNMSjfm2bQC3Y+PK9QnzLdm7Zs+q3Mu3L9u7gAm81UvYpeGtBOwiLqBYcMrGM+lCjow4cWW4gzG3fEyAc+fEeWGKPql5QGnJnSl/Vr26JGnTp8uWTn259k6VY1/nnrzbskzfGjULH+6Z90jkG2/DHi7b+HHoFVsvZ657dmjs2YFv/55OvTjo3uApSuceuzjj9A+V42bf3fl1+ErFu57Pvrr1kPjFtx59xHmHXoAvaccfff6d951vUClIHoPuRXigYxZCFdyCBDaY4VLRfajheATmJpuBIn5VVIoj7jdhiR6yCCJEMi61IYcwloZijT3lx+NNb+n4Yo6fOfgjbQsd2dqNQxJZ5H9KkpQkj35VeSMBBjTZoQE6PmmlkSxOaeOXZPrVJZZawsiljmW2aZ+KBxnlZpln6mhAliUyeGedXs652FVPAfkln4TWeSeeeeq5Z6GMlgmoQVqZySihBVRq6aWJMnjppZMSaiWcBAkaZGSbllpqpqh2aOqqlbL5Z4+Qxv/Eaqq01mrrZKzCWtBNad7q66+JWqVrqGL1CuyxyE4G5nNxrlVpstBGiyuUADa7pLHSZsvgq0jG+phr2GorbnvcXrjrWpCFO662lJVrLrFLbrfuvCaat+x93n4rL730NnhvtQpFOp66/NbaapGgBhrvvgVDe6K77yqsL8MNA/vwmxEniO5+OFZssKvUAkyjqBwT7HF59iYs4MZCnnzrxSHjhJLALprs8cEQZzwyyS27nCfM/+I7M8sU+3wa0CpjRHPPRqOMcFS/Ed2xy0hDbRvPRZ9c9bAmBcWkzckevGO3owlsJ9gWrzn2gzRhfSfaLy+as8iFKYglogUXsOjaQuv/JGppb1es95oY9123foDDbave5nGNlN2Kf9w42U7JN7W4F7+XlXhMN5w521gZlvW8/lG++UgbRr745MzKhfjl48bYelqvqy45xnuJDvu6pYNeOee7x16hznOllHrTshv+uPEkGp083b8zP3rew88ePeouNt3cvWDVbvGvz8t8ukjHv6z3s6uvHTrwaFd6aODpQzk++dkbrHaX6KfaO/E5ea//iZQiWPikdL2QlC9TADRPndQ1QKmQhoEAJBP+wtUu+YWFfcGKoJvwF6zqKa9tzKtfh7pUJeyNilREwt0FTTi9sgAtaFUSkpYaqBbEzVCDhTPhZqZXQe4tL4RTw2HMxUK4w/zVq3A1BOKLxOaXD0mqaD00Xf9saCIhBs1rJzQiaiw4lNaQx4o/euIXc1g8/cCGiXMTUQxRqCxqlVE8kvFXDmW0RvSZxXGZ0UxbKvUlqJwLi1baY8jeqBJL9XFG1qJZXSpltSnK6pBGYUiEAtlIEEYJehq75A+VtCJObpJHQ/vRCmsEFFCOMkUcMWUSRdS1MBUwQjVh5fwimUdY0o6Wh8Pj+vjnSEwi6JfADKYwh0nMYhrzmMhMpjKXycxmOvOZAgkIACH5BAkIAAAALAAAAACAAIAAggAAAP/pCP/OI//OI//OI//NAP/OIwAAAAj/AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGCMK2MhRQMaPIEMu7EiypMiTKCuWXGkypcuXCFnK7AizJsyZODfa3HkyJ06eQDP6zBm0KMWhP40qdYiU6NKnCZsmhUp14NACPqtqBYBzgNcCXgdM3aq069cAYL3OJPt0ZtgBBdC+XcvWqMy3cQPIDSuzbtG7YQnk3ct3pd+gLN8K1qu3AAEChQ0ftgl4wOPBjSFHJjmZ8krFixmjfbyZc+eXib1eFs3YsWaxkk+jTG15NevRr1nKTknb9m3XuWPv/gj4cejbuEtzHB6y93HkwNUKZ26xsm/kyaW3pF79s+rr0Elr/zfNXaX32pixRx9Ps/xE58+xZ4e93T1E5+nlr9dt/35q4/mpZ4B49JHX30jOGRCgegT2daBVTQUWn3yZNTjUVlIhJeGEFM6XYVYifZihhAtSuF6BIjp1VIoRfsdhhwUMGByLF2pEo4Ykdqifccrd6GBDPg4F2os6xkggikHyh2CSlbmooI47Hokkk+0pRCVJbw35JJQC8pjllEwuKdWXZJZpHAEGbMnlb2meWeabc31opZBw1uniY2mWuGaMMnpp55tNReXTn1+eaSiaaaq5JpuJHuonoT1OB6FZWTpq6aGJ5rmoiZn2eamlZYJoUE6FfoqpggWkqqqqm+q36qptmv966JcqFkSpi6/mqmurvKqn66+puhnnj7bKBGyvyCbbKrBYEUsQTnoqK+20XDbr7KTeRUvtttw2xp6Bz7oFl7bdlstrqt+Ci+15RJrr7qKORbrcQbe2++69Ow6r5KhNgofvvwy+BqZOgvZrL8D3uqavpMUaTC7C3SosL8FzGizYwxArG+yRY8VUL4AZJyxsuurS+7G/IU8LnMC1iklbbSinjOzKCzNcsbi4yqzyo6L6dzLGOofHccs+4wxzqkFvujHLRNt4sqJJc8pz0xINuuHBSdM88bzEnYy1zFqTXGVzpG4INMInDjx2iGXnHLVoafc8W9u1ofp2qjLWbDPblBr/p2nQfPopN2pt+w01xIFb2LFnBid6tsqNMn0tT33jefi/ic+4r13W4fk4tUYqvjdQOHuuc+gTY5jg55CLXnJb7KLJurSok1wXflm7zrXqJeUIuO4U847l0bmLt3lVsV+OeN7p3t77d7NvK/GUzg+P3t3As4V71NMfD7v1IHMveH1UxR49t92TD5X5b1fYo/Ad+a4x7cB7hPzzxCeLN9Izj//6X/iLWbX45Dj9Ze9+4PsadDrlONal73+kY9+yQucouymtfuXzTvjg5alLKS9KmvEeYgKowMasTGBXuxi8Dvi9+EFvTyesk6Ew9sC1cS6BD4shoc7EPxixsCwSNFHY6XpUqstEq4Y2jGAAjzhEsW2kUn47ouaSSDl26UmHW3Ph1Xr4mynuDoBL9NXInGixmMXLdkC04m+aqLZbwUyFrDnjwNKIv/xgkYx02uJv5EVH62FmaShkUhG5mJY53rCOrXlUFj80yLwUcnKMyxZaCkmrQI2pTHFJC13AyBJVAQopJrMamVS1uJ1A65M1KhjdsmQtEdYkj20c3bqsBspDXslpt7RlklaUS13e6CJUauEvhbJLYYqoJ8M0ZoZcQiMELvMmcoLf4AgXqOpB0pSlfJA2t8nNbnrzm+AMpzjHSc5ymvOc6ExnOgMCACH5BAkIAAAALAAAAACAAIAAggAAAP/rCP/OI//OI//OI//PAP/OI//OIwj/AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGCEK2MiRY8aPIEMq7EiypMiTKCuWXGkypcuXCFnK7AizJsyZODfa3Ckyp0+eQDH6zBm06MShP40qbYiU6NKnMZs6hUpV4NACQ6tWzTmga4GuA6ZqVToT7IACAb6CnTl2aVmzaNWuZdmWLEuzZwPolRtWZt2iMs0SQLuXgFm/f3kGBjtYb2HDc1cm3rl4AIHGjtNejtxy8svKlzE7LrCZM03Pn+92vUw4s2bIfSWjRgmatevHpk/P7qnasmjXpEvHJrn7ZO/QrW8Hz+2x+MfayZWHZi7A+fOVjG3fzry8K2LrKo8T/zAQXXrp7+CPii+v3IBwuukpiv+9Hbd3+PE1rq9vHjb+/EzNx952Bbjn338AJvSWb+TxZx51OqUnVUnZ0edgWgZCmBRQEzaVXYMXAvdehxtmRKKHq2kXInfT3XdiiRG9KNWHAzpYoHDDyYhTjDoOVWGNFwZ3YI9iLUQkV4KNB6SNBsKW45GdjQRlZSkquWJ9Nzr55JTNKcjlRnjhFRqIV7YXmpYa6ijljGG26eaZBpBZJndxnunmnXh1uCaSePZ55mVxLrligU222CeeSHnJ56F/NjpmnHLOSSekjjZ66GEwWuVTm5V2+iikkUo6KaieetpmVgVtmmSpn5JXwKuwwv8qKpaxxkoqq4amGSFBi/o2WK3AAjvrsMoFa+yrdmLKVqozHUvss9CWeSxWy/JalqDRZqstf1/tyOxi2G4rrrZqeWttZa+Oq+66r6ZpEJ8WrivvrKTpehBOgoU7774iKovgudhlpy+/+3bnomxRUakiwQw/6K6itcXbML9C2gtxb76mOzHByOJY5Lv4VhjqxuJm6eTH94Zc5cgkR2uyv/8mvKCvErc8rJAnoyyzwsjZnC3OMMdspMpVDuxzf3maK5GqRRt9dMc5K60e0WM63fLLulYn1KJVHz1ok0EjvDXVgFrNMNYHo2ci12V7jSXYWafEtpVu05mrziDN7Wrdr8L/nbbYLunNcsOE3i11ajMDGqjPhGZosWIqP3qA2c8WcECdI1bLYeTjLU5y45mrHdSCXduMtuZuzTc4xX6LnnrADFIObZYQ1iXe6gU7vqXWbanW89MtCv2U7wtfHTzgW1GYIu6sh97lWLC3/bTuyEO1n9sGC2/U9V5nX/3rJBXN9/FRUhU93d1TX/7w58tesvPPs6+8b+5v6/36din/++wuk09c8uFbnvteNTnZ0e5vvJNfAOlXucZ57mbw2xX4OiIwYjkQVBoT1f3+p0AKZoxeJvtToJxWsd2Zb377k1ahOsU8EUXQeu2TFNRyRTPWDGyDutleDK80QzSJqXSDimAC/wGzwxCF8FJV+lUQh8RBHaKwZqMBWtI8uCobBkmIE6QiFNOCMy0RjWa4qxcCJbi5+VkGSEcMG+wqpEQsMbGJZVzgGWmVLDVSqYYDEuMY84fC8vRwihP6oRX7NcYhUgZd/cHR7lBURT9qiIi9Sc4Mw3QkQbZxL48cHSIfo8hFvihMyCGMXFBnk5DFhS+A5BKe4lJIMpbyWu1yk1S+xbQwwQpvgcMJKu0oPEbaEpdy81HW4JgyXyYKkl8y5MWmxEdmLu1LWVRTeKDUQWlehJrVJFFIiHTCFwXTm93UE+ImBD1yHrIptkMVMg/3F2LCUJkJiqc850nPetrznvjMpz73yQjPfvrzn/4MCAAh+QQJCAAAACwAAAAAgACAAIIAAAD/6Qj/ziP/ziP/ziP/zQD/ziMAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgjCtjIUUDGjyBDLuxIsqTIkygrllxpMqXLlwhZyuwIsybMmTg32tx5MidOnkAz+swZtCjFoT+NKnWIlOjSpwmbJoVKdeDQAj6ragWAc4DXAl4HTN2qtOvXAGC9ziT7dGbYAQXQvl3L1qjMt3EDyA0rs27Ru2EJ5N3Ld6XfoCzfCtartwABAoUNH7YJeMDjwY0hRyY5mfJKxYsZo328mXPnl4m9XhbN2LFmsZJPo0xteTXr0a9Zyk5J2/Zt17lj7/4I+HHo27hLcxwesvdx5MDVCmdusbJv5Mmlt6Re/bPq69BJa/83zV2l99qYsUcfT7P8ROfPsWeHvd09ROfp5a/Xbf9+auP5qWeAePSR199IzhkQoHoE9nWgVU0FFp98mTU41FZSISXhhBTOl2FWIn2YoYQLUrhegSI6dVSKEX7HYYcFDBgcixdqRKOGJHaon3HK3ehgQz4OBdqLOsZIIIpB8odgkpW5qKCOOx6JJJPtKUQlSW8N+SSUAvKY5ZRMLinVl2SWaRwBBmzJ5W9pnlnmm3N9aKWQcNbp4mNplrhmjDJ6aeebTUXl059fnmkommmquSabiR7qJ6E9TgehWVk6aumhiea5qImZ9nmppWWCaFBOhX6KqYIFpKqqqpvqt+qqbZr/euiXKhZEqYuv5qprq7yqp+uvqboZ54+2ygRsr8gm2yqwWBFLEE56KivttFw26+yk3kVL7bbcNsaegc+6BZe23ZbLa6rfgovteUSa6+6ijkW63EG3tvvuvTsOq+SoTYKH778MvgamToL2ay/A97qmr6TFGkwuwt0qLC/Bcxos2MMQKxvskWPFVC+AGScsbLrq0vuxvyFPC5zAtYpJW20op4zsygszXLG4uMqs8qOi+ncyxjqHx3HLPuMMc6pBb7oxy0TbeLKiSXPKc9MSDbrhwUnTPPG8xJ2Mtcxak1xlc6RuCDTCJw48dohl5xy1aGn3PFvbtaH6dqoy1mwz25Qa/6dp0Hz6KTdqbfsNNcSBW9ixZwYnerbKjTJ9LU9943n4v4nPuK9d1uH5OLVGKr43UDh7rnPoE2OY4OeQi15yW+yiybq0qJNcF35Zu8616iXlCLjuFPOO5dG5i7d5VbFfjnje6d7e+3ezbyvxlM4Pj97dwLOFe9TTHw+79SBzL3h9VMUePbfdkw+V+W9X2KPwHfmuMe3Ae4T888QnizfSM4//+l/4i1m1+OQ4/WXvfuD7GnQ65TjWpe9/pGPfskLnKLsprX7l80744OWpSykvSprxHmICqMDGrExgV7sYvA74vfhBb08nrJOhMPbAtXEugQ+LIaHOxD8YsbAsEjRR2Ol6VKrLRKuGNoxgAI84RLFtpFJ+O6Lmkkg5dulJh1tz4dV6+Jsp7g6AS/TVyJxosZjFy3ZAtOJvmqi2W8FMhaw548DSiL/8YJGMdNrib+RFR+thZmkoZFIRuZiWOd6wjq15VBY/NMi8FHJyjMsWWgpJq0CNqUxxSQtdwMgSVQEKKSazGplUtbidQOuTNSoY3bJkLRHWJI9tHN26rAbKQ17Jabe0ZZJWlEtd3ugiVGrhL4WyS2GKqCfDNGaGXEIjBC7zJnKC3+AIF6jqQdKUpXyQNrfJzW5685vgDKc4x0nOcprznOhMZzoDAgAh+QQJCAAAACwAAAAAgACAAIIAAAD/5Qj/ziP/ziP/ziP/yQD/ziMAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsSNCASBDihTgsaRJiyNTijzJsmVClTBXupzJMqZNkDRzerxpU6fPjDxv/hw6MShPokgdGhWatOnHpUydShUYtEDQqVN5DhhQYOtRrE1tbuUaoKvXmGCTih1boOzYAWjTEo35tm0At2PjyvUJ8y3Zu2bPqtzLty/bu4AJvNVL2KXhrQTsIi6gWHDKxjPpQo6MOHFluIMxt3xMgHPnxHlhij6peUBpyZ0pf1a9uiRp06fLlk59ufZOlWNf556827JM3xo1Cx/umfdI5Btvwx4u2/hx6BVbL2eue3Zo7NmBb/+eTr046N7gKUrnHrs44/QPleNm3935dfhKxbuez7669ZD4xbcefcR5h16AL2nHH33+nfedb1ApSB6D7kV4oGMWQhXcggQ2mOFS0X2o4XgE5iabgSJ+VVSKI+43YYkesggiRDIutSGHMJaGYo095cfjTW/p+GKOnzn4I20LHdnajUMSWeR/SpKUJI9+VXkjAQY02aEBOj5ppZEsTmnjl2T61SWWWsLIpY5ltmmfigcZ5WaZZ+poQJYlMnhnnV7OudhVTwH5JZ+E1nknnnnquWehjJYJqEFamckooQVUaumliTJ46aWTEmolnAQJGmRkm5ZaaqaodmjqqpWy+WePkMb/xGqqtNZq62SswlrQTWne6uuviVqla6hi9QrsschOBuZzca5VabLQRosrlAA2u6Sx0mbL4KtIxvqYa9hqK2573F6461qQhTuutpSVay6xS2637rwmmrfsfd5+Ky+99DZ4b7UKRTqeuvzW2mqRoAYa774FQ3uiu+8qrC/DDQP78JsRJ4jufjhWbLCr1AJMo6gcE+xxefYmLODGQp5868Uh44SSwC6a7PHBEGc8Msktu5wnzP/iOzPLFPt8GtAqY0Rzz0ajjHBUvxHdsctIQ20bz0WfXPWwJgXFpM3JHrxjt6MJbCfYFq859oM0YX0n2i8vmrPIhSmIJaIFF7Do2kLr/yRqaW9XrPeaGPddt36Aw22r3uZxjZTdin/cONlOyTe1uBe/l5V4TDecOdtYGZb1vP5RvvlIG0a++OTMyoX45ePG2Hpar6suOcZ7iQ77uqWDXjnnu8deoc5zpZR607Ib/rjxJBqdPN2/Mz963sPPHj3qLjbd3L1g1W7xr8/LfLpIx7+s97Orrx068GhXemjg6UM5PvnZG6x2l+in2jvxOXmv/4mUIlj4pHS9kJQvUwA0T53UNUCpkIaBACQT/sLVLvmFhX3BiqCb8Bes6imvbcyrX4e6VCXsjYpURMLdBU04vbIALWhVEpKWGqgWxM1Qg4Uz4WamV0HuLS+EU8NhzMVCuMP81atwNQTii8Tmlw9Jqmg9NF3/bGgiIQbNayc0ImosOJTWkMeKP3riF3NYPP3AholzE1EMUagsapVRPJLxVw5ltEb0mcVxmdFMWyr1JaicC4tW2mPI3qgSS/VxRtaiWV0qZbUpyuqQRmFIhALZSBBGCXoau+QPlbQiTm6SR0P70QprBBRQjjJFHDFlEkXUtTAVMEI1YeX8IplHWNKOlofD4/r450hMIuiXwAymMIdJzGIa85jITKYyl8nMZjrzmQIJCAAh+QQJCAAAACwAAAAAgACAAIIAAAD/3gj/ziP/ziP/ziP/wwD/ziMAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIseNCASBBehxJUmPIkygFlFzJkmHKlyJbypQJs2bMmTg92qyZs+fGnTZ9Cq0IdOfQoxCLBkXKVKFSo02jFgRaAKjUqwCADigwwCrWpjYHbA3AtSvPr0jDii1AVqzZl2jTwnTLNkBbsWfj+pxL1+5dvHD19qzZ129ZwIEFz+Q7gEBdw27folS8mLFjv3YLEHALkzLNl24vY868GfFkzyUJixU9WjPnxKh1gl79uDWB0p1jj7Rc2/brlLo78h7t2/TJ4ByHE8fs2nhI5BlV3+5NvLnk49AvKl9u+Lbzm9kpbv/nTvr36fASx5MnW/r6c/TpZzemzl0z7tzwHUpnvb78d5X56Scff/2xZx52ATq1H33rWZdXbE/tFBqDDbYX4YOfXfjUhAVW591/GsKmXYgactihhweSWJR4Kl4YGoEnsmdhixFGRGOEkU0XI4op3oihgj5q9SKFHdoXWZAruoSkajnquKNtHx65JH4JqRjZlVhieRuMT8rYXpZg9qiUkkWFaeaVW95mAJEnFmBAml+eGeZTHwkpZ5Zwwrlml/W9mWeUd2KZJEJ2NvnnoQUkquiifC636KOHRgqmV4SqNeSjmGLa6KbMZeppooCCCJ5BNX3K6amoFvhpVVSSWmqqsMb/2iWrrU5FGJuy5gorV0tVyleiugaba6KiAinfWMImy+lh7iHo67G4Kitta1LW6ipj802rbX/WNfuescdyua223UJVJ5PZjqtuub2ei65j0ap7KqjV/lilhEPKm6yRYjrbUKFO6isrv6KOKqCljYkrMJ8Ee+uvjQgHvPCmDZtrEcDxTuzol5RihHHGGpPFbrvR4buawiEzB2jHP5mcMMj6VmyxcC5LnLLKHM+8W8QoLyyzvSTZaXPIBLPcktDwpgzqjCRXZumWMA+7Zb/f7mUy1D5PXTCAR12tZtSouqm1wwYP9TQBe8orNtMigmVZz/tGCTRTb4OdatFtX8XX0Nvy/2ut3rPxTe6Hf0s1oN27sl01Wodr7CBwgjU+8ePnMR443Mr6nXdUeyMea3OF052SiY4rXjbno9OmtOlcY7U35tJqDrnrgXs+8H2zA44S6USzbvnuqocdtu+0py54jImu6bnslbtt/PL2YU0x7s2LDny6DCNqN+UPy3U97K1F316awD7J/eLeA388edGHKT3yhG9u9fPmN+x+0vD/Z3jq2Ktq/3VaAt/5Tje/k/CuQqFC18uiNcDWpS8kB3SU/crUpPKxj3jWux6blnYlF72oZ4cJndM0iMCclaiCFAqh/HDCGAZxsF4hQpO4VJg7s8mHOi+kGo5QWB0xZRB4OEzglJ1kiEMQPdCAyMpMt7b2rQ3lyIJ3mVuGUvcYZumwe0rJUvnKIsWj3UpkgqLTs1zWF151kSU2UVSWxOguMm4lUU3LSRoF0EE2/muHZqHVCr04JQcebElHvNGIkPTDFpkkSM6jEc0UmcgQBc2QqHMkGkmkuxqNcEzFG5QcMRmXM16yewkKpShHScpSmvKUqEylKlfJyla68pWwjKUsARAQACH5BAkIAAAALAAAAACAAIAAggAAAP/WB//OI//OI/+8AP/OIwAAAAAAAAj/AAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEMyFECypACRKFM6NMmSpMqXMAG0nOkypk2PNHPe3KkxJ02eQCv61Bm06MqhRI0qRYg06dKnAocSGAq1qlSqVZf6HEAgAIEBTrMGzTmAq9eyYcXeJGs2wFmwM9WOnVm27Vu4LeXypFm2q9u7P/Xa5Nv3r9uvaPMKjknY7uG6gRenbOzXMGDFklESLlDZMGK8LDNrblm3s+cCiTGLxkm3sOW/n+Ou/tja8evYsmdvpPzaMu7Qune35tzbM2TVwS3yLg4bNWiTyTFuNl38N/Toykm7Zg77OHLsD5dz/z/sPDJ4iLWJj++e+vr58LWpcydQPvf7kcPlz/fu/r5C8eux91xJ7zUFYIBe1Wdgf0At6KAApSF4G38P+sRahRhGKOFpFGJooFAeVliXehsKGGKFEp0oYlkklkhehypidVSMSNXFon4I0udcezSmlVCPbNl4o4u3FbAjjEDWhJ+DQjbppJBGtkhkgkY+aaWQGDZk4JVc2hilkTiWqGOVXZb54UI1ltlklAS06eabU9725ptRqukkUks2VtqcfPIZ55+H9Slom3daiOZMgwKq6KLMDTqVfUzRFCajlFbqm48F+TSppZwq+qh5kfLVZqekUkqoof8FuWmprDaKpJKpHv/Y6qz78QhcntptR+uuE756kpZbacjrsHcNeCuuudpGLKufGcsgsizZOOqypRLq668RDeXlqtS6SJ+NMqYY7JDdmnpkuBOlOYCU5U75ra3fpautsO0S2SyePc2ra70S3otuRvpyxS2/1sL7rHBBrjtwue8aTKBIAbPLL4fXqqSuxBM3jK/FAS+8q7+ovqSusu2CjOlk4wpMsMmQrjUumCWT6ezDRekLM7U6VqzVyxgzK/O/NQd587A5O4wtVEJ7bO6rek3X7bugiuU0zgoeq9bUy0LdclbxlQzjYl0z/LVgYT89dtPa9Uyr1lZznavSnFpHs9RvE3w23dHui/Pdbuf/rfbHVc9tVd0Z8/1U2fXKDSvShAMKt2+G7+z347DRN627gS8uuUn0ejvm0PZGHnTeJOco87qcPa740ZuX1HmODa95eb+izzW5t0da+XeR8A5OuscF29rk7Outzvjv/caessK093544+PFPjPn0q5q/PO3R9/s9LUpPCnbB+/V2vfKZ7ht9Aa3TtLrFF87ssrV1T4Y9J5tD+T5vV1vFOKBnpskhNXrlbGUQhjqSG9BA1mQkAyYvtHlrTPB497BthRA9kTNZXSpjP3OFKr3TesrJ4MJWboSQQRCS09mAeEF54eoEnJwRiNzUwhFJikPUcRDn4oXC3t0kSQRkEb5ipH6PVDUESEO0YQXyhL2HoQyIi6xKYxxEN6AxrGN9W1rO5mhf7bIxS568YtgDKMYx0jGMprxjGhMoxrXyEYzBgQAIfkECQgAAAAsAAAAAIAAgACCAAAA/84H/84j/84j/7UA/84jAAAAAAAACP8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoFwpYmbLlyZUwY7qc6TGmTZk0c1q8yZOlzp8Re/IESrSh0J5Fkx4USgCp0qcCmQqF+rQngQBNh1It2nPAVQIDnG79ydNrgLNgtY7NWdYs2gFhba7VeRPu1bNY4aqdm7LtXbxg4+Lk29cmXLeA9d4kXDimXbyQAy9mbNIv5MSCYVKubBjxZcmTN4e0fBlzaNEf63ouDVou6tSd/5Z+m9nna46kZ9M+fTujatm6Ww/ufTG37t2uiRePffyz4uHKJxpvLlxzdIqqV1N/bv26xN/NWXP/7+7d4fTweWsLKA8RPHrn6tmbd//eNG/5Bbtqr1+d/OajADq233v9BXgfZwYmKOCABI6noIEdPSghc/XNFph6E0K4U4YTHgZchbQ5yCGAFY344GEMVnghhiaK1V6L+qF4WAEfgohWATIeBuNUQSWY449AokijjccRgGOQSMqoYI9CJZkkAVBGKSWRwUkppZNJkvhQkzJa6eWXVIbJ2pdkQvkjj/PFVKaYbLapYpkHJsRTjW7WaSd/ezFk1Z189kmdi3qWBaWfhPZpJqCB0lfoomEWuB6TnaXI6KQW6phnmpHSSemmmLGIXYyacjrphWh+B6qoqKbH4qMlghpqqnWa/ymibcu1JSmsYpKKaK3ZvYorkbpe6tupv8ZqqbAacXlrseEFG+dGyvrKbHDHPoubq9O+WW1yJUWbLXrOcvsSsd9WOiurLXlbLnyr0kXuuuFCN5O65cbrH1vYTitru0rFuOyiK+5KVIxD4mrktvf2a2vBqB48K18LS2vokRgydh6nBVJ28aYZa0whrP39p2jDInosoMSFhmzxxwY7aDJMjxWrMmEjpzrzXDWD7DLELP9681g527wzzj23HB/RJ9c79FZB63w00EVTiXKRS1PVNH9GDppr1VVFrS2KU4v3NFRXNwuk1sBynVTZVT4ZdnrWkuX1dggLALaNP689d9vnrtTk4dR5D7z3ZwEHeDd/agPFdoir5mv22Hon3ay9BoL9auByS15k4SMeTjXkiu/NOZqG26Up5vhqTnjd4kZ1lOfwxe1Szfs2ju5Sr5sutuzpGvbh6ALnl3vMkYHuru+RUS6vSsOjnRey89b1F/C8466sV3elVT2CNn2lfMIvXv9V8LPfFCXry3+ae5TQl9/9khEmmFXrx084WoZdS0gS/grDz72G/QtQ7wCYv1IN0IBka19j0oefBjrwgRCMoAQnSMEKWvCCGMygBjfIwQ568IMgvE5AAAAh+QQJCAAAACwAAAAAgACAAIIAAAD/xwf/ziP/ziP/rwAAAAAAAAAAAAAI/wABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqly5UIDLlwJYyvQIs6bLmTgv2tyZs6fEnTZ9Cm0IlOfQowd3EjCKtCkAoEuZOh2qNEDUmlOP7hxAwKrUrDltcg1A9ipMsD7Fdi07IChanGrJsm2L9a3MuHKt0j1rd6XYsXkJ7H3Z129NwHn1ui1s8u/axIIXMyaJN7HewTcnUz782HLkuppDVrasGHToj6NJf+Z7uqNj0oExx2ztmjPs2Jhp14aJ+HZp1rp12vYtdzXh4BhT3xYsG7nF18SLN3dOUblv45mpR4QeXbpk7USHd//3bho8Q+vEmX83jxB9dOyz2ScF2ns826Khi+rfWt/+7/37qQTggPr15x98BCbIUYIM8teZf3M1KOFxFU044QAGQqiehQ1WyGGCGGL4IIRzYfihgj+dyF+ILGZIInMtmqjiV+HtF+ONMRKg4448kggbj0DiKKSMAKa4oohAJpmkj0x6puSTOraon5EuQdnklVjaB6VZ8T1k04hZhimmluud9+WYaKZ5HY1mfgmmmnBeqSNQE9H3Zpx4ailbdts5mOefGhJZnpf0uQjooRHSWV2hdyL654Zs9rlVo47CiSCfwk1KaaVhRonfgoxyiiekZSYXqqhpkjroRkWJiOqYqgL/h9qpr8op6Ko0tbpprcvtSWFJuu7Ka3GXdnlSq4YOK52vxqKErLCvxvqrYX4qq9qtsrL0rLWQYTvtTNtye9mnVNkJ7ajFThVutN5iitS6nErrblOFJmtpiIq+Rauj8jI2KbuRguXeo9NNNnCe8OXHm71xqqrwSwyPmpvB4qGasL8Vi3pxYYdF3PCtFEN87se4qpuxxQXre7LGKaPV8cj3TmzXyiiX/C7NLJd6M28wq5blxgIv3HNgguloq8xBiywnjK42iZ3KPDuNo9E+Au3UwT9Ki+SLLdMrNNfMChDiyA4n7ZLHZcn78rlPZ4U1se3Cm17X5UbdHYwXcrWr1Vp9rJ2e2gRufR3IJit9HeDGFth0rzbDhfNlYTf7lOJUX6uz43Y7Gfe8BNmYId9pnRxl5A55Xjl52YYO04h4TwmR6Z5dfteZcJO+KKOdcck5uLSP6/pzlK+lu+SYr25Vsd96uO3wO7+044C57vd849Q6D71oAOrePIoiTeg1gc5y3/f1KYF/dYCz/35+wOXnK9/78Mcv//z012///fjnr//+/Pfv//8ADKAAB2iXgAAAIfkECQgAAAAsAAAAAIAAgACCAAAA/8IH/84j/6sA/84jAAAAAAAAAAAACP8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pc2VCAS5YwQ7qcSTOmzYw0c768yXOizpw9gz78qVOo0YQ/B/w8ypRg0qVNmSYNoBRo1KNTq1q9GlTngABgtc7k2jUnga9hoZK16RVsWAJF18bUedZt2q1yV9JF63YAXLx5T061e7dm4JR7Cb+Ne9hkW8VU/xpuTDIxZKqMKYt8fNlvZs0eLV/GDBg0R9GdJe80HTon39GeS7O+iBr259m0XY8mHHsybou1Yate/bticNuyiw/lvLvvcAHKKR7fLZZ49OU0Xzd3fvu6wunUn3v/xz5T+/a+3ccbBN+891j1TonOrHsecvX0UuXrl0+/vmL3+wUIXWUCFsifef5FZuCC+EXE4IPzIZigghA+mFuFCxLQ34R2+fUchvsZB+J+Gpa4IYcdmvjhiMktxKCKMJo4wIw01oiifTXWGOOOFjqoX4k5BinkjUR2KOSRM5oYoo/lHVnkk1Buh2R1EjEX5ZVY1ndflVZm6eWXhflGXpNglonljGoxaZaEZrZ5HoDv+fTTiW7WGR5RwBFFp518codnnnOy2WebcMYJKHuDflmodReuKWiiUSb5Z0cHQlrmogN+VKmlWWI60qacQukpgYGG+uSoJYFq6oSoChboo6sa/7kiTKrGmpp8bOkJq6mt0qqrrfatmOlNtdraK7G/AkthmkLpuqubkjKL1Zx79unhpFfpWW2d10oblbbPdqohtmtRG+6Z4zb47Zqcwgkau5YC+C68kLpLGaJm2ttYl4Nuea9uofp7GL6EijcwvfEaHBi/iQqcF8P9qjstTdtaq3C5CLd7MVkQNyxxswDH6jBXBEsp6sbrUnwujmetzBvKTXUspYdAFjlyyuUR2W2ELofJaH4qoxjtqxzqi7NLFd8aYNL/wWyUzP9hute5N0+cs5ZSF4ucmFYj/WzWJM74ptM94Tv0pGE/anTXAqid9UFht/exr9nduSTcP4rd2dx6ZYLc19sMxR0s34j5fba3SOVt3tpl1f1ygHIWWzVPzB1OON7Odni5q44vS66IB6I1ObJ1o3m3RnGPnmuT923uUIA0tri6S63Ljvp+VAJdoGMLxrx74QIe/TnnuGZb/FzHG8816YbC5/zz0Ecv/fTUV2/99dhnr/323Hfv/ffghy8+SgEBADs=';

const pendingReviews = new Map();
const reviewStarEmojiCache = new Map();

function reviewContextKey(userId, reviewId) {
  return `${userId}:${reviewId}`;
}

function pruneExpiredReviews() {
  const now = Date.now();
  for (const [key, entry] of pendingReviews) {
    if (now - entry.updatedAt > PENDING_REVIEW_TTL_MS) {
      pendingReviews.delete(key);
    }
  }
}

function buildRatingMenu(disabled = false, memberId = '') {
  return new StringSelectMenuBuilder()
    .setCustomId(memberId ? `${STAFF_REVIEW_RATING_ID}:${memberId}` : STAFF_REVIEW_RATING_ID)
    .setPlaceholder('Choose your rating')
    .setDisabled(disabled)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('⭐').setValue('1'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐').setValue('2'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐').setValue('3'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐⭐').setValue('4'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐⭐⭐').setValue('5'),
    );
}

function buildMemberMenu(ownerMembers = []) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(STAFF_REVIEW_MEMBER_ID)
    .setPlaceholder('Choose the staff member');

  if (!ownerMembers.length) {
    return menu
      .setDisabled(true)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('No Owner members available')
          .setValue('none'),
      );
  }

  menu.addOptions(
    ownerMembers.slice(0, 25).map(member => {
      const username = member.user?.username || member.displayName;
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(member.displayName.slice(0, 100))
        .setValue(member.id);

      if (username) {
        option.setDescription(`@${username}`.slice(0, 100));
      }

      return option;
    }),
  );

  return menu;
}

export function buildStaffReviewsPanel(ownerMembers = []) {
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('Staff reviews')
    .setDescription(
      'We want to hear about your experience with our staff team!\n\n'
      + 'Share your feedback by selecting the staff member you would like to review, giving them a rating, and then writing a comment describing your experience.\n\n'
      + 'Please keep your feedback respectful and constructive. Any inappropriate, offensive, insulting, or irrelevant submissions may be removed.\n\n'
      + `Once submitted, your review will be published in the [posted reviews](https://discord.com/channels/@me/${COMMUNITY_REVIEWS_CHANNEL_ID}) section.\n\n`
      + 'Your reviews not only help us improve, but also encourage and support our staff team. We truly appreciate you taking the time to share your experience and show your support!',
    )
    .setFooter({ text: FOOTER });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(buildMemberMenu(ownerMembers)),
      new ActionRowBuilder().addComponents(buildRatingMenu(true)),
    ],
  };
}

export function buildRatingPrompt(memberId) {
  return {
    content: `Now choose your rating for <@${memberId}>.`,
    components: [new ActionRowBuilder().addComponents(buildRatingMenu(false, memberId))],
    allowedMentions: { parse: [] },
  };
}

export function createReviewContext(userId, memberId, rating) {
  pruneExpiredReviews();
  const reviewId = randomUUID();
  pendingReviews.set(reviewContextKey(userId, reviewId), {
    memberId,
    rating: Number(rating),
    updatedAt: Date.now(),
  });
  return reviewId;
}

export function takeReviewContext(userId, reviewId) {
  pruneExpiredReviews();
  const key = reviewContextKey(userId, reviewId);
  const context = pendingReviews.get(key) || null;
  pendingReviews.delete(key);
  return context;
}

export function buildStaffReviewModal(memberOrReviewId, rating = null) {
  const normalizedRating = Number(rating);
  const hasEmbeddedContext = /^\d{16,22}$/.test(String(memberOrReviewId || ''))
    && Number.isInteger(normalizedRating)
    && normalizedRating >= 1
    && normalizedRating <= 5;

  const customId = hasEmbeddedContext
    ? `${STAFF_REVIEW_MODAL_ID}:${memberOrReviewId}:${normalizedRating}`
    : `${STAFF_REVIEW_MODAL_ID}:${memberOrReviewId}`;

  const comment = new TextInputBuilder()
    .setCustomId('staff_review_comment')
    .setLabel('Tell us about your experience')
    .setPlaceholder('Write your review here...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Staff review')
    .addComponents(new ActionRowBuilder().addComponents(comment));
}

async function getOwnerRole(guild) {
  if (!guild) return null;

  let ownerRole = guild.roles?.cache?.find(role => role.name.toLowerCase() === OWNER_ROLE_NAME) || null;
  if (!ownerRole && guild.roles?.fetch) {
    const roles = await guild.roles.fetch().catch(() => null);
    ownerRole = roles?.find(role => role.name.toLowerCase() === OWNER_ROLE_NAME) || null;
  }

  return ownerRole;
}

export async function getOwnerMembers(guild) {
  const ownerRole = await getOwnerRole(guild);
  if (!ownerRole || !guild?.members) return [];

  const members = await guild.members.fetch().catch(() => guild.members.cache);
  if (!members) return [];

  return [...members.values()]
    .filter(member => !member.user?.bot && member.roles?.cache?.has(ownerRole.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function isOwnerReviewTarget(guild, memberId) {
  if (!guild || !memberId) return false;

  const ownerRole = await getOwnerRole(guild);
  if (!ownerRole || !guild.members?.fetch) return false;

  const member = await guild.members.fetch({ user: memberId, force: true }).catch(() => null);
  return Boolean(member && !member.user?.bot && member.roles?.cache?.has(ownerRole.id));
}

export async function ensureStaffReviewStarEmoji(guild) {
  if (!guild?.emojis) return null;

  const cachedEmojiId = reviewStarEmojiCache.get(guild.id);
  if (cachedEmojiId) {
    const cachedEmoji = guild.emojis.cache.get(cachedEmojiId);
    if (cachedEmoji) return cachedEmoji.toString();
  }

  let emoji = guild.emojis.cache.find(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;

  if (!emoji && guild.emojis.fetch) {
    const emojis = await guild.emojis.fetch().catch(() => null);
    emoji = emojis?.find(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;
  }

  if (!emoji) {
    emoji = await guild.emojis.create({
      attachment: Buffer.from(STAFF_REVIEW_STAR_GIF_BASE64, 'base64'),
      name: STAFF_REVIEW_STAR_EMOJI_NAME,
      reason: 'Cloudy staff review rating star',
    }).catch(() => null);
  }

  if (!emoji) return null;

  reviewStarEmojiCache.set(guild.id, emoji.id);
  return emoji.toString();
}

export function buildPublishedReview(interaction, rating, comment, memberId, starEmoji = null) {
  const normalizedRating = Math.max(1, Math.min(5, Number(rating) || 1));
  const stars = starEmoji
    ? Array.from({ length: normalizedRating }, () => starEmoji).join('')
    : '⭐'.repeat(normalizedRating);
  const randomSideColor = Math.floor(Math.random() * 0x1000000);

  return new EmbedBuilder()
    .setColor(randomSideColor)
    .setAuthor({
      name: interaction.user.globalName || interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setThumbnail(CLOUDY_C_LOGO_URL)
    .setDescription(
      `**Staff member**\n<@${memberId}>\n\n`
      + `**Rating**\n${stars}\n\n`
      + `**Experience**\n${comment}`,
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
