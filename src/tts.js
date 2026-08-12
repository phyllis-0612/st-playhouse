import { joinApiUrl, sha1 } from './utils.js';

class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, Number(limit) || 1);
        this.active = 0;
        this.waiters = [];
    }
    async use(task) {
        if (this.active >= this.limit) await new Promise(resolve => this.waiters.push(resolve));
        this.active++;
        try { return await task(); }
        finally {
            this.active--;
            this.waiters.shift()?.();
        }
    }
}

export function buildTtsUrl(settings) {
    const url = new URL(joinApiUrl(settings.baseUrl, '/v1/t2a_v2'));
    if (String(settings.groupId ?? '').trim()) url.searchParams.set('GroupId', String(settings.groupId).trim());
    return url.href;
}

export function buildTtsBody(segment, settings) {
    return {
        model: settings.model || 'speech-02-hd',
        text: segment.text,
        stream: false,
        output_format: 'hex',
        language_boost: 'auto',
        voice_setting: {
            voice_id: segment.voiceId,
            speed: Math.min(2, Math.max(0.5, Number(segment.speed || 1) * Number(settings.globalSpeed || 1))),
            vol: 1,
            pitch: 0,
            emotion: segment.emotion || 'calm',
        },
        audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
    };
}

function hexToBlob(hex) {
    if (!hex || typeof hex !== 'string' || hex.length % 2 !== 0) throw new Error('MiniMax 没有返回有效音频');
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return new Blob([bytes], { type: 'audio/mpeg' });
}

export class MiniMaxAdapter {
    constructor(settings) { this.settings = settings; }
    async synthesize(segment, { signal } = {}) {
        if (!this.settings.apiKey) throw new Error('请先填写 MiniMax API Key');
        if (!segment.voiceId) throw new Error(`「${segment.speaker || '旁白'}」没有可用音色`);
        const response = await fetch(buildTtsUrl(this.settings), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.apiKey}` },
            body: JSON.stringify(buildTtsBody(segment, this.settings)),
            signal,
        });
        const payload = await response.json().catch(() => null);
        const statusCode = Number(payload?.base_resp?.status_code ?? 0);
        if (!response.ok || statusCode !== 0) throw new Error(payload?.base_resp?.status_msg || `MiniMax HTTP ${response.status}`);
        return hexToBlob(payload?.data?.audio);
    }
}

export class TtsService {
    constructor(settings, cache) {
        this.settings = settings;
        this.cache = cache;
        this.adapter = new MiniMaxAdapter(settings);
        this.semaphore = new Semaphore(settings.concurrency);
    }

    async keyFor(segment) {
        return sha1([segment.text, segment.voiceId, segment.speed, segment.emotion, this.settings.model].join('\u241f'));
    }

    async synthesizeSegment(segment, { signal } = {}) {
        const audioKey = await this.keyFor(segment);
        const cached = await this.cache?.get(audioKey);
        if (cached) return { ...segment, audioKey, blob: cached, cached: true };
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const blob = await this.semaphore.use(() => this.adapter.synthesize(segment, { signal }));
                await this.cache?.put(audioKey, blob);
                return { ...segment, audioKey, blob, cached: false };
            } catch (error) {
                lastError = error;
                if (signal?.aborted) throw error;
            }
        }
        return { ...segment, audioKey, error: lastError?.message || '合成失败' };
    }

    synthesizeAll(segments, options) {
        return Promise.all(segments.map(segment => this.synthesizeSegment(segment, options)));
    }
}

export const __test = { Semaphore, hexToBlob };
