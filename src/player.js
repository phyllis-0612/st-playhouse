export class WebAudioPlayer extends EventTarget {
    constructor(gapSettings = {}) {
        super();
        this.ctx = null;
        this.unlocked = false;
        this.items = [];
        this.mode = 'full';
        this.cursor = -1;
        this.source = null;
        this.state = 'idle';
        this.decodePool = new Map();
        this.runId = 0;
        this.gaps = gapSettings;
    }

    ensureContext() {
        if (!this.ctx) {
            const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio API');
            this.ctx = new AudioContextClass();
        }
        return this.ctx;
    }

    unlockFromGesture() {
        const ctx = this.ensureContext();
        const resumed = ctx.resume();
        const silent = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = silent;
        source.connect(ctx.destination);
        source.start(0);
        source.onended = () => source.disconnect();
        this.unlocked = true;
        this.emit('unlock');
        return resumed;
    }

    setQueue(items, mode = this.mode) {
        this.stop();
        this.items = items ?? [];
        this.mode = mode;
        this.cursor = this.nextLegal(-1, 1);
        this.emit('queue');
    }

    replaceItems(items, { preserveCursor = true } = {}) {
        const previousCursor = this.cursor;
        this.stop();
        this.items = items ?? [];
        this.cursor = preserveCursor && this.isLegal(previousCursor) ? previousCursor : this.nextLegal(-1, 1);
        this.state = this.items.length ? 'paused' : 'idle';
        this.emit('queue');
        this.emit('state');
    }

    setMode(mode) {
        const previousIndex = this.cursor;
        const wasActive = this.state === 'playing' || this.state === 'loading';
        this.mode = mode === 'dialogue' ? 'dialogue' : 'full';
        if (this.cursor >= 0 && !this.isLegal(this.cursor)) this.cursor = this.nextLegal(this.cursor, 1) ?? this.nextLegal(this.items.length, -1);
        if (wasActive && this.cursor >= 0 && this.cursor !== previousIndex) void this.play(this.cursor);
        this.emit('mode');
    }

    isLegal(index) {
        return this.items[index] && (this.mode !== 'dialogue' || this.items[index].type === 'dialogue');
    }

    nextLegal(from, direction = 1) {
        for (let index = from + direction; index >= 0 && index < this.items.length; index += direction) if (this.isLegal(index)) return index;
        return -1;
    }

    async decode(index) {
        if (this.decodePool.has(index)) return this.decodePool.get(index);
        const item = this.items[index];
        if (!item?.blob) throw new Error(item?.error || '这一段没有音频');
        const promise = (async () => {
            const data = await item.blob.arrayBuffer();
            try { return await this.ensureContext().decodeAudioData(data.slice(0)); }
            catch { return await this.ensureContext().decodeAudioData(data.slice(0)); }
        })();
        this.decodePool.set(index, promise);
        return promise;
    }

    trimDecodePool(anchor) {
        const keep = new Set([anchor]);
        let index = anchor;
        for (let count = 0; count < 2; count++) {
            index = this.nextLegal(index, 1);
            if (index < 0) break;
            keep.add(index);
        }
        for (const index of this.decodePool.keys()) {
            if (!keep.has(index)) this.decodePool.delete(index);
        }
    }

    predecode(anchor) {
        let index = anchor;
        for (let count = 0; count < 2; count++) {
            index = this.nextLegal(index, 1);
            if (index < 0) break;
            void this.decode(index).catch(() => this.decodePool.delete(index));
        }
        this.trimDecodePool(anchor);
    }

    gapAfter(index) {
        const current = this.items[index];
        const nextIndex = this.nextLegal(index, 1);
        const next = this.items[nextIndex];
        let gap = current?.type === 'narration' ? Number(this.gaps.afterNarration || 300) : Number(this.gaps.afterDialogue || 200);
        if (current?.speaker !== next?.speaker) gap += Number(this.gaps.speakerSwitch || 0);
        return Math.max(0, gap) / 1000;
    }

    async play(index = this.cursor) {
        const ctx = this.ensureContext();
        if (!this.unlocked || ctx.state === 'suspended') {
            this.state = 'needs-gesture';
            this.emit('state');
            return false;
        }
        if (!this.isLegal(index)) index = this.nextLegal(index - 1, 1);
        if (index < 0) return false;
        this.stopSource();
        const runId = ++this.runId;
        this.state = 'loading';
        this.cursor = index;
        this.emit('segment');
        let buffer;
        try { buffer = await this.decode(index); }
        catch (error) {
            this.items[index].error ||= error.message;
            this.emit('error', { index, error });
            return this.play(this.nextLegal(index, 1));
        }
        if (runId !== this.runId) return false;
        const source = ctx.createBufferSource();
        this.source = source;
        source.buffer = buffer;
        source.connect(ctx.destination);
        const startAt = ctx.currentTime + 0.02;
        source.start(startAt);
        this.state = 'playing';
        this.emit('state');
        this.predecode(index);
        source.onended = () => {
            source.disconnect();
            if (this.source === source) this.source = null;
            this.decodePool.delete(index);
            if (runId !== this.runId || this.state !== 'playing') return;
            const next = this.nextLegal(index, 1);
            if (next < 0) {
                this.state = 'ended';
                this.emit('state');
                return;
            }
            void this.scheduleNext(next, ctx.currentTime + this.gapAfter(index), runId);
        };
        return true;
    }

    async scheduleNext(index, startAt, runId) {
        if (index < 0) {
            this.state = 'ended';
            this.emit('state');
            return;
        }
        let buffer;
        try { buffer = await this.decode(index); }
        catch (error) {
            this.items[index].error ||= error.message;
            this.emit('error', { index, error });
            return this.scheduleNext(this.nextLegal(index, 1), startAt, runId);
        }
        if (runId !== this.runId) return;
        const source = this.ensureContext().createBufferSource();
        this.source = source;
        this.cursor = index;
        this.emit('segment');
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        source.start(Math.max(startAt, this.ctx.currentTime + 0.01));
        this.predecode(index);
        source.onended = () => {
            source.disconnect();
            if (this.source === source) this.source = null;
            this.decodePool.delete(index);
            if (runId !== this.runId || this.state !== 'playing') return;
            const next = this.nextLegal(index, 1);
            if (next < 0) {
                this.state = 'ended';
                this.emit('state');
            } else {
                void this.scheduleNext(next, this.ctx.currentTime + this.gapAfter(index), runId);
            }
        };
    }

    pause() {
        this.stopSource();
        this.state = 'paused';
        this.emit('state');
    }

    stopSource() {
        if (!this.source) return;
        try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
        this.source.disconnect();
        this.source = null;
    }

    stop() {
        this.runId++;
        this.stopSource();
        this.decodePool.clear();
        this.state = 'idle';
        this.emit('state');
    }

    previous() {
        const index = this.nextLegal(this.cursor, -1);
        if (index >= 0) return this.play(index);
    }

    next() {
        const index = this.nextLegal(this.cursor, 1);
        if (index >= 0) return this.play(index);
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
