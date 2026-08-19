import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

const TARGET_GUILD_ID = '1532882647838228723';
const LOG_CHANNEL_ID = '1539259457404412036';
const BLOCKED_IDENTITIES = ['Doriane Miro', 'Dylano Piazzini'];
const processing = new Set();

function normalize(value = '') {
    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

const blocked = BLOCKED_IDENTITIES.map(display => ({
    display,
    normalized: normalize(display),
}));

function detectInValue(value) {
    const normalizedValue = normalize(value);
    if (!normalizedValue) return null;
    return blocked.find(identity => normalizedValue.includes(identity.normalized)) || null;
}

function detectInProfile(member) {
    const fields = [
        ['Username', member.user?.username],
        ['Display name', member.user?.globalName],
        ['Server nickname', member.nickname],
        ['Server display name', member.displayName],
    ];

    for (const [field, value] of fields) {
        const identity = detectInValue(value);
        if (identity) return { identity: identity.display, field, value };
    }

    return null;
}

function isExempt(member) {
    return (
        !member ||
        member.guild.id !== TARGET_GUILD_ID ||
        member.id === member.guild.ownerId ||
        member.id === member.client.user?.id
    );
}

async function sendPermanentLog(member, detection, source, banned, error = null) {
    const channel = await member.client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased()) {
        logger.warn(`Protected identity log channel ${LOG_CHANNEL_ID} is unavailable`);
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(banned ? '#ED4245' : '#FEE75C')
        .setTitle(banned ? 'Automod account banned' : 'Automod account ban failed')
        .setDescription(
            banned
                ? 'Account was automatically banned because the username, display name, or message contained a blocked identity.'
                : 'A blocked identity was detected, but Cloudy could not ban the account automatically.'
        )
        .addFields(
            { name: 'Detected in', value: source, inline: true },
            {
                name: 'Detected value',
                value: `\`${String(detection.value || '').slice(0, 900)}\``,
                inline: false,
            },
            {
                name: 'Account',
                value: `${member.user.tag} (\`${member.id}\`)`,
                inline: false,
            },
            {
                name: 'Action',
                value: banned
                    ? 'Permanent ban'
                    : `Manual action required${error ? `: ${String(error).slice(0, 500)}` : ''}`,
                inline: false,
            },
            {
                name: 'Banned by',
                value: banned
                    ? `${member.client.user} (${member.client.user.tag})`
                    : 'Not completed',
                inline: false,
            },
            {
                name: 'Reason',
                value: banned
                    ? `Blocked identity detected (${detection.identity})`
                    : (error || 'Automatic protection failed'),
                inline: false,
            },
            {
                name: 'Date',
                value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                inline: false,
            }
        )
        .setThumbnail(member.user.displayAvatarURL({ size: 512 }))
        .setFooter({ text: 'Cloudy Protected Identity System' })
        .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(logError => {
        logger.warn('Could not send permanent protected identity log:', logError);
    });
}

async function banDetectedMember(member, detection, source) {
    if (isExempt(member) || processing.has(member.id)) return false;
    processing.add(member.id);

    try {
        const botMember = member.guild.members.me;
        const canBan =
            member.bannable &&
            botMember?.permissions?.has(PermissionFlagsBits.BanMembers);

        if (!canBan) {
            await sendPermanentLog(
                member,
                detection,
                source,
                false,
                'Cloudy needs Ban Members permission and a role above this account.'
            );
            return true;
        }

        await member.ban({
            reason: `Automatic ban: blocked identity detected (${detection.identity})`,
        });
        await sendPermanentLog(member, detection, source, true);
        logger.warn(`Banned ${member.user.tag}: blocked identity ${detection.identity} detected in ${source}`);
        return true;
    } catch (error) {
        await sendPermanentLog(member, detection, source, false, error.message);
        logger.error('Protected identity ban failed:', error);
        return true;
    } finally {
        processing.delete(member.id);
    }
}

export async function enforceProtectedIdentityMessage(message) {
    if (!message.guild || message.guild.id !== TARGET_GUILD_ID) return false;

    const identity = detectInValue(message.content);
    if (!identity) return false;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (isExempt(member)) return false;

    const detection = {
        identity: identity.display,
        field: 'Message',
        value: message.content,
    };

    await message.delete().catch(() => {});
    return banDetectedMember(member, detection, 'Message');
}

export async function enforceProtectedIdentityProfile(member) {
    if (isExempt(member)) return false;
    const detection = detectInProfile(member);
    if (!detection) return false;
    return banDetectedMember(member, detection, detection.field);
}

export async function scanProtectedIdentities(client) {
    const guild = client.guilds.cache.get(TARGET_GUILD_ID) ||
        await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
    if (!guild) return { scanned: 0, detected: 0 };

    const members = await guild.members.fetch().catch(error => {
        logger.warn('Could not fetch members for protected identity scan:', error);
        return null;
    });
    if (!members) return { scanned: 0, detected: 0 };

    let detected = 0;
    for (const member of members.values()) {
        if (await enforceProtectedIdentityProfile(member)) detected += 1;
    }

    logger.info(`Protected identity scan: ${members.size} scanned, ${detected} detected`);
    return { scanned: members.size, detected };
}
