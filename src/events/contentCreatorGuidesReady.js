import { Events } from 'discord.js';
import { ensureContentCreatorGuides } from '../services/contentCreatorGuideService.js';

export default { name: Events.ClientReady, once: true, execute: ensureContentCreatorGuides };
