const DB_NAME = 'st-playhouse';
const STORE_NAME = 'audio';

export class AudioCache {
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.maxMB = Number(options.maxMB) || 200;
        this.db = null;
        this.available = true;
    }

    async init() {
        if (!this.enabled || !globalThis.indexedDB) {
            this.available = false;
            return false;
        }
        this.available = true;
        try {
            this.db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                        store.createIndex('lastUsed', 'lastUsed');
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            return true;
        } catch (error) {
            console.warn('[梨园] IndexedDB 不可用，已降级为无缓存模式', error);
            this.available = false;
            return false;
        }
    }

    transaction(mode, callback) {
        if (!this.enabled || !this.available || !this.db) return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction(STORE_NAME, mode);
                const store = tx.objectStore(STORE_NAME);
                const request = callback(store);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        }).catch(error => {
            console.warn('[梨园] 缓存操作失败，继续无缓存播放', error);
            return null;
        });
    }

    async get(key) {
        const record = await this.transaction('readonly', store => store.get(key));
        if (!record?.blob) return null;
        record.lastUsed = Date.now();
        void this.transaction('readwrite', store => store.put(record));
        return record.blob;
    }

    async put(key, blob) {
        if (!blob) return;
        await this.transaction('readwrite', store => store.put({ key, blob, size: blob.size, lastUsed: Date.now() }));
        await this.evict();
    }

    async list() {
        return (await this.transaction('readonly', store => store.getAll())) ?? [];
    }

    async usage() {
        const records = await this.list();
        return { bytes: records.reduce((sum, item) => sum + (Number(item.size) || 0), 0), count: records.length };
    }

    async evict() {
        const records = await this.list();
        const limit = this.maxMB * 1024 * 1024;
        let total = records.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        if (total <= limit) return;
        for (const record of records.sort((a, b) => a.lastUsed - b.lastUsed)) {
            await this.transaction('readwrite', store => store.delete(record.key));
            total -= record.size;
            if (total <= limit) break;
        }
    }

    async clear() {
        await this.transaction('readwrite', store => store.clear());
    }
}
