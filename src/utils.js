export function clamp(value, min, max, fallback = min) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizePitch(value) {
    const bounded = clamp(value, -1, 1, 0);
    const rounded = Math.sign(bounded) * Math.round(Math.abs(bounded));
    return Object.is(rounded, -0) ? 0 : rounded;
}

export function hashString(value) {
    let hash = 2166136261;
    for (const char of String(value ?? '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function normalizeBaseUrl(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

export function joinApiUrl(baseUrl, path) {
    const base = normalizeBaseUrl(baseUrl);
    const suffix = String(path).startsWith('/') ? path : `/${path}`;
    if (/\/v1$/i.test(base) && /^\/v1(?:\/|$)/i.test(suffix)) {
        return `${base}${suffix.replace(/^\/v1/i, '')}`;
    }
    return `${base}${suffix}`;
}

export function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

export function mergeDefaults(target, defaults) {
    if (Array.isArray(defaults)) {
        return Array.isArray(target) ? target : JSON.parse(JSON.stringify(defaults));
    }
    if (!defaults || typeof defaults !== 'object') {
        return target === undefined ? defaults : target;
    }
    const result = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
    for (const [key, value] of Object.entries(defaults)) {
        result[key] = mergeDefaults(result[key], value);
    }
    return result;
}

export async function sha1(value) {
    const bytes = new TextEncoder().encode(String(value));
    if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-1', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return hashString(value).toString(16).padStart(8, '0');
}

export function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(href);
}

export function assertSecureUrl(value, pageProtocol = location.protocol) {
    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        throw new Error('接口地址不是有效 URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('接口地址只支持 HTTP 或 HTTPS');
    }
    if (pageProtocol === 'https:' && url.protocol !== 'https:') {
        throw new Error('云酒馆使用 HTTPS，接口也必须是 HTTPS');
    }
    return url;
}

