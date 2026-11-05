import { VOTE_FORM_ID, submitVoteForm } from '../../commands/Tools/vote.js';

// The optional media step of /vote: posts the vote, with or without pictures.
export default {
  name: VOTE_FORM_ID,
  execute(interaction, client, [id] = []) {
    return submitVoteForm(interaction, id);
  },
};
