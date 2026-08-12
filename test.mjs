import assert from 'node:assert/strict';
import { extractTaggedContent, parseContentTags, segmentText } from './src/segmenter.js';
import { normalizeDirectorResult } from './src/director.js';
import { applyVoices, clearRuntimeSpeakerMap } from './src/voicebank.js';
import { cloneDefaults, EMOTIONS } from './src/constants.js';
import { buildTtsBody, buildTtsUrl, classifyTtsError, TtsService } from './src/tts.js';
import { buildCloneBody, buildCloneUrl, validateCloneFile, validateVoiceId } from './src/voiceclone.js';
import { joinApiUrl } from './src/utils.js';
import { readFile } from 'node:fs/promises';

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

const settings = cloneDefaults();
assert.equal(settings.miniPlayerVisible, true);
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

const [indexSource, panelSource] = await Promise.all([
    readFile(new URL('./index.js', import.meta.url), 'utf8'),
    readFile(new URL('./panel.html', import.meta.url), 'utf8'),
]);
assert.match(indexSource, /!settings\.miniPlayerVisible/);
assert.match(indexSource, /\['ph_reread', 'ph_bar_restart'\]/);
assert.match(indexSource, /ph_bar_hide.+hideMiniPlayer/);
assert.match(panelSource, /id="ph_mini_player"/);
assert.match(panelSource, /id="ph_bar_restart"[^>]+本层从头播放/);
assert.match(panelSource, /id="ph_bar_hide"[^>]+隐藏迷你播放条/);

console.log('梨园纯模块测试通过');
