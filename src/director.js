import { emotionOptionsForModel, normalizeTtsEmotion, SPEECH_28_SOUND_TAGS, supportsSpeech28SoundTags } from './constants.js';
import { clamp, joinApiUrl, normalizePitch } from './utils.js';

const ALLOWED_GENDERS = new Set(['male', 'female', 'unknown']);
const ALLOWED_AGES = new Set(['young', 'mature', 'child', 'unknown']);
const ALLOWED_TONES = new Set(['clear', 'warm', 'cold', 'calm', 'deep', 'bright', 'soft', 'unknown']);
const ALLOWED_SOUND_TAGS = new Set(SPEECH_28_SOUND_TAGS);
const MAX_EFFECTS_PER_SEGMENT = 2;

class DirectorFormatError extends Error {
    constructor(message = '分轨模型返回格式异常') {
        super(message);
        this.name = 'DirectorFormatError';
    }
}

function findArrayEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '[') depth++;
        else if (char === ']' && --depth === 0) return index;
    }
    return -1;
}

function extractJsonArray(value) {
    const text = String(value ?? '').trim();
    let sawArray = false;
    for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
        const end = findArrayEnd(text, start);
        if (end < 0) continue;
        sawArray = true;
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(parsed)) return parsed;
        } catch { /* Try the next complete array in the response. */ }
    }
    throw new DirectorFormatError(sawArray
        ? '分轨模型返回格式异常：没有找到可解析的 JSON 数组'
        : '分轨模型没有返回 JSON 数组');
}

function normalizeSoundEffects(rawEffects, text, enabled) {
    if (!enabled || !Array.isArray(rawEffects)) return [];
    const normalized = [];
    for (const item of rawEffects) {
        if (normalized.length >= MAX_EFFECTS_PER_SEGMENT) break;
        const tag = String(item?.tag ?? '').trim().toLowerCase().replace(/^\(|\)$/g, '');
        const position = item?.position === 'before' ? 'before' : 'after';
        const anchor = typeof item?.anchor === 'string' ? item.anchor.trim() : '';
        if (!ALLOWED_SOUND_TAGS.has(tag) || !anchor) continue;
        if (text.indexOf(anchor) < 0 || text.indexOf(anchor) !== text.lastIndexOf(anchor)) continue;
        normalized.push({ tag, position, anchor });
    }
    return normalized;
}

export function applySoundEffects(text, effects = []) {
    const source = String(text ?? '');
    const insertions = effects.map((effect, order) => {
        if (!ALLOWED_SOUND_TAGS.has(effect?.tag)) return null;
        const anchor = String(effect.anchor ?? '');
        if (!anchor || source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) return null;
        const offset = source.indexOf(anchor) + (effect.position === 'before' ? 0 : anchor.length);
        return { offset, order, value: `(${effect.tag})` };
    }).filter(Boolean).sort((a, b) => b.offset - a.offset || b.order - a.order);
    return insertions.reduce((result, insertion) => (
        result.slice(0, insertion.offset) + insertion.value + result.slice(insertion.offset)
    ), source);
}

export function normalizeDirectorResult(localSegments, raw, { ttsModel = '' } = {}) {
    const parsed = Array.isArray(raw) ? raw : extractJsonArray(raw);
    const byIndex = new Map(parsed.filter(item => Number.isInteger(Number(item?.idx))).map(item => [Number(item.idx), item]));
    const soundEffectsEnabled = supportsSpeech28SoundTags(ttsModel);
    return localSegments.map(local => {
        const item = byIndex.get(local.idx) ?? {};
        const dialogue = item.type === 'dialogue' || (item.type !== 'narration' && local.type === 'dialogue');
        const speaker = dialogue && typeof item.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : null;
        const emotion = normalizeTtsEmotion(item.emotion, ttsModel) || 'calm';
        const effects = normalizeSoundEffects(item.effects, local.text, soundEffectsEnabled);
        return {
            idx: local.idx,
            type: dialogue && speaker ? 'dialogue' : 'narration',
            speaker: dialogue && speaker ? speaker : null,
            text: local.text,
            gender: ALLOWED_GENDERS.has(item.gender) ? item.gender : 'unknown',
            ageTag: ALLOWED_AGES.has(item.ageTag) ? item.ageTag : 'unknown',
            toneTag: ALLOWED_TONES.has(item.toneTag) ? item.toneTag : 'unknown',
            emotion,
            speed: clamp(item.speed, 0.5, 2, 1),
            pitch: normalizePitch(item.pitch),
            effects,
            ttsText: applySoundEffects(local.text, effects),
        };
    });
}

function directorPrompt(knownSpeakers, ttsModel = '') {
    const soundEffectsEnabled = supportsSpeech28SoundTags(ttsModel);
    const emotionOptions = emotionOptionsForModel(ttsModel);
    const lines = [
        '你是小说朗读分轨导演。只返回 JSON 数组，不要 markdown，不要解释。',
        '输入中的正文已由前端切分。你只返回元数据，严禁返回 text/content/正文。',
        `已知角色：${knownSpeakers.filter(Boolean).join('、') || '无'}。speaker 优先且严格复用已知角色名；只有明确出现新名字才新建。`,
        `每项格式：{"idx":0,"type":"narration|dialogue","speaker":null或名字,"gender":"male|female|unknown","ageTag":"young|mature|child|unknown","toneTag":"clear|warm|cold|calm|deep|bright|soft|unknown","emotion":"${emotionOptions.join('|')}","speed":0.5到2,"pitch":-12到12的整数,"effects":[]}`,
        'speed 与 pitch 必须克制微调：默认 speed=1、pitch=0；pitch 只能是整数。通常 speed 使用 0.75 到 1.3、pitch 使用 -2 到 2，只有正文明确要求极端声音时才扩大。',
        '引号内通常是台词；引号外、动作和环境描写通常是旁白。无法判断时用 narration、speaker=null、emotion=calm、speed=1、pitch=0、effects=[]。',
    ];
    if (soundEffectsEnabled) {
        lines.push(
            `当前语音模型 ${ttsModel} 支持拟声标签。effects 每项格式为 {"tag":"标签","position":"before|after","anchor":"原文中唯一出现的连续短语"}。`,
            `只可使用这些精确标签：${SPEECH_28_SOUND_TAGS.join(', ')}。没有 crying 标签；哭泣用 sad，只有原文明确有抽鼻子时才可用 sniffs。`,
            '语义参考：laughs=大笑，chuckle=轻笑，coughs=咳嗽，clear-throat=清嗓，groans=呻吟，breath=呼吸声，pant=喘气，inhale/exhale=吸气/呼气，gasps=倒吸气，sniffs=抽鼻子，sighs=叹息，snorts=哼鼻，burps=打嗝，lip-smacking=咂嘴，humming=哼唱，hissing=嘶声，emm=迟疑嗯声，sneezes=打喷嚏。',
            '只在正文明确描写可听见的笑、叹息、喘息、咳嗽、吸气等声音，或台词明确表现该声音时使用；不要仅凭情绪臆造。每段最多 2 个。',
            'anchor 必须逐字复制该段原文中只出现一次的短语，用 position 指定在该短语前或后插入；没有可靠锚点就返回 effects=[]。',
        );
    } else {
        lines.push(`当前语音模型 ${ttsModel || '未知'} 不支持 Speech 2.8 拟声标签，所有 effects 必须为 []。`);
    }
    return lines.join('\n');
}

async function requestDirector(segments, preset, knownSpeakers, url, signal, ttsModel, repair = false) {
    const messages = [
        {
            role: 'system',
            content: [
                directorPrompt(knownSpeakers, ttsModel),
                repair ? '严格格式模式：只输出一份完整 JSON 数组。不要重复数组，不要代码围栏，不要解释或前后缀。' : '',
            ].filter(Boolean).join('\n'),
        },
        { role: 'user', content: JSON.stringify(segments.map(({ idx, text }) => ({ idx, text }))) },
    ];
    const body = {
        model: preset.model,
        messages,
        temperature: clamp(preset.temperature, 0, 2, 0),
    };
    if (Number.isFinite(Number(preset.maxTokens)) && Number(preset.maxTokens) > 0) body.max_tokens = Number(preset.maxTokens);
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${preset.apiKey}` },
        body: JSON.stringify(body),
        signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `分轨接口 HTTP ${response.status}`);
    return payload?.choices?.[0]?.message?.content;
}

export async function directSegments(segments, preset, knownSpeakers = [], { signal, ttsModel = '' } = {}) {
    if (!preset?.apiKey || !preset?.baseUrl || !preset?.model) throw new Error('请先完整填写分轨 API 预设');
    const url = joinApiUrl(preset.baseUrl, '/v1/chat/completions');
    const content = await requestDirector(segments, preset, knownSpeakers, url, signal, ttsModel);
    try {
        return normalizeDirectorResult(segments, content, { ttsModel });
    } catch (error) {
        if (!(error instanceof DirectorFormatError)) throw error;
        console.warn('[梨园] 分轨模型返回格式异常，正在自动重试一次');
        const retried = await requestDirector(segments, preset, knownSpeakers, url, signal, ttsModel, true);
        try {
            return normalizeDirectorResult(segments, retried, { ttsModel });
        } catch (retryError) {
            if (retryError instanceof DirectorFormatError) {
                throw new DirectorFormatError('分轨模型连续两次返回了无法解析的格式，请点击“重新分轨”再试');
            }
            throw retryError;
        }
    }
}

export async function listModels(preset, { signal } = {}) {
    const response = await fetch(joinApiUrl(preset.baseUrl, '/v1/models'), {
        headers: { Authorization: `Bearer ${preset.apiKey}` },
        signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `模型列表 HTTP ${response.status}`);
    return (payload?.data ?? []).map(item => item?.id).filter(Boolean).sort();
}

export const __test = { DirectorFormatError, extractJsonArray, findArrayEnd, directorPrompt, normalizeSoundEffects };
