export function createSingleFlight(task) {
  if (typeof task !== 'function') {
    throw new TypeError('createSingleFlight requires a function');
  }

  let activePromise = null;

  return (...args) => {
    if (activePromise) return activePromise;

    activePromise = Promise.resolve()
      .then(() => task(...args))
      .finally(() => {
        activePromise = null;
      });

    return activePromise;
  };
}
