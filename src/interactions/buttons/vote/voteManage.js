// /votemanage: Previous / Next and the panel buttons (End, Delete, Back).
import { turnVoteManagePage, voteManageAction } from '../../../services/voteManageService.js';

export default [
  { name: 'vmanage_page', execute: turnVoteManagePage },
  { name: 'vmanage_btn', execute: voteManageAction },
];
