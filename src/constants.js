export const MODULE_NAME = 'third-party/st-playhouse';
export const SETTINGS_KEY = 'playhouse';

export const EMOTIONS = Object.freeze([
    'happy',
    'sad',
    'angry',
    'fearful',
    'disgusted',
    'surprised',
    'calm',
    'fluent',
    'whisper',
]);

const BASE_EMOTIONS = Object.freeze(EMOTIONS.slice(0, 7));

export function emotionOptionsForModel(model) {
    const options = [...BASE_EMOTIONS];
    if (String(model).startsWith('speech-2.6-') || String(model).startsWith('speech-2.8-')) options.push('fluent');
    if (String(model).startsWith('speech-2.6-')) options.push('whisper');
    return options;
}

export function normalizeTtsEmotion(value, model) {
    const aliases = { neutral: 'calm', whipser: 'whisper' };
    const raw = String(value ?? '').trim().toLowerCase();
    const normalized = aliases[raw] || raw;
    return emotionOptionsForModel(model).includes(normalized) ? normalized : '';
}

export const MINIMAX_SPEECH_MODELS = Object.freeze([
    'speech-2.8-hd',
    'speech-2.8-turbo',
    'speech-2.6-hd',
    'speech-2.6-turbo',
    'speech-02-hd',
    'speech-02-turbo',
]);

export const SPEECH_28_SOUND_TAGS = Object.freeze([
    'laughs',
    'chuckle',
    'coughs',
    'clear-throat',
    'groans',
    'breath',
    'pant',
    'inhale',
    'exhale',
    'gasps',
    'sniffs',
    'sighs',
    'snorts',
    'burps',
    'lip-smacking',
    'humming',
    'hissing',
    'emm',
    'sneezes',
]);

export const DIRECTOR_SCHEMA_VERSION = 6;
export const VOICE_CATALOG_VERSION = 3;

export function supportsSpeech28SoundTags(model) {
    return model === 'speech-2.8-hd' || model === 'speech-2.8-turbo';
}

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    trigger: 'manual',
    narrationMode: 'full',
    contentTags: 'content',
    miniPlayerVisible: true,
    backgroundPlayback: false,
    theme: 'follow',
    activePresetId: 'p_default',
    apiPresets: [{
        id: 'p_default',
        name: 'Gemini Flash Lite',
        baseUrl: 'https://gcli.ggchan.dev',
        apiKey: '',
        model: 'gemini-2.5-flash-lite',
        temperature: 0,
        maxTokens: null,
    }],
    tts: {
        provider: 'minimax',
        baseUrl: 'https://api.minimaxi.com',
        apiKey: '',
        groupId: '',
        model: 'speech-2.8-hd',
        concurrency: 3,
        globalSpeed: 1,
    },
    voiceCatalogVersion: VOICE_CATALOG_VERSION,
    modelLists: {},
    voiceBank: [
        { voiceId: 'Chinese (Mandarin)_Reliable_Executive', label: '沉稳高管', gender: 'male', ageTag: 'mature', toneTag: 'calm', note: 'MiniMax 官方音色' },
        { voiceId: 'Chinese (Mandarin)_News_Anchor', label: '新闻女声', gender: 'female', ageTag: 'mature', toneTag: 'calm', note: 'MiniMax 官方音色' },
        { voiceId: 'male-qn-qingse', label: '青涩青年', gender: 'male', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方音色' },
        { voiceId: 'female-shaonv', label: '少女声线', gender: 'female', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方音色' },
        { voiceId: 'Chinese (Mandarin)_Unrestrained_Young_Man', label: '豪爽青年', gender: 'male', ageTag: 'young', toneTag: 'bright', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Southern_Young_Man', label: '南方青年', gender: 'male', ageTag: 'young', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Gentle_Youth', label: '温柔青年', gender: 'male', ageTag: 'young', toneTag: 'soft', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Straightforward_Boy', label: '直爽少年', gender: 'male', ageTag: 'young', toneTag: 'bright', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Pure-hearted_Boy', label: '纯真少年', gender: 'male', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Humorous_Elder', label: '幽默长者', gender: 'male', ageTag: 'elder', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Gentleman', label: '儒雅绅士', gender: 'male', ageTag: 'mature', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Male_Announcer', label: '男播音员', gender: 'male', ageTag: 'mature', toneTag: 'deep', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Kind-hearted_Elder', label: '慈祥长者', gender: 'male', ageTag: 'elder', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Radio_Host', label: '电台男声', gender: 'male', ageTag: 'mature', toneTag: 'deep', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Mature_Woman', label: '成熟女声', gender: 'female', ageTag: 'mature', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Kind-hearted_Antie', label: '慈爱阿姨', gender: 'female', ageTag: 'mature', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Wise_Women', label: '知性女士', gender: 'female', ageTag: 'mature', toneTag: 'calm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Warm-HeartedAunt', label: '暖心阿姨', gender: 'female', ageTag: 'elder', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Arrogant_Miss', label: '傲娇小姐', gender: 'female', ageTag: 'young', toneTag: 'cold', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_HK_Flight_Attendant', label: '港风空乘', gender: 'female', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Warm_Bestie', label: '温暖闺蜜', gender: 'female', ageTag: 'young', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Sweet_Lady', label: '甜美女声', gender: 'female', ageTag: 'young', toneTag: 'soft', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Warm_Girl', label: '暖系少女', gender: 'female', ageTag: 'young', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Crisp_Girl', label: '清脆少女', gender: 'female', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Soft_Girl', label: '柔声少女', gender: 'female', ageTag: 'young', toneTag: 'soft', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_IntellectualGirl', label: '知性少女', gender: 'female', ageTag: 'young', toneTag: 'calm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Warm_HeartedGirl', label: '暖心少女', gender: 'female', ageTag: 'young', toneTag: 'warm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Laid_BackGirl', label: '慵懒少女', gender: 'female', ageTag: 'young', toneTag: 'calm', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_ExplorativeGirl', label: '元气少女', gender: 'female', ageTag: 'young', toneTag: 'bright', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_BashfulGirl', label: '腼腆少女', gender: 'female', ageTag: 'young', toneTag: 'soft', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Cute_Spirit', label: '可爱精灵', gender: 'unknown', ageTag: 'child', toneTag: 'bright', note: 'MiniMax 官方普通话角色音色' },
        { voiceId: 'Robot_Armor', label: '机甲机器人', gender: 'unknown', ageTag: 'mature', toneTag: 'deep', note: 'MiniMax 官方普通话角色音色' },
        { voiceId: 'Chinese (Mandarin)_Stubborn_Friend', label: '倔强好友', gender: 'unknown', ageTag: 'young', toneTag: 'cold', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Lyrical_Voice', label: '抒情声线', gender: 'unknown', ageTag: 'young', toneTag: 'soft', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Sincere_Adult', label: '真诚大人', gender: 'unknown', ageTag: 'mature', toneTag: 'clear', note: 'MiniMax 官方普通话音色' },
        { voiceId: 'Chinese (Mandarin)_Gentle_Senior', label: '温和长辈', gender: 'unknown', ageTag: 'elder', toneTag: 'soft', note: 'MiniMax 官方普通话音色' },
    ],
    fuzzyPools: {
        male_child: ['Chinese (Mandarin)_Straightforward_Boy', 'Chinese (Mandarin)_Pure-hearted_Boy'],
        female_child: ['female-shaonv', 'Chinese (Mandarin)_Cute_Spirit'],
        male_young: ['male-qn-qingse', 'Chinese (Mandarin)_Unrestrained_Young_Man', 'Chinese (Mandarin)_Southern_Young_Man', 'Chinese (Mandarin)_Gentle_Youth', 'Chinese (Mandarin)_Straightforward_Boy', 'Chinese (Mandarin)_Pure-hearted_Boy'],
        male_mature: ['Chinese (Mandarin)_Reliable_Executive', 'Chinese (Mandarin)_Humorous_Elder', 'Chinese (Mandarin)_Gentleman', 'Chinese (Mandarin)_Male_Announcer', 'Chinese (Mandarin)_Kind-hearted_Elder', 'Chinese (Mandarin)_Radio_Host'],
        male_elder: ['Chinese (Mandarin)_Humorous_Elder', 'Chinese (Mandarin)_Kind-hearted_Elder', 'Chinese (Mandarin)_Gentle_Senior'],
        female_young: ['female-shaonv', 'Arrogant_Miss', 'Chinese (Mandarin)_HK_Flight_Attendant', 'Chinese (Mandarin)_Warm_Bestie', 'Chinese (Mandarin)_Sweet_Lady', 'Chinese (Mandarin)_Warm_Girl', 'Chinese (Mandarin)_Crisp_Girl', 'Chinese (Mandarin)_Soft_Girl', 'Chinese (Mandarin)_IntellectualGirl', 'Chinese (Mandarin)_Warm_HeartedGirl', 'Chinese (Mandarin)_Laid_BackGirl', 'Chinese (Mandarin)_ExplorativeGirl', 'Chinese (Mandarin)_BashfulGirl'],
        female_mature: ['Chinese (Mandarin)_News_Anchor', 'Chinese (Mandarin)_Mature_Woman', 'Chinese (Mandarin)_Kind-hearted_Antie', 'Chinese (Mandarin)_Wise_Women', 'Chinese (Mandarin)_Warm-HeartedAunt'],
        female_elder: ['Chinese (Mandarin)_Wise_Women', 'Chinese (Mandarin)_Warm-HeartedAunt'],
        child: ['female-shaonv', 'Chinese (Mandarin)_Cute_Spirit'],
        unknown: ['male-qn-qingse', 'female-shaonv', 'Robot_Armor', 'Chinese (Mandarin)_Stubborn_Friend', 'Chinese (Mandarin)_Lyrical_Voice', 'Chinese (Mandarin)_Sincere_Adult', 'Chinese (Mandarin)_Gentle_Senior'],
    },
    narratorVoiceId: 'Chinese (Mandarin)_News_Anchor',
    fallbackVoiceId: 'female-shaonv',
    gapMs: { afterNarration: 300, afterDialogue: 200, speakerSwitch: 250 },
    cache: { enabled: true, maxMB: 200, cleanupMode: 'days', keepDays: 30, cleanupMB: 100 },
    bindings: {},
});

export function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export function mergeDefaultVoiceCatalog(target, defaults = cloneDefaults()) {
    target.voiceBank = Array.isArray(target.voiceBank) ? target.voiceBank : [];
    const existing = new Set(target.voiceBank.map(voice => voice?.voiceId).filter(Boolean));
    for (const voice of defaults.voiceBank) {
        if (!existing.has(voice.voiceId)) {
            target.voiceBank.push({ ...voice });
            existing.add(voice.voiceId);
        } else {
            const current = target.voiceBank.find(item => item?.voiceId === voice.voiceId);
            for (const key of ['gender', 'ageTag', 'toneTag']) current[key] = voice[key];
        }
    }
    target.fuzzyPools = target.fuzzyPools && typeof target.fuzzyPools === 'object' ? target.fuzzyPools : {};
    for (const [key, voiceIds] of Object.entries(defaults.fuzzyPools)) {
        const pool = target.fuzzyPools[key] = Array.isArray(target.fuzzyPools[key]) ? target.fuzzyPools[key] : [];
        for (const voiceId of voiceIds) if (!pool.includes(voiceId)) pool.push(voiceId);
    }
    target.voiceCatalogVersion = VOICE_CATALOG_VERSION;
    return target;
}

