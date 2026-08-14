import { buildBackgroundTrack, gapBetweenMs } from './background-audio.js';

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
        this.backgroundEnabled = false;
        this.backgroundGeneration = 0;
        this.backgroundPromise = null;
        this.backgroundTrack = null;
        this.backgroundUrl = '';
        this.backgroundMetadata = {};
        this.media = null;
    }

    ensureContext() {
        if (!this.ctx) {
            const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio API');
            this.ctx = new AudioContextClass();
        }
        return this.ctx;
    }

    ensureMediaElement() {
        if (this.media) return this.media;
        if (!globalThis.document) throw new Error('当前环境不支持后台媒体播放');
        const media = document.createElement('audio');
        media.id = 'playhouse_background_audio';
        media.preload = 'auto';
        media.hidden = true;
        media.setAttribute('playsinline', '');
        media.setAttribute('aria-hidden', 'true');
        document.body.append(media);
        media.addEventListener('play', () => {
            this.state = 'playing';
            this.setMediaSessionState('playing');
            this.emit('state');
        });
        media.addEventListener('pause', () => {
            if (this.state === 'idle' || this.state === 'ended' || this.state === 'preparing') return;
            this.state = 'paused';
            this.setMediaSessionState('paused');
            this.emit('state');
        });
        media.addEventListener('waiting', () => {
            if (this.state !== 'idle') {
                this.state = 'loading';
                this.emit('state');
            }
        });
        media.addEventListener('timeupdate', () => this.syncBackgroundCursor());
        media.addEventListener('ended', () => {
            this.state = 'ended';
            this.setMediaSessionState('none');
            this.emit('state');
        });
        this.media = media;
        this.installMediaSessionHandlers();
        return media;
    }

    installMediaSessionHandlers() {
        const session = globalThis.navigator?.mediaSession;
        if (!session) return;
        const install = (action, handler) => {
            try { session.setActionHandler(action, handler); } catch { /* action unsupported */ }
        };
        install('play', () => void this.playBackground());
        install('pause', () => this.pause());
        install('stop', () => this.stop());
        install('previoustrack', () => this.previous());
        install('nexttrack', () => this.next());
        install('seekbackward', detail => this.seekBackground(this.media.currentTime - Number(detail.seekOffset || 10)));
        install('seekforward', detail => this.seekBackground(this.media.currentTime + Number(detail.seekOffset || 10)));
        install('seekto', detail => this.seekBackground(Number(detail.seekTime || 0)));
    }

    setMediaSessionState(state) {
        const session = globalThis.navigator?.mediaSession;
        if (!session) return;
        try { session.playbackState = state; } catch { /* unsupported */ }
    }

    setMediaMetadata(metadata = {}) {
        this.backgroundMetadata = { ...this.backgroundMetadata, ...metadata };
        const session = globalThis.navigator?.mediaSession;
        if (!session || !globalThis.MediaMetadata) return;
        try {
            session.metadata = new MediaMetadata({
                title: this.backgroundMetadata.title || '当前楼层',
                artist: this.backgroundMetadata.artist || '梨园·PlayHouse',
                album: this.backgroundMetadata.album || '正文朗读',
            });
        } catch { /* metadata unsupported */ }
    }

    updateMediaPosition() {
        const session = globalThis.navigator?.mediaSession;
        const media = this.media;
        const duration = this.backgroundTrack?.duration;
        if (!session?.setPositionState || !media || !Number.isFinite(duration) || duration <= 0) return;
        try {
            session.setPositionState({
                duration,
                playbackRate: media.playbackRate || 1,
                position: Math.max(0, Math.min(media.currentTime || 0, duration)),
            });
        } catch { /* position state unsupported */ }
    }

    syncBackgroundCursor() {
        const cues = this.backgroundTrack?.cues;
        if (!cues?.length || !this.media) return;
        const time = this.media.currentTime;
        let active = cues[0];
        for (const cue of cues) {
            if (cue.start > time) break;
            active = cue;
        }
        if (active.index !== this.cursor) {
            this.cursor = active.index;
            this.emit('segment');
        }
        this.updateMediaPosition();
    }

    seekBackground(seconds) {
        if (!this.media || !this.backgroundTrack) return;
        this.media.currentTime = Math.max(0, Math.min(Number(seconds) || 0, this.backgroundTrack.duration));
        this.syncBackgroundCursor();
    }

    invalidateBackground() {
        this.backgroundGeneration++;
        this.backgroundPromise = null;
        this.backgroundTrack = null;
        if (this.backgroundUrl) URL.revokeObjectURL(this.backgroundUrl);
        this.backgroundUrl = '';
        if (this.media) {
            this.media.removeAttribute('src');
            this.media.load();
        }
    }

    setBackgroundEnabled(enabled) {
        const next = Boolean(enabled);
        if (next === this.backgroundEnabled) return;
        this.stop();
        this.backgroundEnabled = next;
        this.invalidateBackground();
        this.emit('background');
    }

    setGaps(gaps = {}) {
        this.gaps = gaps;
        if (this.backgroundEnabled && this.items.length) {
            this.stop();
            this.invalidateBackground();
        }
    }

    async prepareBackground(metadata = this.backgroundMetadata) {
        if (!this.backgroundEnabled || !this.items.length) return false;
        if (this.backgroundTrack) {
            this.setMediaMetadata(metadata);
            return true;
        }
        if (this.backgroundPromise) return this.backgroundPromise;
        const generation = this.backgroundGeneration;
        this.state = 'preparing';
        this.emit('state');
        this.backgroundPromise = (async () => {
            try {
                const track = await buildBackgroundTrack(this.items, {
                    mode: this.mode,
                    gaps: this.gaps,
                    decode: index => this.decode(index),
                });
                if (generation !== this.backgroundGeneration || !this.backgroundEnabled) return false;
                const media = this.ensureMediaElement();
                if (this.backgroundUrl) URL.revokeObjectURL(this.backgroundUrl);
                this.backgroundUrl = URL.createObjectURL(track.blob);
                this.backgroundTrack = track;
                media.src = this.backgroundUrl;
                media.load();
                this.cursor = track.cues[0]?.index ?? -1;
                this.decodePool.clear();
                this.setMediaMetadata(metadata);
                this.state = 'ready';
                this.emit('queue');
                this.emit('state');
                return true;
            } catch (error) {
                if (generation !== this.backgroundGeneration) return false;
                this.state = 'error';
                this.emit('state');
                throw error;
            } finally {
                if (generation === this.backgroundGeneration) this.backgroundPromise = null;
            }
        })();
        return this.backgroundPromise;
    }

    unlockFromGesture() {
        if (this.backgroundEnabled) return Promise.resolve();
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
        this.invalidateBackground();
        this.emit('queue');
    }

    replaceItems(items, { preserveCursor = true } = {}) {
        const previousCursor = this.cursor;
        this.stop();
        this.items = items ?? [];
        this.cursor = preserveCursor && this.isLegal(previousCursor) ? previousCursor : this.nextLegal(-1, 1);
        this.state = this.items.length ? 'paused' : 'idle';
        this.invalidateBackground();
        this.emit('queue');
        this.emit('state');
    }

    setMode(mode) {
        const nextMode = mode === 'dialogue' ? 'dialogue' : 'full';
        if (nextMode === this.mode) {
            this.emit('mode');
            return;
        }
        const previousIndex = this.cursor;
        const wasActive = this.state === 'playing' || this.state === 'loading';
        this.mode = nextMode;
        if (this.cursor >= 0 && !this.isLegal(this.cursor)) this.cursor = this.nextLegal(this.cursor, 1) ?? this.nextLegal(this.items.length, -1);
        if (this.backgroundEnabled) {
            this.stop();
            this.invalidateBackground();
        } else if (wasActive && this.cursor >= 0 && this.cursor !== previousIndex) void this.play(this.cursor);
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
        return gapBetweenMs(current, next, this.gaps) / 1000;
    }

    async play(index) {
        if (this.backgroundEnabled) return this.playBackground(index);
        if (index === undefined) index = this.cursor;
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

    async playBackground(index) {
        if (!this.backgroundTrack) {
            void this.prepareBackground().catch(() => {});
            return false;
        }
        const media = this.ensureMediaElement();
        if (Number.isInteger(index)) {
            const cue = this.backgroundTrack.cues.find(entry => entry.index === index);
            if (cue) media.currentTime = cue.start;
        } else if (media.ended || this.state === 'ended') {
            media.currentTime = 0;
        }
        try {
            this.state = 'loading';
            this.emit('state');
            const playPromise = media.play();
            await playPromise;
            this.state = 'playing';
            this.setMediaSessionState('playing');
            this.emit('state');
            return true;
        } catch (error) {
            this.state = error?.name === 'NotAllowedError' ? 'needs-gesture' : 'error';
            this.emit('state');
            if (this.state === 'error') this.emit('error', { index: this.cursor, error });
            return false;
        }
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
        if (this.backgroundEnabled) {
            this.media?.pause();
            this.state = 'paused';
            this.setMediaSessionState('paused');
            this.emit('state');
            return;
        }
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
        if (this.media) {
            this.media.pause();
            try { this.media.currentTime = 0; } catch { /* no source yet */ }
        }
        this.decodePool.clear();
        this.state = 'idle';
        this.setMediaSessionState('none');
        this.emit('state');
    }

    previous() {
        const index = this.nextLegal(this.cursor, -1);
        if (index >= 0) return this.play(index);
        if (this.backgroundEnabled && this.cursor >= 0) return this.play(this.cursor);
    }

    next() {
        const index = this.nextLegal(this.cursor, 1);
        if (index >= 0) return this.play(index);
    }

    emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
