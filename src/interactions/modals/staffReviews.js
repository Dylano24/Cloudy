export default {
  name: 'staff_review_modal',
  async execute() {
    // The dedicated staffReviewsInteraction event owns this modal flow.
    // Registering the route prevents the general interaction router from
    // treating staff review submissions as an unknown configuration form.
  },
};
