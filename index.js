import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { AudioCache } from './src/cache.js';
import { cloneDefaults, MODULE_NAME, SETTINGS_KEY } from './src/constants.js';
import { directSegments, listModels } from './src/director.js';
import { WebAudioPlayer } from './src/player.js';
import { extractTaggedContent, parseContentTags, segmentText } from './src/segmenter.js';
import { TtsService } from './src/tts.js';
import { readAudioDuration, validateCloneFile, validateVoiceId, VoiceCloneService } from './src/voiceclone.js';
import { applyVoices, bindSpeaker, clearRuntimeSpeakerMap, getNewSpeakers } from './src/voicebank.js';
import { assertSecureUrl, clamp, escapeHtml, hashString, mergeDefaults } from './src/utils.js';

const context = () => SillyTavern.getContext();
let settings;
let cache;
let player;
let targetMessageId = -1;
let currentSegments = [];
let pipelineController = null;
let previousPanelPage = 'read';
let messageObserver = null;
let cloneController = null;
let regenerationController = null;
let activeCueEditorIndex = -1;

const $id = id => document.getElementById(id);
const toast = (type, message, title = '梨园') => globalThis.toastr?.[type]?.(message, title) ?? console[type === 'error' ? 'error' : 'log'](`[${title}] ${message}`);

function saveSettings() {
    context().saveSettingsDebounced?.();
}

function saved(label) {
    saveSettings();
    toast('success', `${label}已保存`);
}

function setCloneStatus(message, state = '') {
    const node = $id('ph_clone_status');
    if (!node) return;
    node.textContent = message;
    node.dataset.state = state;
}

function loadSettings() {
    extension_settings[SETTINGS_KEY] = mergeDefaults(extension_settings[SETTINGS_KEY], cloneDefaults());
    settings = extension_settings[SETTINGS_KEY];
}

function activePreset() {
    return settings.apiPresets.find(item => item.id === settings.activePresetId) ?? settings.apiPresets[0];
}

function getAiMessageIds() {
    return context().chat.map((message, id) => ({ message, id }))
        .filter(({ message }) => message && !message.is_user && !message.is_system && String(message.mes ?? '').trim())
        .map(({ id }) => id);
}

function getMessage(messageId = targetMessageId) {
    return context().chat?.[Number(messageId)] ?? null;
}

function getCardKey(message = getMessage()) {
    const ctx = context();
    if (message?.original_avatar) return message.original_avatar;
    if (message?.force_avatar) {
        const candidate = ctx.characters.find(character => message.force_avatar.includes(encodeURIComponent(character.avatar)) || message.force_avatar.includes(character.avatar));
        if (candidate?.avatar) return candidate.avatar;
    }
    return ctx.characters?.[ctx.characterId]?.avatar || `${message?.name || ctx.name2 || 'unknown'}.png`;
}

function knownSpeakers(message = getMessage()) {
    const ctx = context();
    const names = new Set([message?.name, ctx.name1, ctx.name2]);
    if (ctx.groupId) {
        const group = ctx.groups.find(item => item.id == ctx.groupId);
        for (const avatar of group?.members ?? []) {
            const character = ctx.characters.find(item => item.avatar === avatar);
            if (character?.name) names.add(character.name);
        }
    }
    const binding = settings.bindings?.[getCardKey(message)];
    names.add(binding?.main?.speaker);
    for (const extra of binding?.extras ?? []) names.add(extra?.speaker);
    return [...names].filter(Boolean);
}

function speakerColor(speaker) {
    if (!speaker) return 'var(--ph-muted)';
    return `hsl(${hashString(speaker) % 360} 48% 58%)`;
}

function setTarget(messageId) {
    const ids = getAiMessageIds();
    if (!ids.length) messageId = -1;
    else if (!ids.includes(Number(messageId))) messageId = ids[ids.length - 1];
    if (targetMessageId !== Number(messageId)) {
        regenerationController?.abort();
        activeCueEditorIndex = -1;
    }
    targetMessageId = Number(messageId);
    renderTarget();
}

function renderTarget() {
    const message = getMessage();
    const extracted = message ? extractTaggedContent(message.mes, settings.contentTags) : null;
    const ids = getAiMessageIds();
    const position = ids.indexOf(targetMessageId);
    $id('ph_prev_message').disabled = position <= 0;
    $id('ph_next_message').disabled = position < 0 || position >= ids.length - 1;
    $id('ph_target_label').textContent = position < 0 ? '没有可朗读的消息' : `第 ${targetMessageId} 楼 · ${position === ids.length - 1 ? '最新一条' : `${position + 1}/${ids.length}`}`;
    $id('ph_target_name').textContent = message?.name || '—';
    $id('ph_target_preview').textContent = message
        ? (extracted?.text.replace(/\s+/g, ' ').slice(0, 180) || `未找到正文标签：${extracted?.tags.map(tag => `<${tag}>`).join('、')}`)
        : '打开一个聊天，然后选择 AI 消息。';
    const saved = context().chatMetadata?.playhouse?.tracks?.[targetMessageId];
    const savedMatchesSource = Boolean(extracted?.text && saved?.sourceText === extracted.text);
    const segments = currentSegments.length && targetMessageId === Number($id('ph_track_view')?.dataset.messageId) ? currentSegments : savedMatchesSource ? saved?.segments : null;
    if (segments?.length) {
        currentSegments = segments;
        $id('ph_target_status').textContent = `已分轨 · ${segments.length} 段 · ${new Set(segments.filter(item => item.speaker).map(item => item.speaker)).size} 人${segments.some(item => item.type === 'narration') ? ' + 旁白' : ''}`;
        renderSegments();
    } else {
        currentSegments = [];
        $id('ph_target_status').textContent = message ? '尚未分轨' : '等待消息';
        $id('ph_empty').hidden = false;
        $id('ph_track_view').hidden = true;
        $id('ph_process').hidden = !message;
    }
    renderBindings();
}

function renderSegments() {
    const mode = player?.mode || settings.narrationMode;
    const legal = currentSegments.filter(item => mode === 'full' || item.type === 'dialogue');
    const totalLength = currentSegments.reduce((sum, item) => sum + item.text.length, 0) || 1;
    $id('ph_empty').hidden = true;
    $id('ph_track_view').hidden = false;
    $id('ph_track_view').dataset.messageId = String(targetMessageId);
    $id('ph_process').hidden = true;
    $id('ph_track_bar').classList.toggle('ph-dialogue', mode === 'dialogue');
    $id('ph_track_bar').innerHTML = currentSegments.map((item, index) => `<span data-type="${item.type}" class="${index === player?.cursor ? 'ph-live' : index < (player?.cursor ?? -1) ? 'ph-played' : ''}" style="--seg-color:${speakerColor(item.speaker)};flex-grow:${Math.max(1, item.text.length / totalLength * 100)}"></span>`).join('');
    $id('ph_track_left').textContent = mode === 'dialogue' ? `只读台词 · ${legal.length} 句` : `戏折子 · ${currentSegments.length} 段`;
    $id('ph_track_right').textContent = mode === 'dialogue' ? `跳过 ${currentSegments.length - legal.length} 段旁白` : `${new Set(currentSegments.filter(item => item.speaker).map(item => item.speaker)).size} 人 + 旁白`;
    const failed = currentSegments.filter(item => item.error);
    $id('ph_failed_actions').hidden = !failed.length;
    $id('ph_failed_summary').textContent = failed.length ? `${failed.length} 段合成失败` : '';
    $id('ph_cues').innerHTML = currentSegments.map((item, index) => {
        const state = item.regenerating ? (item.retryMessage || '生成中…') : item.error ? '重试' : item.blob ? '调整' : '等待';
        return `<div role="listitem" tabindex="0" class="ph-cue ${index === player?.cursor ? 'ph-live' : ''} ${item.error ? 'ph-error' : ''}" data-index="${index}" data-hidden="${mode === 'dialogue' && item.type === 'narration'}" data-regenerating="${Boolean(item.regenerating)}" style="--seg-color:${speakerColor(item.speaker)}"><span class="ph-cue-color"></span><span class="ph-cue-who">${escapeHtml(item.speaker || '旁白')}</span><span class="ph-cue-text">${escapeHtml(item.text)}</span><button type="button" class="ph-cue-state" data-cue-action="${item.error ? 'retry' : 'edit'}" ${item.regenerating ? 'disabled' : ''}>${escapeHtml(state)}</button></div>`;
    }).join('');
    renderCueEditor();
    const newcomers = getNewSpeakers(currentSegments, settings, getCardKey());
    renderNewSpeaker(newcomers[0]);
}

function renderCueEditor() {
    const editor = $id('ph_cue_editor');
    const item = currentSegments[activeCueEditorIndex];
    if (!editor || !item) {
        activeCueEditorIndex = -1;
        if (editor) { editor.hidden = true; editor.innerHTML = ''; }
        return;
    }
    const sameSpeakerCount = item.type === 'dialogue' && item.speaker
        ? currentSegments.filter(segment => segment.type === 'dialogue' && segment.speaker === item.speaker).length
        : 0;
    const sameItem = editor.dataset.index === String(activeCueEditorIndex);
    editor.hidden = false;
    editor.dataset.index = String(activeCueEditorIndex);
    editor.innerHTML = `<div class="ph-cue-editor-head"><div><strong>第 ${activeCueEditorIndex + 1} 段 · ${escapeHtml(item.speaker || '旁白')}</strong><small>${escapeHtml(item.text)}</small></div><button type="button" class="ph-cue-editor-close" data-cue-close aria-label="关闭调整">×</button></div>${item.error ? `<p class="ph-cue-error-detail">${escapeHtml(item.error)}</p>` : ''}<label class="ph-field"><span>重新合成使用的音色</span><select data-cue-voice>${voiceOptions(item.voiceId, false)}</select></label><div class="ph-row"><button type="button" class="ph-btn ph-primary" data-regenerate-one><i class="fa-solid fa-rotate"></i> 重新合成此段</button>${sameSpeakerCount ? `<button type="button" class="ph-btn" data-regenerate-speaker><i class="fa-solid fa-user-pen"></i> 替换该角色 ${sameSpeakerCount} 段</button>` : ''}</div><p class="ph-cue-scope">单段只修改这一句；替换角色会保存角色绑定，并重新合成当前消息里该角色的全部台词。</p>`;
    if (!sameItem) editor.scrollIntoView({ block: 'nearest' });
}

function renderNewSpeaker(speaker) {
    const container = $id('ph_new_speaker');
    if (!speaker) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }
    const options = voiceOptions('', true);
    container.hidden = false;
    container.innerHTML = `检测到新角色「<b>${escapeHtml(speaker)}</b>」，现在用的是自动挑的嗓子。要钉住吗？<div class="ph-row"><select data-new-speaker="${escapeHtml(speaker)}">${options}</select><button type="button" class="ph-btn ph-primary" data-bind-new="${escapeHtml(speaker)}">钉住</button><button type="button" class="ph-btn" data-dismiss-new>这次不用</button></div>`;
}

function renderPlayer() {
    const item = player.items[player.cursor];
    const legal = player.items.map((value, index) => ({ value, index })).filter(({ value }) => player.mode === 'full' || value.type === 'dialogue');
    const position = legal.findIndex(entry => entry.index === player.cursor);
    const playing = player.state === 'playing' || player.state === 'loading';
    const icon = playing ? 'fa-pause' : 'fa-play';
    $id('ph_play').innerHTML = `<i class="fa-solid ${icon}"></i>`;
    $id('ph_bar_play').innerHTML = `<i class="fa-solid ${icon}"></i>`;
    $id('ph_now_text').textContent = item ? `${item.speaker || '旁白'} · ${item.text.slice(0, 24)}` : '尚未开始';
    $id('ph_now_count').textContent = position < 0 ? '—/—' : `${position + 1}/${legal.length}`;
    $id('ph_bar_status').textContent = player.state === 'needs-gesture' ? '点播放以继续声音' : item ? `${item.speaker || '旁白'} · ${item.text.slice(0, 30)}` : '梨园准备好了';
    $id('ph_unlock_hint').hidden = player.unlocked && player.state !== 'needs-gesture';
    $id('ph_mode_full').setAttribute('aria-pressed', String(player.mode === 'full'));
    $id('ph_mode_dialogue').setAttribute('aria-pressed', String(player.mode === 'dialogue'));
    $id('ph_bar_mode').textContent = player.mode === 'full' ? '旁白 + 台词' : '只读台词';
    $id('playhouse_player_bar').hidden = !settings.miniPlayerVisible || (!player.items.length && !getMessage());
    renderSegmentsIfPresent();
    highlightCurrentSegment();
}

function renderSegmentsIfPresent() {
    if (!$id('ph_track_view').hidden && currentSegments.length) renderSegments();
}

function clearSegmentHighlights() {
    for (const mark of document.querySelectorAll('.playhouse-reading-mark')) mark.replaceWith(document.createTextNode(mark.textContent));
    document.querySelectorAll('.mes.playhouse-reading-message').forEach(node => node.classList.remove('playhouse-reading-message'));
}

function highlightCurrentSegment() {
    clearSegmentHighlights();
    const item = player.items[player.cursor];
    if (!item || targetMessageId < 0) return;
    const messageElement = document.querySelector(`#chat .mes[mesid="${targetMessageId}"]`);
    const root = messageElement?.querySelector('.mes_text');
    if (!root) return;
    messageElement.classList.add('playhouse-reading-message');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        const index = node.nodeValue.indexOf(item.text);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + item.text.length);
        const mark = document.createElement('mark');
        mark.className = 'playhouse-reading-mark';
        range.surroundContents(mark);
        break;
    }
}

async function processMessage(messageId, { forceDirector = false, autoPlay = true } = {}) {
    const message = getMessage(messageId);
    if (!message) return;
    if (!settings.enabled) return toast('info', '梨园目前是关闭的');
    try {
        assertSecureUrl(activePreset()?.baseUrl);
        assertSecureUrl(settings.tts.baseUrl);
        if (!activePreset()?.apiKey) throw new Error('请先填写分轨 API Key');
        if (!settings.tts.apiKey) throw new Error('请先填写 MiniMax API Key');
        if (!settings.voiceBank.length || !settings.fallbackVoiceId) throw new Error('请先在音色页设置至少一个音色和兜底音色');
    } catch (error) {
        openPanel('settings');
        toast('error', error.message);
        return;
    }
    pipelineController?.abort();
    regenerationController?.abort();
    pipelineController = new AbortController();
    setTarget(messageId);
    $id('ph_target_status').textContent = '正在本地切分…';
    const extracted = extractTaggedContent(message.mes, settings.contentTags);
    if (!extracted.text) {
        const expected = extracted.tags.map(tag => `<${tag}>…</${tag}>`).join(' 或 ');
        $id('ph_target_status').textContent = '未找到正文标签';
        return toast('warning', `没有找到 ${expected}，为避免读取 COT、摘要或状态栏，梨园已停止。`);
    }
    const local = segmentText(extracted.text);
    if (!local.length) return toast('warning', '这条消息没有可朗读的正文');
    const metadata = context().chatMetadata;
    metadata.playhouse ||= { tracks: {} };
    const savedTrack = metadata.playhouse.tracks?.[messageId];
    let segments = !forceDirector && savedTrack?.sourceText === extracted.text ? savedTrack.segments : null;
    try {
        if (!segments?.length) {
            $id('ph_target_status').textContent = `正在分轨 · ${local.length} 段…`;
            segments = await directSegments(local, activePreset(), knownSpeakers(message), { signal: pipelineController.signal });
            segments = applyVoices(segments, settings, getCardKey(message));
            metadata.playhouse.tracks[messageId] = { segments, sourceText: extracted.text, matchedTags: extracted.matchedTags, updatedAt: Date.now() };
            context().saveMetadataDebounced?.();
        } else {
            segments = applyVoices(segments, settings, getCardKey(message));
        }
        currentSegments = segments;
        renderSegments();
        $id('ph_target_status').textContent = `正在合成 · 0/${segments.length}`;
        const service = new TtsService(settings.tts, cache);
        let completed = 0;
        const results = await Promise.all(segments.map(async segment => {
            const result = await service.synthesizeSegment(segment, {
                signal: pipelineController.signal,
                onRetry: detail => {
                    const match = currentSegments.find(item => item.idx === segment.idx);
                    if (match) {
                        match.regenerating = true;
                        match.retryMessage = retryStatusMessage(detail);
                        renderSegments();
                    }
                },
            });
            completed++;
            $id('ph_target_status').textContent = `正在合成 · ${completed}/${segments.length}`;
            const matchIndex = currentSegments.findIndex(item => item.idx === result.idx);
            if (matchIndex >= 0) currentSegments[matchIndex] = result;
            renderSegments();
            return result;
        }));
        currentSegments = results;
        player.setQueue(results, settings.narrationMode);
        const failed = results.filter(item => item.error).length;
        $id('ph_target_status').textContent = failed
            ? `已就绪 · ${results.length - failed}/${results.length} 段 · ${failed} 段失败`
            : `已就绪 · ${results.length}/${results.length} 段`;
        renderPlayer();
        if (autoPlay) await player.play();
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('[梨园] 流水线失败', error);
        $id('ph_target_status').textContent = `失败 · ${error.message}`;
        toast('error', error.message);
    }
}

function persistTrackVoiceOverrides(indices) {
    const track = context().chatMetadata?.playhouse?.tracks?.[targetMessageId];
    if (!track?.segments) return;
    for (const index of indices) {
        const current = currentSegments[index];
        const stored = track.segments.find(item => item.idx === current?.idx);
        if (!stored || !current) continue;
        if (current.voiceOverride) stored.voiceOverride = current.voiceOverride;
        else delete stored.voiceOverride;
    }
    track.updatedAt = Date.now();
    context().saveMetadataDebounced?.();
}

function retryStatusMessage(detail) {
    const seconds = Math.max(1, Math.round(detail.delay / 100) / 10);
    if (detail.error.kind === 'rate_limit') return `限流，${seconds}秒后重试 · 并发降至 ${detail.concurrency}`;
    return `${detail.error.label}，${seconds}秒后重试`;
}

async function regenerateSegments(indices, { voiceId = '', reason = '重新合成' } = {}) {
    const unique = [...new Set(indices.map(Number).filter(index => currentSegments[index]))];
    if (!unique.length) return;
    regenerationController?.abort();
    regenerationController = new AbortController();
    player.pause();
    for (const index of unique) {
        const item = currentSegments[index];
        if (voiceId && voiceId !== item.voiceId) item.voiceOverride = voiceId;
        if (voiceId) item.voiceId = voiceId;
        item.regenerating = true;
        item.retryMessage = '生成中…';
    }
    persistTrackVoiceOverrides(unique);
    renderSegments();
    $id('ph_target_status').textContent = `${reason} · 0/${unique.length}`;
    const service = new TtsService(settings.tts, cache);
    let completed = 0;
    try {
        const results = await Promise.all(unique.map(async index => {
            const item = currentSegments[index];
            const result = await service.synthesizeSegment(item, {
                signal: regenerationController.signal,
                force: true,
                onRetry: detail => {
                    item.retryMessage = retryStatusMessage(detail);
                    renderSegments();
                },
            });
            currentSegments[index] = result;
            completed++;
            $id('ph_target_status').textContent = `${reason} · ${completed}/${unique.length}`;
            renderSegments();
            return result;
        }));
        player.replaceItems(currentSegments);
        const failures = results.filter(item => item.error).length;
        $id('ph_target_status').textContent = failures
            ? `${reason}完成 · ${results.length - failures} 成功，${failures} 失败`
            : `${reason}完成 · ${results.length} 段成功`;
        renderPlayer();
        toast(failures ? 'warning' : 'success', failures ? `${failures} 段仍失败，可点失败段查看原因` : `${reason}成功`);
    } catch (error) {
        if (error.name !== 'AbortError') toast('error', error.message);
    }
}

function openCueEditor(index) {
    activeCueEditorIndex = Number(index);
    renderSegments();
}

function selectedCueVoice() {
    return $id('ph_cue_editor').querySelector('[data-cue-voice]')?.value || '';
}

async function regenerateActiveCue() {
    const index = activeCueEditorIndex;
    const voiceId = selectedCueVoice();
    if (!currentSegments[index] || !voiceId) return toast('warning', '请选择音色');
    await regenerateSegments([index], { voiceId, reason: '重新合成此段' });
}

async function regenerateActiveSpeaker() {
    const item = currentSegments[activeCueEditorIndex];
    const voiceId = selectedCueVoice();
    if (!item?.speaker || !voiceId) return toast('warning', '请选择角色音色');
    const indices = currentSegments.map((segment, index) => ({ segment, index }))
        .filter(entry => entry.segment.type === 'dialogue' && entry.segment.speaker === item.speaker)
        .map(entry => entry.index);
    if (!globalThis.confirm(`将把「${item.speaker}」替换为新音色，并重新合成 ${indices.length} 段台词。\n\n这会产生新的 MiniMax 合成费用，确定继续吗？`)) return;
    const cardKey = getCardKey();
    bindSpeaker(settings, cardKey, item.speaker, voiceId);
    const binding = settings.bindings?.[cardKey];
    const bound = binding?.main?.speaker === item.speaker ? binding.main : binding?.extras?.find(entry => entry.speaker === item.speaker);
    if (bound) bound.speed ||= 1;
    saveSettings();
    await regenerateSegments(indices, { voiceId, reason: `替换「${item.speaker}」` });
    renderBindings();
}

function setMode(mode) {
    settings.narrationMode = mode === 'dialogue' ? 'dialogue' : 'full';
    player.setMode(settings.narrationMode);
    saveSettings();
    renderPlayer();
}

function playOrPause() {
    const resumed = player.unlockFromGesture();
    if (player.state === 'playing' || player.state === 'loading') player.pause();
    else if (player.items.length) void Promise.resolve(resumed).then(() => player.play());
    else void Promise.resolve(resumed).then(() => processMessage(targetMessageId));
}

function replayFromStart() {
    const resumed = player.unlockFromGesture();
    if (player.items.length) {
        const first = player.nextLegal(-1, 1);
        if (first >= 0) void Promise.resolve(resumed).then(() => player.play(first));
        return;
    }
    void Promise.resolve(resumed).then(() => processMessage(targetMessageId));
}

function hideMiniPlayer() {
    settings.miniPlayerVisible = false;
    $id('ph_mini_player').checked = false;
    saveSettings();
    renderPlayer();
    toast('info', '迷你播放条已隐藏，可在“设置 → 朗读”重新开启');
}

function openPanel(page = 'read') {
    $id('playhouse_panel').hidden = false;
    showPanelPage(page);
    if (targetMessageId < 0) {
        const ids = getAiMessageIds();
        setTarget(ids[ids.length - 1]);
    }
    renderSettings();
    renderTarget();
}

function closePanel() {
    $id('playhouse_panel').hidden = true;
}

function showPanelPage(page) {
    if (page !== 'help') previousPanelPage = page;
    document.querySelectorAll('.ph-page').forEach(node => { node.hidden = node.dataset.page !== page; });
    document.querySelectorAll('.ph-tabs button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.page === page)));
    $id('ph_footer').hidden = page !== 'read';
    $id('playhouse_panel').querySelector('.ph-tabs').hidden = page === 'help';
}

function cycleTheme() {
    const modes = ['follow', 'light', 'dark'];
    settings.theme = modes[(modes.indexOf(settings.theme) + 1) % modes.length];
    $id('playhouse_panel').dataset.theme = settings.theme;
    $id('ph_theme').title = `主题：${{ follow: '跟随酒馆', light: '日间', dark: '夜间' }[settings.theme]}`;
    saveSettings();
}

function voiceOptions(selected = '', includeEmpty = false) {
    const head = includeEmpty ? '<option value="">自动挑 / 不覆盖</option>' : '';
    return head + settings.voiceBank.map(voice => `<option value="${escapeHtml(voice.voiceId)}" ${voice.voiceId === selected ? 'selected' : ''}>${escapeHtml(voice.label || voice.voiceId)}</option>`).join('');
}

function fillVoiceSelect(id, selected, includeEmpty = false) {
    const select = $id(id);
    if (!select) return;
    select.innerHTML = voiceOptions(selected, includeEmpty);
    select.value = selected || '';
}

function renderBindings() {
    const cardKey = getCardKey();
    const binding = settings.bindings?.[cardKey] ?? { main: null, extras: [], narrator: '' };
    $id('ph_binding_key').textContent = `索引：${cardKey}`;
    $id('ph_main_speaker').value = binding.main?.speaker || getMessage()?.name || '';
    fillVoiceSelect('ph_main_voice', binding.main?.voiceId || '', true);
    fillVoiceSelect('ph_card_narrator', binding.narrator || '', true);
    fillVoiceSelect('ph_extra_voice', '', false);
    $id('ph_extras').innerHTML = (binding.extras ?? []).map((item, index) => `<div class="ph-card"><div><strong>${escapeHtml(item.speaker)}</strong><small>${escapeHtml(settings.voiceBank.find(voice => voice.voiceId === item.voiceId)?.label || item.voiceId)}</small></div><button type="button" data-remove-extra="${index}" aria-label="移除"><i class="fa-solid fa-trash"></i></button></div>`).join('') || '<p class="ph-hint">还没有常驻配角。</p>';
}

function renderVoiceBank() {
    $id('ph_voice_list').innerHTML = settings.voiceBank.map((voice, index) => `<div class="ph-card"><div><strong>${escapeHtml(voice.label || voice.voiceId)}</strong><small>${escapeHtml([voice.gender, voice.ageTag, voice.toneTag, voice.voiceId].filter(Boolean).join(' · '))}</small></div><button type="button" data-preview-voice="${index}" aria-label="试听"><i class="fa-solid fa-play"></i></button><button type="button" data-remove-voice="${index}" aria-label="删除"><i class="fa-solid fa-trash"></i></button></div>`).join('') || '<p class="ph-hint">音色库是空的。</p>';
    for (const id of ['ph_narrator', 'ph_fallback']) fillVoiceSelect(id, id === 'ph_narrator' ? settings.narratorVoiceId : settings.fallbackVoiceId, true);
    const labels = { male_young: '男 · 青年', male_mature: '男 · 成熟', female_young: '女 · 青年', female_mature: '女 · 成熟', child: '儿童', unknown: '无法判断' };
    $id('ph_pool_fields').innerHTML = Object.entries(labels).map(([key, label]) => `<label class="ph-pool-field"><span>${label}</span><select multiple data-pool="${key}">${settings.voiceBank.map(voice => `<option value="${escapeHtml(voice.voiceId)}" ${(settings.fuzzyPools?.[key] ?? []).includes(voice.voiceId) ? 'selected' : ''}>${escapeHtml(voice.label || voice.voiceId)}</option>`).join('')}</select></label>`).join('');
}

function modelOptions(preset) {
    const fetched = settings.modelLists?.[preset.id] ?? [];
    const models = [...new Set([preset.model, ...fetched].filter(Boolean))];
    const options = models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
    return `${options}<option value="__manual__">手动填写…</option>`;
}

function selectedDirectorModel() {
    const select = $id('ph_director_model');
    return select.value === '__manual__' ? $id('ph_director_model_custom').value.trim() : select.value.trim();
}

function renderDirectorModel(preset) {
    const select = $id('ph_director_model');
    const custom = $id('ph_director_model_custom');
    const field = $id('ph_director_model_custom_field');
    select.innerHTML = modelOptions(preset);
    if (preset.model && [...select.options].some(option => option.value === preset.model)) {
        select.value = preset.model;
        custom.value = '';
        field.hidden = true;
    } else {
        select.value = '__manual__';
        custom.value = preset.model || '';
        field.hidden = false;
    }
}

function renderPreset() {
    $id('ph_preset').innerHTML = settings.apiPresets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    $id('ph_preset').value = settings.activePresetId;
    const preset = activePreset();
    if (!preset) return;
    $id('ph_preset_name').value = preset.name;
    $id('ph_director_url').value = preset.baseUrl;
    $id('ph_director_key').value = preset.apiKey;
    renderDirectorModel(preset);
    $id('ph_director_temp').value = preset.temperature;
    $id('ph_director_tokens').value = preset.maxTokens ?? '';
}

function renderSettings() {
    if (!$id('playhouse_panel')) return;
    $id('playhouse_panel').dataset.theme = settings.theme;
    $id('ph_enabled').checked = settings.enabled;
    $id('ph_auto').checked = settings.trigger === 'auto';
    $id('ph_mini_player').checked = settings.miniPlayerVisible;
    $id('ph_default_mode').value = settings.narrationMode;
    $id('ph_content_tags').value = parseContentTags(settings.contentTags).join(', ');
    $id('ph_global_speed').value = settings.tts.globalSpeed;
    $id('ph_global_speed_out').textContent = `${Number(settings.tts.globalSpeed).toFixed(2)}×`;
    $id('ph_gap_narration').value = settings.gapMs.afterNarration;
    $id('ph_gap_dialogue').value = settings.gapMs.afterDialogue;
    $id('ph_gap_speaker').value = settings.gapMs.speakerSwitch;
    $id('ph_read_summary').textContent = settings.trigger === 'auto' ? '自动' : '手动';
    renderPreset();
    $id('ph_tts_url').value = settings.tts.baseUrl;
    $id('ph_tts_key').value = settings.tts.apiKey;
    $id('ph_tts_group').value = settings.tts.groupId;
    $id('ph_tts_model').value = settings.tts.model;
    $id('ph_concurrency').value = settings.tts.concurrency;
    $id('ph_cache_enabled').checked = settings.cache.enabled;
    $id('ph_cache_max').value = settings.cache.maxMB;
    renderVoiceBank();
    renderBindings();
    void updateCacheUsage();
}

async function updateCacheUsage() {
    const usage = await cache?.usage();
    $id('ph_cache_usage').textContent = cache?.available ? `${((usage?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB` : '当前环境不支持缓存';
}

function persistPresetForm() {
    const preset = activePreset();
    if (!preset) return;
    preset.name = $id('ph_preset_name').value.trim() || preset.name;
    preset.baseUrl = $id('ph_director_url').value.trim();
    preset.apiKey = $id('ph_director_key').value.trim();
    preset.model = selectedDirectorModel();
    preset.temperature = clamp($id('ph_director_temp').value, 0, 2, 0);
    preset.maxTokens = $id('ph_director_tokens').value ? Math.max(1, Number($id('ph_director_tokens').value)) : null;
    renderPreset();
    saveSettings();
}

function persistTtsForm() {
    settings.tts.baseUrl = $id('ph_tts_url').value.trim();
    settings.tts.apiKey = $id('ph_tts_key').value.trim();
    settings.tts.groupId = $id('ph_tts_group').value.trim();
    settings.tts.model = $id('ph_tts_model').value;
    settings.tts.concurrency = clamp($id('ph_concurrency').value, 1, 8, 3);
    saveSettings();
}

function persistReadingForm() {
    settings.enabled = $id('ph_enabled').checked;
    settings.trigger = $id('ph_auto').checked ? 'auto' : 'manual';
    settings.miniPlayerVisible = $id('ph_mini_player').checked;
    settings.narrationMode = $id('ph_default_mode').value === 'dialogue' ? 'dialogue' : 'full';
    settings.contentTags = parseContentTags($id('ph_content_tags').value).join(',');
    settings.tts.globalSpeed = Number($id('ph_global_speed').value);
    settings.gapMs.afterNarration = clamp($id('ph_gap_narration').value, 0, 3000, 300);
    settings.gapMs.afterDialogue = clamp($id('ph_gap_dialogue').value, 0, 3000, 200);
    settings.gapMs.speakerSwitch = clamp($id('ph_gap_speaker').value, 0, 3000, 250);
    player.gaps = settings.gapMs;
    player.setMode(settings.narrationMode);
    currentSegments = [];
    saveSettings();
    renderSettings();
    renderPlayer();
    renderTarget();
}

function persistVoiceDefaults() {
    settings.narratorVoiceId = $id('ph_narrator').value;
    settings.fallbackVoiceId = $id('ph_fallback').value;
    for (const select of $id('ph_pool_fields').querySelectorAll('[data-pool]')) {
        settings.fuzzyPools[select.dataset.pool] = [...select.selectedOptions].map(option => option.value);
    }
    clearRuntimeSpeakerMap();
    saveSettings();
}

function persistCacheForm() {
    settings.cache.enabled = $id('ph_cache_enabled').checked;
    settings.cache.maxMB = clamp($id('ph_cache_max').value, 10, 2000, 200);
    cache.enabled = settings.cache.enabled;
    cache.maxMB = settings.cache.maxMB;
    saveSettings();
}

function saveBindingMain() {
    const cardKey = getCardKey();
    settings.bindings[cardKey] ||= { main: null, extras: [], narrator: '' };
    const speaker = $id('ph_main_speaker').value.trim();
    const voiceId = $id('ph_main_voice').value;
    settings.bindings[cardKey].main = speaker && voiceId ? { speaker, voiceId, speed: 1 } : null;
    settings.bindings[cardKey].narrator = $id('ph_card_narrator').value;
    clearRuntimeSpeakerMap();
    saveSettings();
}

async function cloneVoiceFromForm() {
    const file = $id('ph_clone_file').files?.[0];
    const button = $id('ph_clone_voice');
    if (!$id('ph_clone_consent').checked) return toast('warning', '请先确认已获得声音本人的许可');
    let voiceId;
    try {
        voiceId = validateVoiceId($id('ph_clone_voice_id').value);
        validateCloneFile(file);
        if (settings.voiceBank.some(voice => voice.voiceId === voiceId)) throw new Error('这个 Voice ID 已经在音色库里');
        persistTtsForm();
        assertSecureUrl(settings.tts.baseUrl);
    } catch (error) {
        setCloneStatus(error.message, 'error');
        return toast('error', error.message);
    }
    cloneController?.abort();
    cloneController = new AbortController();
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在克隆…';
    try {
        const service = new VoiceCloneService(settings.tts);
        const result = await service.create(file, {
            voiceId,
            noiseReduction: $id('ph_clone_denoise').checked,
            volumeNormalization: $id('ph_clone_normalize').checked,
        }, {
            signal: cloneController.signal,
            onProgress: message => setCloneStatus(message, 'working'),
        });
        const voice = {
            voiceId: result.voiceId,
            label: $id('ph_clone_label').value.trim() || result.voiceId,
            gender: $id('ph_clone_gender').value,
            ageTag: $id('ph_clone_age').value,
            toneTag: $id('ph_clone_tone').value.trim() || 'unknown',
            note: 'MiniMax 克隆音色',
        };
        settings.voiceBank.push(voice);
        saveSettings();
        let activated = false;
        if ($id('ph_clone_activate').checked) {
            setCloneStatus('音色创建成功，正在合成一句以激活…', 'working');
            const tts = new TtsService(settings.tts, cache);
            const sample = await tts.synthesizeSegment({ idx: 0, type: 'dialogue', speaker: voice.label, text: '你好，我是梨园新加入的声音。', voiceId, speed: 1, emotion: 'calm' });
            if (sample.error) throw new Error(`音色已创建并入库，但激活试听失败：${sample.error}`);
            activated = true;
            currentSegments = [sample];
            player.setQueue([sample], 'full');
            renderPlayer();
            await player.unlockFromGesture();
            await player.play();
        }
        for (const id of ['ph_clone_voice_id', 'ph_clone_label', 'ph_clone_tone']) $id(id).value = '';
        $id('ph_clone_file').value = '';
        $id('ph_clone_consent').checked = false;
        renderVoiceBank();
        setCloneStatus(`“${voice.label}”已创建、加入音色库${activated ? '并激活' : ''}`, 'success');
        toast('success', `音色 ${voice.voiceId} 已加入音色库`);
    } catch (error) {
        if (error.name !== 'AbortError') {
            const alreadyCreated = settings.voiceBank.some(voice => voice.voiceId === voiceId);
            const message = alreadyCreated ? `${error.message}；音色已保留在音色库，可稍后点试听完成激活` : error.message;
            setCloneStatus(message, alreadyCreated ? 'success' : 'error');
            renderVoiceBank();
            toast(alreadyCreated ? 'warning' : 'error', message);
        }
    } finally {
        button.disabled = false;
        button.innerHTML = '<i class="fa-solid fa-microphone-lines"></i> 上传并克隆';
    }
}

function addMessageButton(messageId) {
    const message = getMessage(messageId);
    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!message || message.is_user || message.is_system || !element || element.querySelector('.playhouse-message-button')) return;
    const button = document.createElement('div');
    button.className = 'mes_button playhouse-message-button fa-solid fa-masks-theater';
    button.title = '梨园·PlayHouse：分轨并朗读';
    button.dataset.messageId = String(messageId);
    const buttons = element.querySelector('.mes_buttons');
    if (!buttons) return;
    const overflowHint = buttons.querySelector('.extraMesButtonsHint');
    buttons.insertBefore(button, overflowHint || buttons.firstChild);
}

function addAllMessageButtons() {
    for (const id of getAiMessageIds()) addMessageButton(id);
}

function bindEvents() {
    document.addEventListener('pointerdown', () => {
        if (!player.unlocked) player.unlockFromGesture();
    }, { capture: true, once: true });

    $id('ph_close').addEventListener('click', closePanel);
    $id('ph_help').addEventListener('click', () => showPanelPage('help'));
    $id('ph_help_back').addEventListener('click', () => showPanelPage(previousPanelPage));
    $id('ph_theme').addEventListener('click', cycleTheme);
    document.querySelectorAll('.ph-tabs button').forEach(button => button.addEventListener('click', () => showPanelPage(button.dataset.page)));
    $id('ph_prev_message').addEventListener('click', () => {
        const ids = getAiMessageIds();
        const index = ids.indexOf(targetMessageId);
        if (index > 0) setTarget(ids[index - 1]);
    });
    $id('ph_next_message').addEventListener('click', () => {
        const ids = getAiMessageIds();
        const index = ids.indexOf(targetMessageId);
        if (index >= 0 && index < ids.length - 1) setTarget(ids[index + 1]);
    });
    $id('ph_process').addEventListener('click', () => processMessage(targetMessageId));
    $id('ph_redirect').addEventListener('click', () => processMessage(targetMessageId, { forceDirector: true }));
    for (const id of ['ph_reread', 'ph_bar_restart']) $id(id).addEventListener('click', replayFromStart);
    for (const id of ['ph_play', 'ph_bar_play']) $id(id).addEventListener('click', playOrPause);
    for (const id of ['ph_stop', 'ph_bar_stop']) $id(id).addEventListener('click', () => player.stop());
    $id('ph_previous').addEventListener('click', () => player.previous());
    $id('ph_next').addEventListener('click', () => player.next());
    $id('ph_mode_full').addEventListener('click', () => setMode('full'));
    $id('ph_mode_dialogue').addEventListener('click', () => setMode('dialogue'));
    $id('ph_bar_mode').addEventListener('click', () => setMode(player.mode === 'full' ? 'dialogue' : 'full'));
    $id('ph_bar_open').addEventListener('click', () => openPanel('read'));
    $id('ph_bar_hide').addEventListener('click', hideMiniPlayer);
    $id('ph_cues').addEventListener('click', event => {
        const cue = event.target.closest('.ph-cue');
        if (!cue) return;
        const index = Number(cue.dataset.index);
        const action = event.target.closest('[data-cue-action]')?.dataset.cueAction;
        if (action === 'retry') return void regenerateSegments([index], { reason: `重试第 ${index + 1} 段` });
        if (action === 'edit') return openCueEditor(index);
        if (!currentSegments[index]?.error) void player.play(index);
        else openCueEditor(index);
    });
    $id('ph_cues').addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const cue = event.target.closest('.ph-cue');
        if (!cue || event.target.closest('button')) return;
        event.preventDefault();
        openCueEditor(Number(cue.dataset.index));
    });
    $id('ph_retry_failed').addEventListener('click', () => {
        const indices = currentSegments.map((item, index) => item.error ? index : -1).filter(index => index >= 0);
        if (indices.length) void regenerateSegments(indices, { reason: '重试全部失败段' });
    });
    $id('ph_cue_editor').addEventListener('click', event => {
        if (event.target.closest('[data-cue-close]')) {
            activeCueEditorIndex = -1;
            return renderCueEditor();
        }
        if (event.target.closest('[data-regenerate-one]')) void regenerateActiveCue();
        if (event.target.closest('[data-regenerate-speaker]')) void regenerateActiveSpeaker();
    });
    $id('ph_new_speaker').addEventListener('click', event => {
        if (event.target.closest('[data-dismiss-new]')) return renderNewSpeaker();
        const button = event.target.closest('[data-bind-new]');
        if (!button) return;
        const speaker = button.dataset.bindNew;
        const voiceId = $id('ph_new_speaker').querySelector('select').value;
        if (!voiceId) return toast('warning', '请选择一把音色');
        bindSpeaker(settings, getCardKey(), speaker, voiceId);
        saveSettings();
        renderNewSpeaker();
        renderBindings();
    });
    document.addEventListener('click', event => {
        const button = event.target.closest('.playhouse-message-button');
        if (!button) return;
        event.stopPropagation();
        const id = Number(button.dataset.messageId || button.closest('.mes')?.getAttribute('mesid'));
        openPanel('read');
        void processMessage(id);
    });

    $id('ph_enabled').addEventListener('change', event => { settings.enabled = event.target.checked; saveSettings(); });
    $id('ph_auto').addEventListener('change', event => { settings.trigger = event.target.checked ? 'auto' : 'manual'; renderSettings(); saveSettings(); });
    $id('ph_mini_player').addEventListener('change', event => { settings.miniPlayerVisible = event.target.checked; saveSettings(); renderPlayer(); });
    $id('ph_default_mode').addEventListener('change', event => setMode(event.target.value));
    $id('ph_content_tags').addEventListener('change', event => {
        settings.contentTags = parseContentTags(event.target.value).join(',');
        event.target.value = parseContentTags(settings.contentTags).join(', ');
        currentSegments = [];
        player.stop();
        saveSettings();
        renderTarget();
    });
    $id('ph_global_speed').addEventListener('input', event => { settings.tts.globalSpeed = Number(event.target.value); $id('ph_global_speed_out').textContent = `${Number(event.target.value).toFixed(2)}×`; saveSettings(); });
    for (const [id, key] of [['ph_gap_narration', 'afterNarration'], ['ph_gap_dialogue', 'afterDialogue'], ['ph_gap_speaker', 'speakerSwitch']]) {
        $id(id).addEventListener('change', event => { settings.gapMs[key] = clamp(event.target.value, 0, 3000, settings.gapMs[key]); player.gaps = settings.gapMs; saveSettings(); });
    }

    $id('ph_preset').addEventListener('change', event => { settings.activePresetId = event.target.value; renderPreset(); saveSettings(); });
    for (const id of ['ph_preset_name', 'ph_director_url', 'ph_director_key', 'ph_director_model_custom', 'ph_director_temp', 'ph_director_tokens']) $id(id).addEventListener('change', persistPresetForm);
    $id('ph_director_model').addEventListener('change', event => {
        const manual = event.target.value === '__manual__';
        $id('ph_director_model_custom_field').hidden = !manual;
        if (manual) $id('ph_director_model_custom').focus();
        else persistPresetForm();
    });
    $id('ph_preset_new').addEventListener('click', () => {
        const preset = { id: `p_${Date.now().toString(36)}`, name: '新预设', baseUrl: '', apiKey: '', model: '', temperature: 0, maxTokens: null };
        settings.apiPresets.push(preset); settings.activePresetId = preset.id; renderPreset(); $id('ph_preset_name').focus(); saveSettings();
    });
    $id('ph_preset_copy').addEventListener('click', () => {
        const preset = { ...activePreset(), id: `p_${Date.now().toString(36)}`, name: `${activePreset().name} 副本` };
        settings.apiPresets.push(preset); settings.activePresetId = preset.id; renderPreset(); saveSettings();
    });
    $id('ph_preset_rename').addEventListener('click', () => $id('ph_preset_name').focus());
    $id('ph_preset_delete').addEventListener('click', () => {
        if (settings.apiPresets.length <= 1) return toast('warning', '至少保留一个分轨预设');
        settings.apiPresets = settings.apiPresets.filter(item => item.id !== settings.activePresetId);
        settings.activePresetId = settings.apiPresets[0].id; renderPreset(); saveSettings();
    });
    $id('ph_models').addEventListener('click', async () => {
        persistPresetForm();
        try {
            const models = await listModels(activePreset());
            settings.modelLists ||= {};
            settings.modelLists[activePreset().id] = models;
            renderDirectorModel(activePreset());
            saveSettings();
            toast('success', `拉到 ${models.length} 个模型`);
        } catch (error) { toast('error', error.message); }
    });
    $id('ph_director_test').addEventListener('click', async () => {
        persistPresetForm();
        try {
            const result = await directSegments(segmentText('夜色很静。“你好。”'), activePreset(), ['测试角色']);
            toast('success', `连接成功，返回 ${result.length} 段`);
        } catch (error) { toast('error', error.message); }
    });

    for (const id of ['ph_tts_url', 'ph_tts_key', 'ph_tts_group', 'ph_tts_model', 'ph_concurrency']) $id(id).addEventListener('change', persistTtsForm);
    $id('ph_tts_test').addEventListener('click', async () => {
        persistTtsForm();
        const voiceId = settings.narratorVoiceId || settings.fallbackVoiceId;
        if (!voiceId) return toast('warning', '先选择旁白或兜底音色');
        const service = new TtsService(settings.tts, cache);
        const result = await service.synthesizeSegment({ idx: 0, type: 'narration', speaker: null, text: '梨园试音，一切顺利。', voiceId, speed: 1, emotion: 'calm' });
        if (result.error) return toast('error', result.error);
        currentSegments = [result]; player.setQueue([result], 'full'); renderPlayer(); await player.unlockFromGesture(); await player.play();
    });

    $id('ph_save_reading').addEventListener('click', () => { persistReadingForm(); saved('朗读设置'); });
    $id('ph_save_director').addEventListener('click', () => { persistPresetForm(); saved('分轨设置'); });
    $id('ph_save_tts').addEventListener('click', () => { persistTtsForm(); saved('语音服务'); });

    $id('ph_main_speaker').addEventListener('change', saveBindingMain);
    $id('ph_main_voice').addEventListener('change', saveBindingMain);
    $id('ph_card_narrator').addEventListener('change', saveBindingMain);
    $id('ph_save_bindings').addEventListener('click', () => { saveBindingMain(); saved('角色绑定'); });
    $id('ph_add_extra').addEventListener('click', () => {
        const speaker = $id('ph_extra_speaker').value.trim();
        const voiceId = $id('ph_extra_voice').value;
        if (!speaker || !voiceId) return;
        bindSpeaker(settings, getCardKey(), speaker, voiceId);
        $id('ph_extra_speaker').value = ''; saveSettings(); renderBindings();
    });
    $id('ph_extras').addEventListener('click', event => {
        const button = event.target.closest('[data-remove-extra]');
        if (!button) return;
        const binding = settings.bindings?.[getCardKey()];
        binding?.extras?.splice(Number(button.dataset.removeExtra), 1); clearRuntimeSpeakerMap(); saveSettings(); renderBindings();
    });
    $id('ph_add_voice').addEventListener('click', () => {
        const voiceId = $id('ph_voice_id').value.trim();
        if (!voiceId) return toast('warning', 'Voice ID 不能为空');
        if (settings.voiceBank.some(voice => voice.voiceId === voiceId)) return toast('warning', '这个 Voice ID 已经在库里');
        settings.voiceBank.push({ voiceId, label: $id('ph_voice_label').value.trim() || voiceId, gender: $id('ph_voice_gender').value, ageTag: $id('ph_voice_age').value, toneTag: $id('ph_voice_tone').value.trim() || 'unknown', note: $id('ph_voice_note').value.trim() });
        for (const id of ['ph_voice_id', 'ph_voice_label', 'ph_voice_tone', 'ph_voice_note']) $id(id).value = '';
        saveSettings(); renderSettings(); toast('success', '音色已加入');
    });
    $id('ph_clone_file').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return setCloneStatus('等待选择音频');
        try {
            validateCloneFile(file);
            setCloneStatus(`正在读取 ${file.name}…`, 'working');
            const duration = await readAudioDuration(file);
            validateCloneFile(file, duration);
            setCloneStatus(`${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB${Number.isFinite(duration) ? ` · ${duration.toFixed(1)} 秒` : ''}`, 'success');
        } catch (error) {
            event.target.value = '';
            setCloneStatus(error.message, 'error');
            toast('error', error.message);
        }
    });
    $id('ph_clone_choose_file').addEventListener('click', () => $id('ph_clone_file').click());
    $id('ph_clone_voice').addEventListener('click', cloneVoiceFromForm);
    $id('ph_voice_list').addEventListener('click', async event => {
        const preview = event.target.closest('[data-preview-voice]');
        const remove = event.target.closest('[data-remove-voice]');
        if (preview) {
            const voice = settings.voiceBank[Number(preview.dataset.previewVoice)];
            const service = new TtsService(settings.tts, cache);
            const result = await service.synthesizeSegment({ idx: 0, type: 'dialogue', speaker: voice.label, text: '你好，这是梨园音色试听。', voiceId: voice.voiceId, speed: 1, emotion: 'calm' });
            if (result.error) return toast('error', result.error);
            currentSegments = [result]; player.setQueue([result], 'full'); await player.unlockFromGesture(); await player.play();
        }
        if (remove) {
            const voice = settings.voiceBank[Number(remove.dataset.removeVoice)];
            settings.voiceBank.splice(Number(remove.dataset.removeVoice), 1);
            for (const pool of Object.values(settings.fuzzyPools)) while (pool.includes(voice.voiceId)) pool.splice(pool.indexOf(voice.voiceId), 1);
            if (settings.narratorVoiceId === voice.voiceId) settings.narratorVoiceId = '';
            if (settings.fallbackVoiceId === voice.voiceId) settings.fallbackVoiceId = '';
            clearRuntimeSpeakerMap(); saveSettings(); renderSettings();
        }
    });
    $id('ph_pool_fields').addEventListener('change', event => {
        const select = event.target.closest('[data-pool]');
        if (!select) return;
        settings.fuzzyPools[select.dataset.pool] = [...select.selectedOptions].map(option => option.value);
        clearRuntimeSpeakerMap(); saveSettings();
    });
    $id('ph_save_voice_defaults').addEventListener('click', () => { persistVoiceDefaults(); saved('自动分组池'); });
    $id('ph_narrator').addEventListener('change', event => { settings.narratorVoiceId = event.target.value; saveSettings(); });
    $id('ph_fallback').addEventListener('change', event => { settings.fallbackVoiceId = event.target.value; saveSettings(); });
    $id('ph_cache_enabled').addEventListener('change', async event => { settings.cache.enabled = event.target.checked; cache.enabled = settings.cache.enabled; if (cache.enabled && !cache.db) await cache.init(); await updateCacheUsage(); saveSettings(); });
    $id('ph_cache_max').addEventListener('change', event => { settings.cache.maxMB = clamp(event.target.value, 10, 2000, 200); cache.maxMB = settings.cache.maxMB; void cache.evict(); saveSettings(); });
    $id('ph_cache_clear').addEventListener('click', async () => { await cache.clear(); await updateCacheUsage(); toast('success', '缓存已清空'); });
    $id('ph_save_defaults').addEventListener('click', async () => {
        persistVoiceDefaults();
        persistCacheForm();
        if (cache.enabled && !cache.db) await cache.init();
        await cache.evict();
        await updateCacheUsage();
        saved('旁白与缓存设置');
    });
    $id('ph_export').addEventListener('click', exportSettings);
    $id('ph_import').addEventListener('click', () => $id('ph_import_file').click());
    $id('ph_import_file').addEventListener('change', importSettings);

    player.addEventListener('queue', renderPlayer);
    player.addEventListener('segment', renderPlayer);
    player.addEventListener('state', renderPlayer);
    player.addEventListener('mode', renderPlayer);
    player.addEventListener('unlock', renderPlayer);
    player.addEventListener('error', event => toast('warning', `第 ${event.detail.index + 1} 段已跳过：${event.detail.error.message}`));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && player.ctx?.state === 'suspended' && player.items.length) {
            player.state = 'needs-gesture'; renderPlayer();
        }
    });
}

function exportSettings() {
    const safe = JSON.parse(JSON.stringify(settings));
    for (const preset of safe.apiPresets) preset.apiKey = '';
    safe.tts.apiKey = '';
    const blob = new Blob([`// 梨园配置分享包：API Key 已清空，请导入后自行填写。\n${JSON.stringify(safe, null, 2)}`], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href; anchor.download = `playhouse-config-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(href);
}

async function importSettings(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
        const text = await file.text();
        const incoming = JSON.parse(text.replace(/^\s*\/\/.*(?:\r?\n|$)/, ''));
        const byVoice = new Map(settings.voiceBank.map(voice => [voice.voiceId, voice]));
        for (const voice of incoming.voiceBank ?? []) if (voice?.voiceId && !byVoice.has(voice.voiceId)) byVoice.set(voice.voiceId, voice);
        settings.voiceBank = [...byVoice.values()];
        const byPreset = new Map(settings.apiPresets.map(preset => [preset.id, preset]));
        for (const preset of incoming.apiPresets ?? []) {
            if (!preset?.id) continue;
            const id = byPreset.has(preset.id) ? `p_${Date.now().toString(36)}_${hashString(preset.name || preset.id).toString(36).slice(0, 5)}` : preset.id;
            byPreset.set(id, { ...preset, id, apiKey: '' });
        }
        settings.apiPresets = [...byPreset.values()];
        settings.enabled = incoming.enabled ?? settings.enabled;
        settings.trigger = incoming.trigger === 'auto' ? 'auto' : settings.trigger;
        settings.miniPlayerVisible = incoming.miniPlayerVisible ?? settings.miniPlayerVisible;
        settings.narrationMode = incoming.narrationMode === 'dialogue' ? 'dialogue' : settings.narrationMode;
        settings.contentTags = parseContentTags(incoming.contentTags ?? settings.contentTags).join(',');
        currentSegments = [];
        settings.theme = ['follow', 'light', 'dark'].includes(incoming.theme) ? incoming.theme : settings.theme;
        settings.gapMs = { ...settings.gapMs, ...(incoming.gapMs ?? {}) };
        settings.cache = { ...settings.cache, ...(incoming.cache ?? {}) };
        settings.tts = { ...settings.tts, ...(incoming.tts ?? {}), apiKey: settings.tts.apiKey };
        settings.bindings = { ...settings.bindings, ...(incoming.bindings ?? {}) };
        settings.fuzzyPools = { ...settings.fuzzyPools, ...(incoming.fuzzyPools ?? {}) };
        if (incoming.narratorVoiceId) settings.narratorVoiceId = incoming.narratorVoiceId;
        if (incoming.fallbackVoiceId) settings.fallbackVoiceId = incoming.fallbackVoiceId;
        player.gaps = settings.gapMs;
        player.setMode(settings.narrationMode);
        cache.enabled = settings.cache.enabled;
        cache.maxMB = settings.cache.maxMB;
        saveSettings(); renderSettings(); renderPlayer(); toast('success', '配置已合并；请自行填写 API Key');
    } catch (error) { toast('error', `导入失败：${error.message}`); }
}

async function mountUi() {
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    document.querySelector('#extensions_settings2, #extensions_settings')?.insertAdjacentHTML('beforeend', settingsHtml);
    const panelHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'panel');
    document.body.insertAdjacentHTML('beforeend', panelHtml);
    $id('form_sheld')?.insertBefore($id('playhouse_player_bar'), $id('send_form'));
    const menu = $id('extensionsMenu');
    if (menu && !$id('playhouse_wand_item')) menu.insertAdjacentHTML('afterbegin', '<div id="playhouse_wand_item" class="list-group-item flex-container flexGap5"><div class="extensionsMenuExtensionButton fa-solid fa-masks-theater"></div><span>梨园·PlayHouse</span></div>');
    $id('playhouse_wand_item')?.addEventListener('click', () => openPanel('read'));
    $id('playhouse_open_panel_settings')?.addEventListener('click', () => openPanel('settings'));
}

function attachSillyTavernEvents() {
    const ctx = context();
    ctx.eventSource.on(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId => addMessageButton(messageId));
    ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, () => {
        addAllMessageButtons();
        if (!settings.enabled || settings.trigger !== 'auto') return;
        const ids = getAiMessageIds();
        const id = ids[ids.length - 1];
        if (id !== undefined) void processMessage(id, { autoPlay: true });
    });
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_EDITED, messageId => {
        const tracks = ctx.chatMetadata?.playhouse?.tracks;
        if (tracks) delete tracks[messageId];
        if (Number(messageId) === targetMessageId) { regenerationController?.abort(); activeCueEditorIndex = -1; currentSegments = []; player.stop(); renderTarget(); }
        ctx.saveMetadataDebounced?.();
    });
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        pipelineController?.abort(); regenerationController?.abort(); activeCueEditorIndex = -1; player.stop(); clearRuntimeSpeakerMap(); currentSegments = []; targetMessageId = -1;
        setTimeout(() => { const ids = getAiMessageIds(); addAllMessageButtons(); setTarget(ids[ids.length - 1]); }, 0);
    });
}

async function init() {
    loadSettings();
    await mountUi();
    cache = new AudioCache(settings.cache);
    await cache.init();
    player = new WebAudioPlayer(settings.gapMs);
    player.mode = settings.narrationMode;
    bindEvents();
    attachSillyTavernEvents();
    addAllMessageButtons();
    const ids = getAiMessageIds();
    setTarget(ids[ids.length - 1]);
    renderSettings();
    renderPlayer();
    messageObserver = new MutationObserver(addAllMessageButtons);
    messageObserver.observe($id('chat'), { childList: true, subtree: true });
    console.info('[梨园·PlayHouse] v0.2.2 已加载');
}

jQuery(init);
