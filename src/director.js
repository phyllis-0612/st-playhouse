import { EMOTIONS } from './constants.js';
import { clamp, joinApiUrl } from './utils.js';

const ALLOWED_GENDERS = new Set(['male', 'female', 'unknown']);
const ALLOWED_AGES = new Set(['young', 'mature', 'child', 'unknown']);
const ALLOWED_TONES = new Set(['clear', 'warm', 'cold', 'calm', 'deep', 'bright', 'soft', 'unknown']);

function extractJsonArray(value) {
    const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('分轨模型没有返回 JSON 数组');
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) throw new Error('分轨结果不是数组');
    return parsed;
}

export function normalizeDirectorResult(localSegments, raw) {
    const parsed = Array.isArray(raw) ? raw : extractJsonArray(raw);
    const byIndex = new Map(parsed.filter(item => Number.isInteger(Number(item?.idx))).map(item => [Number(item.idx), item]));
    return localSegments.map(local => {
        const item = byIndex.get(local.idx) ?? {};
        const dialogue = item.type === 'dialogue' || (item.type !== 'narration' && local.type === 'dialogue');
        const speaker = dialogue && typeof item.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : null;
        const emotion = EMOTIONS.includes(item.emotion) ? item.emotion : 'calm';
        return {
            idx: local.idx,
            type: dialogue && speaker ? 'dialogue' : 'narration',
            speaker: dialogue && speaker ? speaker : null,
            text: local.text,
            gender: ALLOWED_GENDERS.has(item.gender) ? item.gender : 'unknown',
            ageTag: ALLOWED_AGES.has(item.ageTag) ? item.ageTag : 'unknown',
            toneTag: ALLOWED_TONES.has(item.toneTag) ? item.toneTag : 'unknown',
            emotion,
            speed: clamp(item.speed, 0.7, 1.3, 1),
        };
    });
}

function directorPrompt(knownSpeakers) {
    return [
        '你是小说朗读分轨导演。只返回 JSON 数组，不要 markdown，不要解释。',
        '输入中的正文已由前端切分。你只返回元数据，严禁返回 text/content/正文。',
        `已知角色：${knownSpeakers.filter(Boolean).join('、') || '无'}。speaker 优先且严格复用已知角色名；只有明确出现新名字才新建。`,
        '每项格式：{"idx":0,"type":"narration|dialogue","speaker":null或名字,"gender":"male|female|unknown","ageTag":"young|mature|child|unknown","toneTag":"clear|warm|cold|calm|deep|bright|soft|unknown","emotion":"happy|sad|angry|fearful|disgusted|surprised|calm|whipser","speed":0.7到1.3}',
        '引号内通常是台词；引号外、动作和环境描写通常是旁白。无法判断时用 narration、speaker=null、emotion=calm、speed=1。',
    ].join('\n');
}

export async function directSegments(segments, preset, knownSpeakers = [], { signal } = {}) {
    if (!preset?.apiKey || !preset?.baseUrl || !preset?.model) throw new Error('请先完整填写分轨 API 预设');
    const url = joinApiUrl(preset.baseUrl, '/v1/chat/completions');
    const body = {
        model: preset.model,
        messages: [
            { role: 'system', content: directorPrompt(knownSpeakers) },
            { role: 'user', content: JSON.stringify(segments.map(({ idx, text }) => ({ idx, text }))) },
        ],
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
    const content = payload?.choices?.[0]?.message?.content;
    return normalizeDirectorResult(segments, content);
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

export const __test = { extractJsonArray, directorPrompt };
