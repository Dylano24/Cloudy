export default {
  name: 'service_review_rating',
  async execute() {
    // Dedicated serviceReviewsInteraction listener owns private rating choices.
    // Keep the generic interaction router from answering these a second time.
  },
};
