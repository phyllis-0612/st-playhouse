import { emotionOptionsForModel, normalizeTtsEmotion, SPEECH_28_SOUND_TAGS, supportsSpeech28SoundTags } from './constants.js';
import { clamp, joinApiUrl } from './utils.js';

const ALLOWED_GENDERS = new Set(['male', 'female', 'unknown']);
const ALLOWED_AGES = new Set(['child', 'young', 'mature', 'elder', 'unknown']);
const ALLOWED_TONES = new Set(['clear', 'warm', 'cold', 'calm', 'deep', 'bright', 'soft', 'unknown']);
const ALLOWED_SOUND_TAGS = new Set(SPEECH_28_SOUND_TAGS);
const ALLOWED_SCENE_MOODS = new Set(['neutral', 'intimate', 'tender', 'joyful', 'playful', 'tense', 'suspenseful', 'sad', 'tragic', 'angry', 'fearful', 'solemn', 'urgent', 'mysterious']);
const ALLOWED_SCENE_PACES = new Set(['slow', 'steady', 'fast']);
const ALLOWED_SCENE_ARCS = new Set(['rising', 'steady', 'falling', 'turning']);
const ALLOWED_PACES = new Set(['very_slow', 'slow', 'normal', 'fast', 'very_fast']);
const ALLOWED_CONFIDENCE = new Set(['low', 'medium', 'high']);
const PACE_SPEED = Object.freeze({ very_slow: 0.78, slow: 0.9, normal: 1, fast: 1.12, very_fast: 1.28 });
const SCENE_DEFAULT_PACE = Object.freeze({ slow: 'slow', steady: 'normal', fast: 'fast' });
const MAX_EFFECTS_PER_SEGMENT = 2;

class DirectorFormatError extends Error {
    constructor(message = '分轨模型返回格式异常') {
        super(message);
        this.name = 'DirectorFormatError';
    }
}

function findJsonEnd(text, start) {
    const stack = [];
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
        else if (char === '[' || char === '{') stack.push(char);
        else if (char === ']' || char === '}') {
            const expected = char === ']' ? '[' : '{';
            if (stack.pop() !== expected) return -1;
            if (!stack.length) return index;
        }
    }
    return -1;
}

function findArrayEnd(text, start) {
    return text[start] === '[' ? findJsonEnd(text, start) : -1;
}

function extractDirectorPayload(value) {
    const text = String(value ?? '').trim();
    let sawJson = false;
    for (let start = 0; start < text.length; start++) {
        if (!['[', '{'].includes(text[start])) continue;
        const end = findJsonEnd(text, start);
        if (end < 0) continue;
        sawJson = true;
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (Array.isArray(parsed)) return { scene: {}, segments: parsed };
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.segments)) return parsed;
        } catch { /* Try the next complete JSON value in the response. */ }
        start = end;
    }
    throw new DirectorFormatError(sawJson
        ? '分轨模型返回格式异常：没有找到包含 segments 的 JSON'
        : '分轨模型没有返回 JSON');
}

function extractJsonArray(value) {
    try { return extractDirectorPayload(value).segments; }
    catch (error) {
        if (error instanceof DirectorFormatError) {
            throw new DirectorFormatError(error.message.replace('包含 segments 的 JSON', '可解析的 JSON 数组').replace('没有返回 JSON', '没有返回 JSON 数组'));
        }
        throw error;
    }
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

function normalizeScene(raw = {}) {
    return {
        mood: ALLOWED_SCENE_MOODS.has(raw?.mood) ? raw.mood : 'neutral',
        tension: Math.round(clamp(raw?.tension, 0, 3, 1)),
        pace: ALLOWED_SCENE_PACES.has(raw?.pace) ? raw.pace : 'steady',
        arc: ALLOWED_SCENE_ARCS.has(raw?.arc) ? raw.arc : 'steady',
    };
}

function normalizePerformance(item, scene, ttsModel) {
    const confidence = ALLOWED_CONFIDENCE.has(item?.emotionConfidence) ? item.emotionConfidence : 'medium';
    const normalizedEmotion = normalizeTtsEmotion(item?.emotion, ttsModel);
    const emotion = confidence === 'low' ? '' : normalizedEmotion;
    const intensity = Math.round(clamp(item?.intensity, 0, 3, 1));
    const pace = ALLOWED_PACES.has(item?.pace) ? item.pace : SCENE_DEFAULT_PACE[scene.pace];
    const speed = ALLOWED_PACES.has(item?.pace)
        ? PACE_SPEED[pace]
        : Number.isFinite(Number(item?.speed)) ? clamp(item.speed, 0.5, 2, PACE_SPEED[pace]) : PACE_SPEED[pace];
    const pitchDirection = 'natural';
    const pitch = 0;
    return { emotion, emotionConfidence: confidence, intensity, pace, speed, pitchDirection, pitch };
}

export function normalizeDirectorResult(localSegments, raw, { ttsModel = '' } = {}) {
    const payload = Array.isArray(raw) ? { scene: {}, segments: raw }
        : raw && typeof raw === 'object' && Array.isArray(raw.segments) ? raw
            : extractDirectorPayload(raw);
    const parsed = payload.segments;
    const scene = normalizeScene(payload.scene);
    const byIndex = new Map(parsed.filter(item => Number.isInteger(Number(item?.idx))).map(item => [Number(item.idx), item]));
    const soundEffectsEnabled = supportsSpeech28SoundTags(ttsModel);
    return localSegments.map(local => {
        const item = byIndex.get(local.idx) ?? {};
        const dialogue = item.type === 'dialogue' || (item.type !== 'narration' && local.type === 'dialogue');
        const speaker = dialogue && typeof item.speaker === 'string' && item.speaker.trim() ? item.speaker.trim() : null;
        const performance = normalizePerformance(item, scene, ttsModel);
        const effects = normalizeSoundEffects(item.effects, local.text, soundEffectsEnabled);
        return {
            idx: local.idx,
            type: dialogue ? 'dialogue' : 'narration',
            speaker: dialogue ? speaker : null,
            text: local.text,
            gender: ALLOWED_GENDERS.has(item.gender) ? item.gender : 'unknown',
            ageTag: ALLOWED_AGES.has(item.ageTag) ? item.ageTag : 'unknown',
            toneTag: ALLOWED_TONES.has(item.toneTag) ? item.toneTag : 'unknown',
            emotion: performance.emotion,
            emotionConfidence: performance.emotionConfidence,
            intensity: performance.intensity,
            pace: performance.pace,
            speed: performance.speed,
            pitchDirection: performance.pitchDirection,
            pitch: performance.pitch,
            sceneMood: scene.mood,
            sceneTension: scene.tension,
            sceneArc: scene.arc,
            effects,
            ttsText: applySoundEffects(local.text, effects),
        };
    });
}

function directorPrompt(knownSpeakers, ttsModel = '') {
    const soundEffectsEnabled = supportsSpeech28SoundTags(ttsModel);
    const emotionOptions = emotionOptionsForModel(ttsModel);
    const lines = [
        '你是小说有声化表演导演。只分析本次输入的当前一条消息，不臆测前文、用户消息或未提供的角色设定。',
        '先通读全部 segments，判断整场气氛与情绪走向；再结合场景结果逐段设计表演。只返回一个 JSON 对象，不要 markdown，不要解释。',
        '输入正文已由前端切分，type 是前端的初步判断，你应根据上下文语义修正。旁白中出现的引用性双引号（转述、回忆、心理活动、内心独白）应标记为 narration；只有角色当场开口说出的话才标记为 dialogue。你只返回元数据，严禁返回 text/content/正文，严禁改写或复述台词。',
        `已知角色：${knownSpeakers.filter(Boolean).join('、') || '无'}。speaker 优先且严格复用已知角色名；只有明确出现新名字才新建。`,
        '旁白引述他人话语时（如“她曾说过‘……’”、他想起那句“……”），即使有引号包裹，也应标为 narration，speaker 设为 null。判断依据是说话动作是否发生在当前场景的实时时间线上。',
        '判断台词归属时必须同时参考前文和后文。中文小说常见“台词在前、归属动作在后”的写法（如先出现台词，下一段才写“某某说道/递过来/签下”），此时 speaker 应归属给后文中执行动作的角色，而非前一句台词的说话人。请先通读全部 segments 确定每段台词的说话人，再填写 speaker。',
        '顶层格式：{"scene":{"mood":"neutral|intimate|tender|joyful|playful|tense|suspenseful|sad|tragic|angry|fearful|solemn|urgent|mysterious","tension":0到3整数,"pace":"slow|steady|fast","arc":"rising|steady|falling|turning"},"segments":[逐段结果]}。',
        `逐段格式：{"idx":0,"type":"narration|dialogue","speaker":null或名字,"gender":"male|female|unknown","ageTag":"child|young|mature|elder|unknown","toneTag":"clear|warm|cold|calm|deep|bright|soft|unknown","emotion":"${emotionOptions.join('|')}","emotionConfidence":"low|medium|high","intensity":0到3整数,"pace":"very_slow|slow|normal|fast|very_fast","effects":[]}`,
        'ageTag 表示角色稳定年龄层：幼童/儿童用 child，青年用 young，中年或成熟成人用 mature，明确的老人或高龄长辈用 elder。toneTag 表示角色长期声线气质而非本句临时情绪；可根据身份与描写选择 clear、warm、cold、calm、deep、bright、soft，无法判断用 unknown。',
        'emotion 表示可听见的主要表演情绪；潜台词不确定或混合情绪无法可靠归类时，把 emotionConfidence 设为 low，让语音模型自动判断，不要硬猜。',
        'intensity 和 pace 必须结合整场气氛、标点、动作和情绪转折克制选择。相邻段落没有明确转折时保持连续，不要忽快忽慢。',
        '同一角色在同一条消息内，pace 应保持一致，除非该段有明确的情绪转折标点（感叹号、省略号、问号连用）或动作描写表明语气骤变。无明确转折时沿用该角色在本消息内的首段 pace。',
        '音高由梨园固定以保持同一角色音色稳定。不要输出 pitch、pitchDirection、timbre 或 voiceId；你只设计情绪、强度、语速和合法拟声。',
        '旁白以讲述清晰和气氛连续为先，角色台词才突出人物情绪。无法判断时沿用 scene.pace，emotionConfidence=low、intensity=1、effects=[]。',
    ];
    if (soundEffectsEnabled) {
        lines.push(
            `当前语音模型 ${ttsModel} 支持拟声标签。effects 每项格式为 {"tag":"标签","position":"before|after","anchor":"原文中唯一出现的连续短语"}。`,
            `只可使用这些精确标签：${SPEECH_28_SOUND_TAGS.join(', ')}。没有 crying 标签；哭泣用 sad，只有原文明确有抽鼻子时才可用 sniffs。`,
            '语义参考：laughs=大笑，chuckle=轻笑，coughs=咳嗽，clear-throat=清嗓，groans=呻吟，breath=呼吸声，pant=喘气，inhale/exhale=吸气/呼气，gasps=倒吸气，sniffs=抽鼻子，sighs=叹息，snorts=哼鼻，burps=打嗝，lip-smacking=咂嘴，humming=哼唱，hissing=嘶声，emm=迟疑嗯声，sneezes=打喷嚏。',
            '气氛只用于判断这些声音应当轻微还是明显，不能凭气氛凭空创造声音。只在正文明确描写，或台词与标点强烈暗示确实发出了该声音时使用；每段最多 2 个。',
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
                repair ? '严格格式模式：只输出一份包含 scene 和 segments 的完整 JSON 对象。不要重复对象，不要代码围栏，不要解释或前后缀。' : '',
            ].filter(Boolean).join('\n'),
        },
        { role: 'user', content: JSON.stringify({
            scope: 'current_message_only',
            segments: segments.map(({ idx, type, text }) => ({ idx, type, text })),
        }) },
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

export const __test = { DirectorFormatError, extractDirectorPayload, extractJsonArray, findArrayEnd, findJsonEnd, directorPrompt, normalizePerformance, normalizeScene, normalizeSoundEffects };

