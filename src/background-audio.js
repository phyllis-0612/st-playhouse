export const MAX_BACKGROUND_WAV_BYTES = 160 * 1024 * 1024;

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function gapBetweenMs(current, next, gaps = {}) {
    if (!current || !next) return 0;
    const base = current.type === 'narration'
        ? finiteNumber(gaps.afterNarration, 300)
        : finiteNumber(gaps.afterDialogue, 200);
    const speakerSwitch = current.speaker !== next.speaker
        ? finiteNumber(gaps.speakerSwitch, 250)
        : 0;
    return Math.max(0, base + speakerSwitch);
}

export function audioBufferToMonoPcm16(buffer) {
    if (!buffer?.length || !buffer?.numberOfChannels) throw new Error('无法解码后台音轨片段');
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const pcm = new Int16Array(buffer.length);
    for (let frame = 0; frame < buffer.length; frame++) {
        let sample = 0;
        for (const channel of channels) sample += channel[frame] || 0;
        sample = Math.max(-1, Math.min(1, sample / channels.length));
        pcm[frame] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    return pcm;
}

function writeAscii(view, offset, value) {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}

export function createMonoWavBlob(chunks, sampleRate) {
    const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const dataBytes = frames * 2;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
    return new Blob([header, ...chunks], { type: 'audio/wav' });
}

export async function buildBackgroundTrack(items, {
    mode = 'full',
    gaps = {},
    decode,
    maxBytes = MAX_BACKGROUND_WAV_BYTES,
} = {}) {
    if (typeof decode !== 'function') throw new Error('缺少后台音轨解码器');
    const entries = (items ?? [])
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item?.blob && (mode !== 'dialogue' || item.type === 'dialogue'));
    if (!entries.length) throw new Error('当前模式没有可用于后台播放的音频');

    const chunks = [];
    const cues = [];
    let sampleRate = 0;
    let totalFrames = 0;
    for (let position = 0; position < entries.length; position++) {
        const { item, index } = entries[position];
        const buffer = await decode(index);
        if (!sampleRate) sampleRate = buffer.sampleRate;
        if (buffer.sampleRate !== sampleRate) throw new Error('后台音轨采样率不一致，请重新生成当前楼层');
        const pcm = audioBufferToMonoPcm16(buffer);
        const start = totalFrames / sampleRate;
        chunks.push(pcm);
        totalFrames += pcm.length;
        cues.push({ index, start, end: totalFrames / sampleRate });

        const next = entries[position + 1]?.item;
        const gapFrames = Math.round(sampleRate * gapBetweenMs(item, next, gaps) / 1000);
        if (gapFrames > 0) {
            chunks.push(new Int16Array(gapFrames));
            totalFrames += gapFrames;
        }
        if (44 + totalFrames * 2 > maxBytes) throw new Error('当前楼层过长，后台音轨超过 160 MB；请改用前台分段播放');
    }

    return {
        blob: createMonoWavBlob(chunks, sampleRate),
        cues,
        duration: totalFrames / sampleRate,
        sampleRate,
    };
}
