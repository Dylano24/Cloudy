// /votemanage: the status and vote dropdowns.
import { chooseVoteStatus, chooseVoteToManage } from '../../../services/voteManageService.js';

export default [
  { name: 'vmanage_status', execute: chooseVoteStatus },
  { name: 'vmanage_vote', execute: chooseVoteToManage },
];
