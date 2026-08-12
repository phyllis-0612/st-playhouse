import { joinApiUrl } from './utils.js';

export const CLONE_FILE_LIMIT = 20 * 1024 * 1024;
export const CLONE_MIN_SECONDS = 10;
export const CLONE_MAX_SECONDS = 5 * 60;

const VOICE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/;
const AUDIO_EXTENSION_PATTERN = /\.(mp3|m4a|wav)$/i;

export function validateVoiceId(voiceId) {
    const value = String(voiceId ?? '').trim();
    if (!VOICE_ID_PATTERN.test(value)) {
        throw new Error('Voice ID 需为 8–256 位，以英文字母开头，可含字母、数字、-、_，且不能以 - 或 _ 结尾');
    }
    return value;
}

export function validateCloneFile(file, duration = null) {
    if (!file) throw new Error('请选择要复刻的音频');
    if (!AUDIO_EXTENSION_PATTERN.test(String(file.name ?? ''))) throw new Error('只支持 mp3、m4a、wav 音频');
    if (Number(file.size) > CLONE_FILE_LIMIT) throw new Error('音频不能超过 20 MB');
    if (Number.isFinite(duration) && (duration < CLONE_MIN_SECONDS || duration > CLONE_MAX_SECONDS)) {
        throw new Error('音频时长需在 10 秒到 5 分钟之间');
    }
    return file;
}

export async function readAudioDuration(file, timeoutMs = 10000) {
    if (typeof Audio !== 'function' || !globalThis.URL?.createObjectURL) return null;
    const url = URL.createObjectURL(file);
    try {
        return await new Promise(resolve => {
            const audio = new Audio();
            const done = value => {
                clearTimeout(timer);
                audio.removeAttribute('src');
                audio.load?.();
                resolve(value);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            audio.preload = 'metadata';
            audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
            audio.onerror = () => done(null);
            audio.src = url;
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

function buildMiniMaxUrl(settings, path) {
    const url = new URL(joinApiUrl(settings.baseUrl, path));
    if (String(settings.groupId ?? '').trim()) url.searchParams.set('GroupId', String(settings.groupId).trim());
    return url.href;
}

export function buildCloneUrl(settings, path) {
    return buildMiniMaxUrl(settings, path);
}

async function parseMiniMaxResponse(response) {
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`MiniMax 返回了无法解析的响应（HTTP ${response.status}）`); }
    const statusCode = Number(payload?.base_resp?.status_code ?? 0);
    if (!response.ok || statusCode !== 0) throw new Error(payload?.base_resp?.status_msg || `MiniMax HTTP ${response.status}`);
    return { payload, raw };
}

function exactFileId(raw, payload) {
    const match = String(raw).match(/"file_id"\s*:\s*"?(\d+)"?/);
    const value = match?.[1] || String(payload?.file?.file_id ?? '');
    if (!/^\d+$/.test(value)) throw new Error('MiniMax 没有返回有效的 file_id');
    return value;
}

export function buildCloneBody(fileId, options) {
    const voiceId = validateVoiceId(options.voiceId);
    if (!/^\d+$/.test(String(fileId))) throw new Error('无效的复刻文件 ID');
    const marker = '__PLAYHOUSE_FILE_ID__';
    const body = {
        file_id: marker,
        voice_id: voiceId,
        need_noise_reduction: Boolean(options.noiseReduction),
        need_volume_normalization: Boolean(options.volumeNormalization),
        aigc_watermark: false,
    };
    return JSON.stringify(body).replace(`"${marker}"`, String(fileId));
}

export class VoiceCloneService {
    constructor(settings) {
        this.settings = settings;
    }

    requireKey() {
        if (!this.settings?.apiKey) throw new Error('请先在“设置 → 语音服务”保存 MiniMax API Key');
    }

    async upload(file, { signal, onProgress } = {}) {
        this.requireKey();
        validateCloneFile(file);
        onProgress?.('正在上传复刻音频…');
        const form = new FormData();
        form.append('purpose', 'voice_clone');
        form.append('file', file, file.name);
        const response = await fetch(buildMiniMaxUrl(this.settings, '/v1/files/upload'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.settings.apiKey}` },
            body: form,
            signal,
        });
        const { payload, raw } = await parseMiniMaxResponse(response);
        return exactFileId(raw, payload);
    }

    async clone(fileId, options, { signal, onProgress } = {}) {
        this.requireKey();
        onProgress?.('音频已上传，正在创建音色…');
        const response = await fetch(buildMiniMaxUrl(this.settings, '/v1/voice_clone'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.settings.apiKey}` },
            body: buildCloneBody(fileId, options),
            signal,
        });
        const { payload } = await parseMiniMaxResponse(response);
        return { voiceId: validateVoiceId(options.voiceId), demoAudio: payload?.demo_audio || '' };
    }

    async create(file, options, controls = {}) {
        const duration = await readAudioDuration(file);
        validateCloneFile(file, duration);
        controls.onProgress?.(Number.isFinite(duration) ? `音频检查通过 · ${duration.toFixed(1)} 秒` : '浏览器未读到时长，将由 MiniMax 校验');
        const fileId = await this.upload(file, controls);
        return this.clone(fileId, options, controls);
    }
}

export const __test = { exactFileId };
