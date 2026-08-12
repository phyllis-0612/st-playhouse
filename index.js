import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { AudioCache } from './src/cache.js';
import { cloneDefaults, MODULE_NAME, SETTINGS_KEY } from './src/constants.js';
import { directSegments, listModels } from './src/director.js';
import { WebAudioPlayer } from './src/player.js';
import { extractTaggedContent, parseContentTags, segmentText } from './src/segmenter.js';
import { TtsService } from './src/tts.js';
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

const $id = id => document.getElementById(id);
const toast = (type, message, title = '梨园') => globalThis.toastr?.[type]?.(message, title) ?? console[type === 'error' ? 'error' : 'log'](`[${title}] ${message}`);

function saveSettings() {
    context().saveSettingsDebounced?.();
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
    $id('ph_cues').innerHTML = currentSegments.map((item, index) => {
        const state = item.error ? '失败' : item.blob ? (item.cached ? '缓存' : '就绪') : '';
        return `<button type="button" role="listitem" class="ph-cue ${index === player?.cursor ? 'ph-live' : ''} ${item.error ? 'ph-error' : ''}" data-index="${index}" data-hidden="${mode === 'dialogue' && item.type === 'narration'}" style="--seg-color:${speakerColor(item.speaker)}"><span class="ph-cue-color"></span><span class="ph-cue-who">${escapeHtml(item.speaker || '旁白')}</span><span class="ph-cue-text">${escapeHtml(item.text)}</span><span class="ph-cue-state">${state}</span></button>`;
    }).join('');
    const newcomers = getNewSpeakers(currentSegments, settings, getCardKey());
    renderNewSpeaker(newcomers[0]);
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
    $id('playhouse_player_bar').hidden = !player.items.length && !getMessage();
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
            const result = await service.synthesizeSegment(segment, { signal: pipelineController.signal });
            completed++;
            $id('ph_target_status').textContent = `正在合成 · ${completed}/${segments.length}`;
            const match = currentSegments.find(item => item.idx === result.idx);
            if (match) Object.assign(match, result);
            renderSegments();
            return result;
        }));
        currentSegments = results;
        player.setQueue(results, settings.narrationMode);
        $id('ph_target_status').textContent = `已就绪 · ${results.filter(item => item.blob).length}/${results.length} 段`;
        renderPlayer();
        if (autoPlay) await player.play();
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('[梨园] 流水线失败', error);
        $id('ph_target_status').textContent = `失败 · ${error.message}`;
        toast('error', error.message);
    }
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

function renderPreset() {
    $id('ph_preset').innerHTML = settings.apiPresets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    $id('ph_preset').value = settings.activePresetId;
    const preset = activePreset();
    if (!preset) return;
    $id('ph_preset_name').value = preset.name;
    $id('ph_director_url').value = preset.baseUrl;
    $id('ph_director_key').value = preset.apiKey;
    $id('ph_director_model').value = preset.model;
    $id('ph_director_temp').value = preset.temperature;
    $id('ph_director_tokens').value = preset.maxTokens ?? '';
}

function renderSettings() {
    if (!$id('playhouse_panel')) return;
    $id('playhouse_panel').dataset.theme = settings.theme;
    $id('ph_enabled').checked = settings.enabled;
    $id('ph_auto').checked = settings.trigger === 'auto';
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
    preset.model = $id('ph_director_model').value.trim();
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

function addMessageButton(messageId) {
    const message = getMessage(messageId);
    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!message || message.is_user || message.is_system || !element || element.querySelector('.playhouse-message-button')) return;
    const button = document.createElement('div');
    button.className = 'mes_button playhouse-message-button fa-solid fa-masks-theater';
    button.title = '梨园：分轨并朗读';
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
    $id('ph_reread').addEventListener('click', () => player.items.length ? player.play(player.nextLegal(-1, 1)) : processMessage(targetMessageId));
    for (const id of ['ph_play', 'ph_bar_play']) $id(id).addEventListener('click', playOrPause);
    for (const id of ['ph_stop', 'ph_bar_stop']) $id(id).addEventListener('click', () => player.stop());
    $id('ph_previous').addEventListener('click', () => player.previous());
    $id('ph_next').addEventListener('click', () => player.next());
    $id('ph_mode_full').addEventListener('click', () => setMode('full'));
    $id('ph_mode_dialogue').addEventListener('click', () => setMode('dialogue'));
    $id('ph_bar_mode').addEventListener('click', () => setMode(player.mode === 'full' ? 'dialogue' : 'full'));
    $id('ph_bar_open').addEventListener('click', () => openPanel('read'));
    $id('ph_cues').addEventListener('click', event => {
        const cue = event.target.closest('.ph-cue');
        if (cue) void player.play(Number(cue.dataset.index));
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
    for (const id of ['ph_preset_name', 'ph_director_url', 'ph_director_key', 'ph_director_model', 'ph_director_temp', 'ph_director_tokens']) $id(id).addEventListener('change', persistPresetForm);
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
            $id('ph_model_list').innerHTML = models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('');
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

    $id('ph_main_speaker').addEventListener('change', saveBindingMain);
    $id('ph_main_voice').addEventListener('change', saveBindingMain);
    $id('ph_card_narrator').addEventListener('change', saveBindingMain);
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
    $id('ph_narrator').addEventListener('change', event => { settings.narratorVoiceId = event.target.value; saveSettings(); });
    $id('ph_fallback').addEventListener('change', event => { settings.fallbackVoiceId = event.target.value; saveSettings(); });
    $id('ph_cache_enabled').addEventListener('change', async event => { settings.cache.enabled = event.target.checked; cache.enabled = settings.cache.enabled; if (cache.enabled && !cache.db) await cache.init(); await updateCacheUsage(); saveSettings(); });
    $id('ph_cache_max').addEventListener('change', event => { settings.cache.maxMB = clamp(event.target.value, 10, 2000, 200); cache.maxMB = settings.cache.maxMB; void cache.evict(); saveSettings(); });
    $id('ph_cache_clear').addEventListener('click', async () => { await cache.clear(); await updateCacheUsage(); toast('success', '缓存已清空'); });
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
        saveSettings(); renderSettings(); toast('success', '配置已合并；请自行填写 API Key');
    } catch (error) { toast('error', `导入失败：${error.message}`); }
}

async function mountUi() {
    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    document.querySelector('#extensions_settings2, #extensions_settings')?.insertAdjacentHTML('beforeend', settingsHtml);
    const panelHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'panel');
    document.body.insertAdjacentHTML('beforeend', panelHtml);
    $id('form_sheld')?.insertBefore($id('playhouse_player_bar'), $id('send_form'));
    const menu = $id('extensionsMenu');
    if (menu && !$id('playhouse_wand_item')) menu.insertAdjacentHTML('afterbegin', '<div id="playhouse_wand_item" class="list-group-item flex-container flexGap5"><div class="extensionsMenuExtensionButton fa-solid fa-masks-theater"></div><span>梨园朗读</span></div>');
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
        if (Number(messageId) === targetMessageId) { currentSegments = []; player.stop(); renderTarget(); }
        ctx.saveMetadataDebounced?.();
    });
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        pipelineController?.abort(); player.stop(); clearRuntimeSpeakerMap(); currentSegments = []; targetMessageId = -1;
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
    console.info('[梨园·PlayHouse] Phase 1 已加载');
}

jQuery(init);
