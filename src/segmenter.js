const OPEN_QUOTES = new Map([
    ['“', '”'], ['「', '」'], ['『', '』'], ['\"', '\"'],
]);

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseContentTags(value = 'content') {
    const source = Array.isArray(value) ? value.join(',') : String(value ?? '');
    const tags = source
        .split(/[,，;；\s]+/)
        .map(tag => tag.trim().replace(/^<\/?/, '').replace(/\/?\s*>$/, ''))
        .filter(tag => /^[\p{L}_][\p{L}\p{N}_.:-]*$/u.test(tag));
    return [...new Set(tags.length ? tags : ['content'])];
}

export function extractTaggedContent(input, contentTags = 'content') {
    const source = String(input ?? '');
    const tags = parseContentTags(contentTags);
    const matches = [];
    for (const tag of tags) {
        const pattern = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tag)}\\s*>`, 'giu');
        for (const match of source.matchAll(pattern)) {
            const text = String(match[1] ?? '').trim();
            if (text) matches.push({ index: match.index ?? 0, tag, text });
        }
    }
    matches.sort((a, b) => a.index - b.index);
    return {
        text: matches.map(match => match.text).join('\n').trim(),
        tags,
        matchedTags: [...new Set(matches.map(match => match.tag))],
    };
}

function stripHiddenContent(input) {
    return String(input ?? '')
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, ' ')
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/<img\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/`[^`]*`/g, ' ');
}

function splitByQuotesAndActions(text) {
    const pieces = [];
    let buffer = '';
    let mode = 'narration';
    let closer = null;
    let inAction = false;
    const push = (type = mode) => {
        const value = buffer.trim();
        buffer = '';
        if (value) pieces.push({ type, text: value });
    };

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '*' && closer === null) {
            push();
            inAction = !inAction;
            mode = 'narration';
            continue;
        }
        if (!inAction && closer === null && OPEN_QUOTES.has(char)) {
            push();
            mode = 'dialogue';
            closer = OPEN_QUOTES.get(char);
            continue;
        }
        if (!inAction && closer !== null && char === closer) {
            push('dialogue');
            mode = 'narration';
            closer = null;
            continue;
        }
        buffer += char;
    }
    push(mode);
    return pieces;
}

function splitLongPiece(piece, maxChars) {
    if (piece.text.length <= maxChars) return [piece];
    const sentences = piece.text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? [piece.text];
    const result = [];
    let buffer = '';
    const flush = () => {
        const value = buffer.trim();
        if (value) result.push({ type: piece.type, text: value });
        buffer = '';
    };
    for (const sentence of sentences) {
        if (buffer && buffer.length + sentence.length > maxChars) flush();
        if (sentence.length <= maxChars) {
            buffer += sentence;
            continue;
        }
        flush();
        for (let offset = 0; offset < sentence.length; offset += maxChars) {
            result.push({ type: piece.type, text: sentence.slice(offset, offset + maxChars).trim() });
        }
    }
    flush();
    return result;
}

export function segmentText(input, { maxChars = 400 } = {}) {
    const clean = stripHiddenContent(input).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
    const raw = splitByQuotesAndActions(clean);
    const merged = [];
    for (const piece of raw) {
        const text = piece.text.replace(/^\s+|\s+$/g, '');
        if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
        const previous = merged[merged.length - 1];
        if (previous?.type === piece.type) previous.text = `${previous.text}${/^[，。！？!?；;：:、]/.test(text) ? '' : ' '}${text}`;
        else merged.push({ type: piece.type, text });
    }
    return merged
        .flatMap(piece => splitLongPiece(piece, maxChars))
        .filter(piece => piece.text && /[\p{L}\p{N}]/u.test(piece.text))
        .map((piece, idx) => ({ idx, ...piece }));
}

export const __test = { stripHiddenContent, splitByQuotesAndActions, splitLongPiece };
