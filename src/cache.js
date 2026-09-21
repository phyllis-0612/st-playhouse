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
        if (!globalThis.indexedDB) {
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
        if (!this.available || !this.db) return Promise.resolve(null);
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
        if (!this.enabled) return null;
        const record = await this.transaction('readonly', store => store.get(key));
        if (!record?.blob) return null;
        record.lastUsed = Date.now();
        void this.transaction('readwrite', store => store.put(record));
        return record.blob;
    }

    async put(key, blob) {
        if (!this.enabled || !blob) return;
        const now = Date.now();
        await this.transaction('readwrite', store => store.put({ key, blob, size: blob.size, createdAt: now, lastUsed: now }));
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
        return this.pruneToSize(this.maxMB);
    }

    async deleteRecords(records, totalBytes) {
        let freedBytes = 0;
        for (const record of records) {
            await this.transaction('readwrite', store => store.delete(record.key));
            freedBytes += Number(record.size) || 0;
        }
        return {
            removed: records.length,
            freedBytes,
            remainingBytes: Math.max(0, totalBytes - freedBytes),
        };
    }

    async pruneByAge(days, now = Date.now()) {
        const records = await this.list();
        const safeDays = Math.max(1, Number(days) || 1);
        const cutoff = now - safeDays * 24 * 60 * 60 * 1000;
        const stale = records.filter(record => Number(record.createdAt ?? record.lastUsed ?? 0) < cutoff);
        const total = records.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        return this.deleteRecords(stale, total);
    }

    async pruneToSize(maxMB) {
        const records = await this.list();
        const limit = Math.max(0, Number(maxMB) || 0) * 1024 * 1024;
        const total = records.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        let remaining = total;
        const victims = [];
        for (const record of records.sort((a, b) => Number(a.lastUsed || 0) - Number(b.lastUsed || 0))) {
            if (remaining <= limit) break;
            victims.push(record);
            remaining -= Number(record.size) || 0;
        }
        return this.deleteRecords(victims, total);
    }

    async clear() {
        await this.transaction('readwrite', store => store.clear());
    }
}
