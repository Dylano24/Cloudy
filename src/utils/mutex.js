// mutex.js

const locks = new Map();

export const Mutex = {
    
    async runExclusive(key, task) {
        
        const currentLock = locks.get(key) || Promise.resolve();
        
        const nextLock = (async () => {
            try {
                await currentLock;
            } catch (error) {
                
            }
            return await task();
        })();

        locks.set(key, nextLock);

        const cleanup = () => {
            if (locks.get(key) === nextLock) {
                locks.delete(key);
            }
        };
        
        nextLock.then(cleanup, cleanup);

        return nextLock;
    },

    async runExclusiveMany(keys, task) {
        const uniqueKeys = [...new Set((keys || []).filter(Boolean))].sort();

        const runAt = (index) => {
            if (index >= uniqueKeys.length) {
                return task();
            }
            return this.runExclusive(uniqueKeys[index], () => runAt(index + 1));
        };

        return runAt(0);
    }
};