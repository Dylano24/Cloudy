import { Events } from 'discord.js';
import { scheduleContentCreatorGuide } from '../services/contentCreatorGuideService.js';

export default { name: Events.MessageCreate, execute: scheduleContentCreatorGuide };
