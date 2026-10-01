import { hashString } from './utils.js';
import { activeVoiceProfile } from './constants.js';

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
    const profile = activeVoiceProfile(settings);
    const available = new Set(profile.voiceBank.map(voice => voice.voiceId));
    const valid = voiceId => available.has(voiceId) ? voiceId : '';
    const binding = profile.bindings?.[cardKey] ?? {};
    if (segment.type === 'narration') {
        return valid(binding.narrator) || valid(profile.narratorVoiceId) || valid(profile.fallbackVoiceId);
    }
    const speaker = segment.speaker || 'unknown';
    const sessionKey = `${settings.tts.provider}::${cardKey}::${speaker}`;
    if (sessionSpeakerMap.has(sessionKey)) return sessionSpeakerMap.get(sessionKey);
    const exact = [binding.main, ...(binding.extras ?? [])].find(item => item?.speaker === speaker)?.voiceId;
    let voiceId = valid(exact);
    if (!voiceId) {
        for (const key of poolKeysFor(segment)) {
            const pool = toneMatchedPool(profile.fuzzyPools?.[key]?.filter(valid), profile.voiceBank, segment.toneTag);
            voiceId = pickDeterministic(speaker, pool);
            if (voiceId) break;
        }
    }
    voiceId ||= valid(profile.fallbackVoiceId);
    sessionSpeakerMap.set(sessionKey, voiceId);
    return voiceId;
}

export function applyVoices(segments, settings, cardKey = '') {
    const available = new Set(activeVoiceProfile(settings).voiceBank.map(voice => voice.voiceId));
    return segments.map(segment => ({
        ...segment,
        voiceId: (settings.tts.provider !== 'elevenlabs' && segment.voiceOverride)
            || (available.has(segment.voiceOverride) ? segment.voiceOverride : resolveVoice(segment, settings, cardKey)),
    }));
}

export function clearRuntimeSpeakerMap() {
    sessionSpeakerMap.clear();
}

export function getNewSpeakers(segments, settings, cardKey = '') {
    const binding = activeVoiceProfile(settings).bindings?.[cardKey] ?? {};
    const known = new Set([binding.main?.speaker, ...(binding.extras ?? []).map(item => item?.speaker)].filter(Boolean));
    return [...new Set(segments.filter(item => item.type === 'dialogue' && item.speaker && !known.has(item.speaker)).map(item => item.speaker))];
}

export function bindSpeaker(settings, cardKey, speaker, voiceId) {
    const profile = activeVoiceProfile(settings);
    profile.bindings ||= {};
    const binding = profile.bindings[cardKey] ||= { main: null, extras: [], narrator: '' };
    if (binding.main?.speaker === speaker) {
        binding.main.voiceId = voiceId;
        sessionSpeakerMap.set(`${settings.tts.provider}::${cardKey}::${speaker}`, voiceId);
        return;
    }
    const existing = binding.extras.find(item => item.speaker === speaker);
    if (existing) existing.voiceId = voiceId;
    else binding.extras.push({ speaker, voiceId });
    sessionSpeakerMap.set(`${settings.tts.provider}::${cardKey}::${speaker}`, voiceId);
}

export const __test = { pickDeterministic, poolKeysFor, toneMatchedPool };

