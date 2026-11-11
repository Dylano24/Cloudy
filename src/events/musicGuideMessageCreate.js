import { Events } from 'discord.js';
import { scheduleMusicGuide } from '../services/music/musicGuideSticky.js';

export default { name: Events.MessageCreate, execute: message => scheduleMusicGuide(message) };
