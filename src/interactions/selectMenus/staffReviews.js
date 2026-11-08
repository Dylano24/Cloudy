export default {
  name: 'staff_review_rating',
  async execute() {
    // Dedicated staffReviewsInteraction listener handles private ratings.
    // Prevent the generic router from treating IDs with member suffixes as missing.
  },
};
