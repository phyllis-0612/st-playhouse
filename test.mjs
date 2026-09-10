import assert from 'node:assert/strict';
import { extractTaggedContent, parseContentTags, segmentText } from './src/segmenter.js';
import { __test as directorTest, directSegments, normalizeDirectorResult } from './src/director.js';
import { applyVoices, clearRuntimeSpeakerMap } from './src/voicebank.js';
import { cloneDefaults, EMOTIONS } from './src/constants.js';
import { buildTtsBody, buildTtsUrl, classifyTtsError, TtsService } from './src/tts.js';
import { buildCloneBody, buildCloneUrl, validateCloneFile, validateVoiceId } from './src/voiceclone.js';
import { joinApiUrl } from './src/utils.js';
import { readFile } from 'node:fs/promises';
import { audioBufferToMonoPcm16, buildBackgroundTrack, gapBetweenMs } from './src/background-audio.js';

const segmented = segmentText('夜色很静。*她抬起头。*「你好。」代码：```secret()``` ![图](x.png)');
assert.deepEqual(segmented.map(item => item.type), ['narration', 'dialogue', 'narration']);
assert.equal(segmented[0].text.includes('secret'), false);
assert.equal(segmented[0].text.includes('图'), false);
assert.deepEqual(segmented.map(item => item.idx), [0, 1, 2]);

const long = segmentText('甲。'.repeat(250));
assert.ok(long.every(item => item.text.length <= 400));

const tagged = extractTaggedContent('<thinking>秘密思考</thinking><content data-kind="正文">第一幕。</content><status>状态栏</status><正文>第二幕。</正文>', 'content, 正文');
assert.equal(tagged.text, '第一幕。\n第二幕。');
assert.deepEqual(tagged.matchedTags, ['content', '正文']);
assert.equal(extractTaggedContent('没有标签的消息', 'content').text, '');
assert.deepEqual(parseContentTags('<content>, article，正文'), ['content', 'article', '正文']);
assert.equal(extractTaggedContent('<story.part>安全正文</story.part>', 'story.part').text, '安全正文');

const directed = normalizeDirectorResult(segmented, [
    { idx: 0, type: 'narration', emotion: 'neutral', speed: 9, text: '模型篡改正文' },
    { idx: 1, type: 'dialogue', speaker: '楚弥', emotion: 'angry', speed: .8, text: '模型篡改台词' },
]);
assert.equal(directed[0].text, segmented[0].text);
assert.equal(directed[0].emotion, 'calm');
assert.equal(directed[0].speed, 1.3);
assert.equal(directed[1].text, segmented[1].text);
assert.equal(directed[1].emotion, 'angry');
assert.equal(directed[2].type, 'narration');

const duplicateDirectorOutput = '[{"idx":0,"type":"narration","speaker":"阿[甲]"}]\n[{"idx":0,"type":"dialogue","speaker":"错误副本"}]';
assert.equal(directorTest.extractJsonArray(duplicateDirectorOutput)[0].speaker, '阿[甲]');
assert.equal(directorTest.extractJsonArray('说明：[不是 JSON]\n```json\n[{"idx":0}]\n```')[0].idx, 0);
assert.throws(() => directorTest.extractJsonArray('没有数组'), /没有返回 JSON 数组/);

const originalFetch = globalThis.fetch;
let directorCalls = 0;
try {
    globalThis.fetch = async (_url, options) => {
        directorCalls++;
        const request = JSON.parse(options.body);
        if (directorCalls === 2) assert.match(request.messages[0].content, /严格格式模式/);
        const content = directorCalls === 1 ? '格式错误' : '[{"idx":0,"type":"narration","speaker":null,"emotion":"calm","speed":1}]';
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    const retriedDirector = await directSegments([{ idx: 0, type: 'narration', text: '夜色。' }], {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        model: 'flash-test',
        temperature: 0,
    });
    assert.equal(directorCalls, 2);
    assert.equal(retriedDirector[0].type, 'narration');
} finally {
    globalThis.fetch = originalFetch;
}

const settings = cloneDefaults();
assert.equal(settings.miniPlayerVisible, true);
assert.equal(settings.backgroundPlayback, false);
clearRuntimeSpeakerMap();
const voices1 = applyVoices([{ type: 'dialogue', speaker: '沈砚', gender: 'male', ageTag: 'young' }], settings, 'card.png');
clearRuntimeSpeakerMap();
const voices2 = applyVoices([{ type: 'dialogue', speaker: '沈砚', gender: 'male', ageTag: 'young' }], settings, 'card.png');
assert.equal(voices1[0].voiceId, voices2[0].voiceId);
const overridden = applyVoices([{ type: 'dialogue', speaker: '沈砚', voiceOverride: 'custom-voice' }], settings, 'card.png');
assert.equal(overridden[0].voiceId, 'custom-voice');

assert.equal(joinApiUrl('https://example.com/v1', '/v1/models'), 'https://example.com/v1/models');
assert.equal(buildTtsUrl({ baseUrl: 'https://api.minimaxi.com', groupId: '' }), 'https://api.minimaxi.com/v1/t2a_v2');
assert.equal(buildTtsUrl({ baseUrl: 'https://old.example', groupId: '123' }), 'https://old.example/v1/t2a_v2?GroupId=123');
const ttsBody = buildTtsBody({ text: '你好', voiceId: 'v1', speed: 1, emotion: 'calm' }, { model: 'speech-02-hd', globalSpeed: 1 });
assert.equal(ttsBody.audio_setting.format, 'mp3');
assert.equal(ttsBody.audio_setting.sample_rate, 32000);
assert.equal(ttsBody.voice_setting.emotion, 'calm');
assert.ok(EMOTIONS.includes('whipser'));
assert.equal(classifyTtsError({ httpStatus: 429, message: 'too many requests' }).kind, 'rate_limit');
assert.equal(classifyTtsError({ httpStatus: 429 }).retryable, true);
assert.equal(classifyTtsError({ httpStatus: 503 }).kind, 'server');
assert.equal(classifyTtsError({ httpStatus: 401 }).retryable, false);
assert.equal(classifyTtsError({ statusCode: 2049 }).kind, 'auth');
assert.equal(classifyTtsError({ statusCode: 2056 }).kind, 'quota');
assert.equal(classifyTtsError({ statusCode: 20132 }).kind, 'voice');

const retryService = new TtsService({ concurrency: 4, model: 'speech-02-hd' }, null, { retryDelays: [0, 0, 0] });
let retryCalls = 0;
retryService.adapter.synthesize = async () => {
    retryCalls++;
    if (retryCalls < 4) throw Object.assign(new Error('请求过于频繁'), { kind: 'rate_limit', retryable: true, label: '请求过于频繁', statusCode: 1002 });
    return new Blob(['ok'], { type: 'audio/mpeg' });
};
const retryResult = await retryService.synthesizeSegment({ text: '重试', voiceId: 'v1', speed: 1, emotion: 'calm' });
assert.equal(retryCalls, 4);
assert.equal(retryResult.attempts, 4);
assert.equal(retryService.effectiveConcurrency, 1);
assert.equal(Boolean(retryResult.blob), true);

const nonRetryService = new TtsService({ concurrency: 3, model: 'speech-02-hd' }, null, { retryDelays: [0, 0, 0] });
let nonRetryCalls = 0;
nonRetryService.adapter.synthesize = async () => {
    nonRetryCalls++;
    throw Object.assign(new Error('密钥错误'), { kind: 'auth', retryable: false, label: '密钥无效', statusCode: 2049 });
};
const nonRetryResult = await nonRetryService.synthesizeSegment({ text: '不重试', voiceId: 'v1', speed: 1, emotion: 'calm' });
assert.equal(nonRetryCalls, 1);
assert.equal(nonRetryResult.errorKind, 'auth');

assert.equal(validateVoiceId('PlayHouse01'), 'PlayHouse01');
assert.throws(() => validateVoiceId('1bad'), /Voice ID/);
assert.throws(() => validateVoiceId('too_sh-'), /Voice ID/);
assert.equal(validateCloneFile({ name: 'sample.m4a', size: 1024 }, 12).name, 'sample.m4a');
assert.throws(() => validateCloneFile({ name: 'sample.aac', size: 1024 }, 12), /mp3/);
assert.throws(() => validateCloneFile({ name: 'sample.wav', size: 1024 }, 4), /10 秒/);
const cloneBody = buildCloneBody('12345678901234567890', { voiceId: 'PlayHouse01', noiseReduction: true, volumeNormalization: false });
assert.match(cloneBody, /"file_id":12345678901234567890/);
assert.equal(JSON.parse(cloneBody).voice_id, 'PlayHouse01');
assert.equal(buildCloneUrl({ baseUrl: 'https://api.minimaxi.com', groupId: '' }, '/v1/files/upload'), 'https://api.minimaxi.com/v1/files/upload');
assert.equal(buildCloneUrl({ baseUrl: 'https://old.example/v1', groupId: '42' }, '/v1/voice_clone'), 'https://old.example/v1/voice_clone?GroupId=42');

const fakeAudioBuffer = values => ({
    sampleRate: 1000,
    numberOfChannels: 1,
    length: values.length,
    getChannelData: () => Float32Array.from(values),
});
const pcm = audioBufferToMonoPcm16(fakeAudioBuffer([-1, -.5, 0, .5, 1]));
assert.deepEqual([...pcm], [-32768, -16384, 0, 16384, 32767]);
assert.equal(gapBetweenMs({ type: 'narration', speaker: '' }, { type: 'dialogue', speaker: '甲' }, { afterNarration: 300, speakerSwitch: 250 }), 550);
assert.equal(gapBetweenMs({ type: 'dialogue', speaker: '甲' }, { type: 'dialogue', speaker: '甲' }, { afterDialogue: 0, speakerSwitch: 250 }), 0);
const backgroundItems = [
    { type: 'narration', speaker: '', blob: new Blob(['n']) },
    { type: 'dialogue', speaker: '甲', blob: new Blob(['d']) },
];
const backgroundTrack = await buildBackgroundTrack(backgroundItems, {
    gaps: { afterNarration: 300, afterDialogue: 200, speakerSwitch: 250 },
    decode: async () => fakeAudioBuffer(Array(100).fill(.25)),
});
assert.equal(backgroundTrack.cues.length, 2);
assert.equal(backgroundTrack.cues[1].start, .65);
assert.equal(backgroundTrack.duration, .75);
assert.equal(backgroundTrack.blob.size, 1544);
assert.equal(new TextDecoder().decode((await backgroundTrack.blob.arrayBuffer()).slice(0, 4)), 'RIFF');
const dialogueBackground = await buildBackgroundTrack(backgroundItems, {
    mode: 'dialogue',
    decode: async () => fakeAudioBuffer(Array(100).fill(.25)),
});
assert.deepEqual(dialogueBackground.cues.map(cue => cue.index), [1]);

const [indexSource, panelSource, styleSource] = await Promise.all([
    readFile(new URL('./index.js', import.meta.url), 'utf8'),
    readFile(new URL('./panel.html', import.meta.url), 'utf8'),
    readFile(new URL('./style.css', import.meta.url), 'utf8'),
]);
assert.match(indexSource, /!settings\.miniPlayerVisible/);
assert.match(indexSource, /\['ph_reread', 'ph_bar_restart'\]/);
assert.match(indexSource, /ph_bar_hide.+hideMiniPlayer/);
assert.match(indexSource, /prepareBackgroundForCurrent/);
assert.match(panelSource, /id="ph_mini_player"/);
assert.match(panelSource, /id="ph_background_playback"/);
assert.match(panelSource, /id="ph_bar_restart"[^>]+本层从头播放/);
assert.match(panelSource, /id="ph_bar_hide"[^>]+隐藏迷你播放条/);
assert.match(styleSource, /--ph-control-bg: #262320/);
assert.match(styleSource, /--ph-control-fg: #f1ece8/);
assert.match(styleSource, /background-color: var\(--ph-control-bg\) !important/);
assert.match(styleSource, /-webkit-text-fill-color: var\(--ph-control-fg\)/);
assert.match(styleSource, /input:-webkit-autofill/);

console.log('梨园纯模块测试通过');
