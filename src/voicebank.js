import { hashString } from './utils.js';

const sessionSpeakerMap = new Map();

function pickDeterministic(speaker, pool) {
    return pool?.length ? pool[hashString(speaker) % pool.length] : '';
}

function toneMatchedPool(pool, voiceBank, toneTag) {
    if (!pool?.length || !toneTag || toneTag === 'unknown') return pool;
    const tones = new Map((voiceBank ?? []).map(voice => [voice.voiceId, voice.toneTag]));
    const matched = pool.filter(voiceId => tones.get(voiceId) === toneTag);
    return matched.length ? matched : pool;
}

function poolKeysFor(segment) {
    const gender = ['male', 'female'].includes(segment.gender) ? segment.gender : 'unknown';
    const age = ['child', 'young', 'mature', 'elder'].includes(segment.ageTag) ? segment.ageTag : 'unknown';
    const keys = [];
    if (gender !== 'unknown' && age !== 'unknown') keys.push(`${gender}_${age}`);
    if (age === 'child') keys.push('child');
    if (age === 'elder' && gender !== 'unknown') keys.push(`${gender}_mature`);
    keys.push('unknown');
    return [...new Set(keys)];
}

export function resolveVoice(segment, settings, cardKey = '') {
    const binding = settings.bindings?.[cardKey] ?? {};
    if (segment.type === 'narration') {
        return binding.narrator || settings.narratorVoiceId || settings.fallbackVoiceId || '';
    }
    const speaker = segment.speaker || 'unknown';
    const sessionKey = `${cardKey}::${speaker}`;
    if (sessionSpeakerMap.has(sessionKey)) return sessionSpeakerMap.get(sessionKey);
    const exact = [binding.main, ...(binding.extras ?? [])].find(item => item?.speaker === speaker)?.voiceId;
    let voiceId = exact;
    if (!voiceId) {
        for (const key of poolKeysFor(segment)) {
            const pool = toneMatchedPool(settings.fuzzyPools?.[key], settings.voiceBank, segment.toneTag);
            voiceId = pickDeterministic(speaker, pool);
            if (voiceId) break;
        }
    }
    voiceId ||= settings.fallbackVoiceId || '';
    sessionSpeakerMap.set(sessionKey, voiceId);
    return voiceId;
}

export function applyVoices(segments, settings, cardKey = '') {
    return segments.map(segment => ({ ...segment, voiceId: segment.voiceOverride || resolveVoice(segment, settings, cardKey) }));
}

export function clearRuntimeSpeakerMap() {
    sessionSpeakerMap.clear();
}

export function getNewSpeakers(segments, settings, cardKey = '') {
    const binding = settings.bindings?.[cardKey] ?? {};
    const known = new Set([binding.main?.speaker, ...(binding.extras ?? []).map(item => item?.speaker)].filter(Boolean));
    return [...new Set(segments.filter(item => item.type === 'dialogue' && item.speaker && !known.has(item.speaker)).map(item => item.speaker))];
}

export function bindSpeaker(settings, cardKey, speaker, voiceId) {
    settings.bindings ||= {};
    const binding = settings.bindings[cardKey] ||= { main: null, extras: [], narrator: '' };
    if (binding.main?.speaker === speaker) {
        binding.main.voiceId = voiceId;
        sessionSpeakerMap.set(`${cardKey}::${speaker}`, voiceId);
        return;
    }
    const existing = binding.extras.find(item => item.speaker === speaker);
    if (existing) existing.voiceId = voiceId;
    else binding.extras.push({ speaker, voiceId });
    sessionSpeakerMap.set(`${cardKey}::${speaker}`, voiceId);
}

export const __test = { pickDeterministic, poolKeysFor, toneMatchedPool };

