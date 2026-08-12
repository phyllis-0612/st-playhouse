import assert from 'node:assert/strict';
import { extractTaggedContent, parseContentTags, segmentText } from './src/segmenter.js';
import { normalizeDirectorResult } from './src/director.js';
import { applyVoices, clearRuntimeSpeakerMap } from './src/voicebank.js';
import { cloneDefaults, EMOTIONS } from './src/constants.js';
import { buildTtsBody, buildTtsUrl } from './src/tts.js';
import { joinApiUrl } from './src/utils.js';

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
clearRuntimeSpeakerMap();
const voices1 = applyVoices([{ type: 'dialogue', speaker: '沈砚', gender: 'male', ageTag: 'young' }], settings, 'card.png');
clearRuntimeSpeakerMap();
const voices2 = applyVoices([{ type: 'dialogue', speaker: '沈砚', gender: 'male', ageTag: 'young' }], settings, 'card.png');
assert.equal(voices1[0].voiceId, voices2[0].voiceId);

assert.equal(joinApiUrl('https://example.com/v1', '/v1/models'), 'https://example.com/v1/models');
assert.equal(buildTtsUrl({ baseUrl: 'https://api.minimaxi.com', groupId: '' }), 'https://api.minimaxi.com/v1/t2a_v2');
assert.equal(buildTtsUrl({ baseUrl: 'https://old.example', groupId: '123' }), 'https://old.example/v1/t2a_v2?GroupId=123');
const ttsBody = buildTtsBody({ text: '你好', voiceId: 'v1', speed: 1, emotion: 'calm' }, { model: 'speech-02-hd', globalSpeed: 1 });
assert.equal(ttsBody.audio_setting.format, 'mp3');
assert.equal(ttsBody.audio_setting.sample_rate, 32000);
assert.equal(ttsBody.voice_setting.emotion, 'calm');
assert.ok(EMOTIONS.includes('whipser'));

console.log('梨园纯模块测试通过');
