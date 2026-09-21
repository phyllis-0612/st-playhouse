import { joinApiUrl, sha1 } from './utils.js';
import { SPEECH_28_SOUND_TAGS, supportsSpeech28SoundTags } from './constants.js';

class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, Number(limit) || 1);
        this.active = 0;
        this.waiters = [];
    }
    setLimit(limit) {
        this.limit = Math.max(1, Number(limit) || 1);
        this.drain();
    }
    drain() {
        while (this.waiters.length && this.active < this.limit) {
            this.active++;
            this.waiters.shift()();
        }
    }
    async use(task) {
        if (this.active >= this.limit) await new Promise(resolve => this.waiters.push(resolve));
        else this.active++;
        try { return await task(); }
        finally {
            this.active--;
            this.drain();
        }
    }
}

const RETRY_DELAYS = Object.freeze([800, 2000, 5000]);

function wait(ms, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', abort);
            resolve();
        }
        function abort() {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}

export function classifyTtsError({ httpStatus = 0, statusCode = 0, message = '' } = {}) {
    const text = String(message).toLowerCase();
    const code = Number(statusCode) || 0;
    const http = Number(httpStatus) || 0;
    let kind = 'request';
    let retryable = false;
    if (!http && !code && /network|fetch|load failed|连接|网络|timeout|超时/.test(text)) {
        kind = 'network'; retryable = true;
    } else if (http === 408 || code === 1001 || /timeout|超时/.test(text)) {
        kind = 'timeout'; retryable = true;
    } else if (http === 429 || [1002, 1041, 2045].includes(code) || /rate.?limit|too many|频率|限流|并发/.test(text)) {
        kind = 'rate_limit'; retryable = true;
    } else if (http >= 500 || [1000, 1024, 1033].includes(code) || /service unavailable|internal server|服务繁忙|服务异常/.test(text)) {
        kind = 'server'; retryable = true;
    } else if ([401, 403].includes(http) || [1004, 2049].includes(code) || /api.?key|unauthor|forbidden|鉴权|密钥/.test(text)) {
        kind = 'auth';
    } else if ([1008, 2056].includes(code) || /usage limit|quota|余额|balance|额度|欠费/.test(text)) {
        kind = 'quota';
    } else if ([20132, 2039, 2042].includes(code) || /voice.?id|音色|声音/.test(text)) {
        kind = 'voice';
    } else if ([1026, 1027].includes(code) || /sensitive|moderation|risk|审核|敏感|违规/.test(text)) {
        kind = 'safety';
    }
    const labels = {
        network: '网络连接失败', timeout: '请求超时', rate_limit: '请求过于频繁', server: 'MiniMax 服务暂时异常',
        auth: 'MiniMax 密钥或权限无效', quota: 'MiniMax 额度或用量受限', voice: '音色不可用', safety: '内容未通过审核', request: '语音合成失败',
    };
    return { kind, retryable, label: labels[kind], httpStatus: http, statusCode: code, rawMessage: String(message || '') };
}

function ttsError(message, meta = {}) {
    const classified = classifyTtsError({ ...meta, message });
    const error = new Error(classified.rawMessage ? `${classified.label}：${classified.rawMessage}` : classified.label);
    Object.assign(error, classified);
    return error;
}

export function buildTtsUrl(settings) {
    const url = new URL(joinApiUrl(settings.baseUrl, '/v1/t2a_v2'));
    if (String(settings.groupId ?? '').trim()) url.searchParams.set('GroupId', String(settings.groupId).trim());
    return url.href;
}

export function effectiveTtsText(segment, model) {
    const original = String(segment.text ?? '');
    if (!supportsSpeech28SoundTags(model) || typeof segment.ttsText !== 'string') return original;
    const tags = SPEECH_28_SOUND_TAGS.map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const stripped = segment.ttsText.replace(new RegExp(`\\((?:${tags})\\)`, 'g'), '');
    return stripped === original ? segment.ttsText : original;
}

export function buildTtsBody(segment, settings) {
    const model = settings.model || 'speech-2.8-hd';
    const speed = Math.min(2, Math.max(0.5, Number(segment.speed || 1) * Number(settings.globalSpeed || 1)));
    const pitch = Math.min(12, Math.max(-12, Number(segment.pitch) || 0));
    return {
        model,
        text: effectiveTtsText(segment, model),
        stream: false,
        output_format: 'hex',
        language_boost: 'auto',
        voice_setting: {
            voice_id: segment.voiceId,
            speed,
            vol: 1,
            pitch,
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
        let response;
        try {
            response = await fetch(buildTtsUrl(this.settings), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.apiKey}` },
                body: JSON.stringify(buildTtsBody(segment, this.settings)),
                signal,
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw ttsError(error.message || '浏览器无法连接 MiniMax');
        }
        const payload = await response.json().catch(() => null);
        const statusCode = Number(payload?.base_resp?.status_code ?? 0);
        if (!response.ok || statusCode !== 0) {
            throw ttsError(payload?.base_resp?.status_msg || `HTTP ${response.status}`, { httpStatus: response.status, statusCode });
        }
        try { return hexToBlob(payload?.data?.audio); }
        catch (error) { throw ttsError(error.message, { httpStatus: response.status, statusCode }); }
    }
}

export class TtsService {
    constructor(settings, cache, options = {}) {
        this.settings = settings;
        this.cache = cache;
        this.adapter = new MiniMaxAdapter(settings);
        this.semaphore = new Semaphore(settings.concurrency);
        this.effectiveConcurrency = this.semaphore.limit;
        this.retryDelays = options.retryDelays ?? RETRY_DELAYS;
    }

    async keyFor(segment) {
        const body = buildTtsBody(segment, this.settings);
        return sha1([
            body.text,
            segment.voiceId,
            body.voice_setting.speed,
            body.voice_setting.pitch,
            body.voice_setting.emotion,
            body.model,
            this.settings.baseUrl || '',
            this.settings.groupId || '',
        ].join('\u241f'));
    }

    reduceConcurrency() {
        const next = Math.max(1, Math.floor(this.effectiveConcurrency / 2));
        this.effectiveConcurrency = next;
        this.semaphore.setLimit(next);
        return next;
    }

    async synthesizeSegment(segment, { signal, force = false, onRetry } = {}) {
        const audioKey = await this.keyFor(segment);
        const base = { ...segment };
        for (const key of ['blob', 'cached', 'error', 'errorKind', 'errorCode', 'retryable', 'retryMessage', 'regenerating', 'attempts']) delete base[key];
        const cached = force ? null : await this.cache?.get(audioKey);
        if (cached) return { ...base, audioKey, blob: cached, cached: true, attempts: 0 };
        let lastError;
        let attempts = 0;
        for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
            attempts = attempt + 1;
            try {
                const blob = await this.semaphore.use(() => this.adapter.synthesize(segment, { signal }));
                await this.cache?.put(audioKey, blob);
                const clean = { ...base, audioKey, blob, cached: false, attempts };
                delete clean.error;
                delete clean.errorKind;
                delete clean.errorCode;
                delete clean.retryable;
                return clean;
            } catch (error) {
                lastError = error;
                if (signal?.aborted || error.name === 'AbortError') throw error;
                const detail = error.kind ? error : ttsError(error.message || '未知错误');
                if (!detail.retryable || attempt >= this.retryDelays.length) break;
                const concurrency = detail.kind === 'rate_limit' ? this.reduceConcurrency() : this.effectiveConcurrency;
                const delay = this.retryDelays[attempt];
                onRetry?.({ attempt: attempt + 1, nextAttempt: attempt + 2, delay, error: detail, concurrency });
                await wait(delay, signal);
            }
        }
        const detail = lastError?.kind ? lastError : classifyTtsError({ message: lastError?.message || '合成失败' });
        return {
            ...base,
            audioKey,
            error: lastError?.message || detail.label,
            errorKind: detail.kind,
            errorCode: detail.statusCode || detail.httpStatus || 0,
            retryable: detail.retryable,
            attempts,
        };
    }

    synthesizeAll(segments, options) {
        return Promise.all(segments.map(segment => this.synthesizeSegment(segment, options)));
    }
}

export const __test = { Semaphore, hexToBlob, wait, ttsError, RETRY_DELAYS };
