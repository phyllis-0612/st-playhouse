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
    'whipser',
]);

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    trigger: 'manual',
    narrationMode: 'full',
    contentTags: 'content',
    miniPlayerVisible: true,
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
        model: 'speech-02-hd',
        concurrency: 3,
        globalSpeed: 1,
    },
    modelLists: {},
    voiceBank: [
        { voiceId: 'Chinese (Mandarin)_Reliable_Executive', label: '沉稳高管', gender: 'male', ageTag: 'mature', toneTag: 'calm', note: 'MiniMax 官方音色' },
        { voiceId: 'Chinese (Mandarin)_News_Anchor', label: '新闻女声', gender: 'female', ageTag: 'mature', toneTag: 'calm', note: 'MiniMax 官方音色' },
        { voiceId: 'male-qn-qingse', label: '青涩青年', gender: 'male', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方音色' },
        { voiceId: 'female-shaonv', label: '少女声线', gender: 'female', ageTag: 'young', toneTag: 'clear', note: 'MiniMax 官方音色' },
    ],
    fuzzyPools: {
        male_young: ['male-qn-qingse'],
        male_mature: ['Chinese (Mandarin)_Reliable_Executive'],
        female_young: ['female-shaonv'],
        female_mature: ['Chinese (Mandarin)_News_Anchor'],
        child: ['female-shaonv'],
        unknown: ['male-qn-qingse', 'female-shaonv'],
    },
    narratorVoiceId: 'Chinese (Mandarin)_News_Anchor',
    fallbackVoiceId: 'female-shaonv',
    gapMs: { afterNarration: 300, afterDialogue: 200, speakerSwitch: 250 },
    cache: { enabled: true, maxMB: 200 },
    bindings: {},
});

export function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}
