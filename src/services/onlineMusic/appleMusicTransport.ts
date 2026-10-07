import type { ProviderAvailability } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { APPLE_MUSIC_DEFAULT_STOREFRONT, APPLE_MUSIC_PROVIDER_ID } from './appleMusicNormalize';

// src/services/onlineMusic/appleMusicTransport.ts
// Apple Music 的请求边界。这里有两层，按凭据是否就绪自动选择，调用方不需要知道自己落在哪一层：
//
//   匿名层：iTunes Search API（itunes.apple.com）。免登录、免 developer token，返回 30 秒试听
//           地址与完整目录元数据，但拿不到用户曲库、歌词，且中国大陆区（CN）不返回条目。
//   授权层：Apple Music API（api.music.apple.com）。需要 developer token（MusicKit 私钥签出的
//           JWT）与 Music-User-Token，能读目录、歌词与用户曲库。
//
// 凭据由用户从自己的 Apple Music 会话里取得；Folia 不代签 JWT，也不做 OAuth 回调
// （那需要一个注册过的开发者域名与 Apple 的授权服务器，第三方客户端无法在本地完成）。

export const APPLE_MUSIC_API_BASE = 'https://api.music.apple.com/v1';
export const ITUNES_API_BASE = 'https://itunes.apple.com';

/** 匿名层可用的店铺；CN 在大陆区不返回任何条目，所以界面上不把它作为默认。 */
export const APPLE_MUSIC_STOREFRONTS = [
    'us', 'jp', 'hk', 'tw', 'sg', 'gb', 'de', 'fr', 'ca', 'au', 'kr', 'cn',
] as const;

export type AppleMusicCredentials = {
    developerToken: string;
    userToken: string;
    storefront: string;
};

export type AppleMusicTransportStatus = {
    /** 官方 API 可用（developer token 已配置）。 */
    authorized: boolean;
    /** 至少匿名层可用；Apple Music 永远可用，所以恒为 true。 */
    configured: boolean;
    storefront: string;
    developerToken: boolean;
    userToken: boolean;
    reason?: 'not-configured';
};

const STATE_STORAGE_KEY = 'folia.appleMusic.credentials.v1';

type CredentialListener = () => void;

const listeners = new Set<CredentialListener>();

const readState = (): AppleMusicCredentials => {
    if (typeof localStorage === 'undefined') return { developerToken: '', userToken: '', storefront: APPLE_MUSIC_DEFAULT_STOREFRONT };
    try {
        const raw = localStorage.getItem(STATE_STORAGE_KEY);
        if (!raw) return { developerToken: '', userToken: '', storefront: APPLE_MUSIC_DEFAULT_STOREFRONT };
        const parsed = JSON.parse(raw) as Partial<AppleMusicCredentials>;
        return {
            developerToken: typeof parsed.developerToken === 'string' ? parsed.developerToken.trim() : '',
            userToken: typeof parsed.userToken === 'string' ? parsed.userToken.trim() : '',
            storefront: normalizeStorefront(parsed.storefront),
        };
    } catch {
        return { developerToken: '', userToken: '', storefront: APPLE_MUSIC_DEFAULT_STOREFRONT };
    }
};

let state: AppleMusicCredentials = readState();

const persist = (next: AppleMusicCredentials): void => {
    state = next;
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(next));
        } catch {
            // 存储不可用（隐私模式 / 配额满）时保持本次运行可用，不把配置动作变成失败。
        }
    }
    listeners.forEach(listener => listener());
};

export const normalizeStorefront = (value: unknown): string => {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    // Apple 的店铺代码恒为两位小写字母；用户常直接粘贴 "US" 或整段接口 URL，这里只取代码。
    if (/^[a-z]{2}$/.test(text)) return text;
    const fromUrl = text.match(/catalog\/([a-z]{2})[/?]/);
    return fromUrl ? fromUrl[1] : APPLE_MUSIC_DEFAULT_STOREFRONT;
};

export const getAppleMusicCredentials = (): AppleMusicCredentials => ({ ...state });

export const setAppleMusicCredentials = (patch: Partial<AppleMusicCredentials>): void => {
    persist({
        developerToken: patch.developerToken !== undefined ? patch.developerToken.trim() : state.developerToken,
        userToken: patch.userToken !== undefined ? patch.userToken.trim() : state.userToken,
        storefront: patch.storefront !== undefined ? normalizeStorefront(patch.storefront) : state.storefront,
    });
};

export const clearAppleMusicCredentials = (): void => {
    persist({ developerToken: '', userToken: '', storefront: state.storefront });
};

export const subscribeAppleMusicCredentials = (listener: CredentialListener): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const getAppleMusicTransportStatus = (): AppleMusicTransportStatus => ({
    authorized: state.developerToken.length > 0,
    configured: true,
    storefront: state.storefront,
    developerToken: state.developerToken.length > 0,
    userToken: state.userToken.length > 0,
    ...(state.developerToken.length > 0 ? {} : { reason: 'not-configured' as const }),
});

export const getAppleMusicTransportAvailability = (): ProviderAvailability => (
    // 匿名层不需要任何配置，所以 Apple Music 永远可用；凭据只决定能读到多少。
    { configured: true }
);

const requestJson = async (url: string, headers: Record<string, string>, providerMessage: string): Promise<any> => {
    let response: Response;
    try {
        response = await fetch(url, { headers });
    } catch {
        throw new OnlineProviderError('network', providerMessage, APPLE_MUSIC_PROVIDER_ID);
    }
    if (response.status === 401 || response.status === 403) {
        throw new OnlineProviderError(
            response.status === 401 ? 'auth-required' : 'region-restricted',
            `Apple Music rejected the request (HTTP ${response.status})`,
            APPLE_MUSIC_PROVIDER_ID,
            undefined,
            response.status,
        );
    }
    if (!response.ok) {
        throw new OnlineProviderError('network', `Apple Music request failed (HTTP ${response.status})`, APPLE_MUSIC_PROVIDER_ID, undefined, response.status);
    }
    try {
        return await response.json();
    } catch {
        throw new OnlineProviderError('invalid-response', 'Apple Music returned a non-JSON body', APPLE_MUSIC_PROVIDER_ID);
    }
};

const officialHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${state.developerToken}`,
    ...(state.userToken ? { 'Music-User-Token': state.userToken } : {}),
});

/** 官方目录接口；只在 developer token 就绪时调用。 */
export const requestAppleMusicApi = async <T = any>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> => {
    if (!state.developerToken) {
        throw new OnlineProviderError('auth-required', 'Apple Music requires a MusicKit developer token', APPLE_MUSIC_PROVIDER_ID);
    }
    const url = new URL(`${APPLE_MUSIC_API_BASE}${path}`);
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });
    const body = await requestJson(url.toString(), officialHeaders(), 'Apple Music request failed');
    return body as T;
};

/** 用户曲库接口；官方 API 的 /v1/me 需要 Music-User-Token。 */
export const requestAppleMusicUserApi = async <T = any>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> => {
    if (!state.userToken) {
        throw new OnlineProviderError('auth-required', 'Apple Music user library requires a Music-User-Token', APPLE_MUSIC_PROVIDER_ID);
    }
    return requestAppleMusicApi<T>(path, query);
};

const itunesHeaders: Record<string, string> = { Accept: 'application/json' };

const storefrontOf = (): string => state.storefront;

/** 匿名层的搜索；返回 iTunes 的原始 results 数组。 */
export const searchItunes = async (
    term: string,
    entity: 'song' | 'album' | 'musicArtist',
    limit: number,
    offset: number,
    attribute?: 'artistTerm' | 'albumTerm' | 'songTerm',
): Promise<any[]> => {
    if (!term.trim()) return [];
    const url = new URL(`${ITUNES_API_BASE}/search`);
    url.searchParams.set('term', term);
    url.searchParams.set('entity', entity);
    url.searchParams.set('limit', String(Math.max(1, Math.min(200, limit))));
    if (offset > 0) url.searchParams.set('offset', String(offset));
    const storefront = storefrontOf();
    if (storefront) {
        url.searchParams.set('country', storefront.toUpperCase());
        url.searchParams.set('lang', 'zh_cn');
    }
    if (attribute) url.searchParams.set('attribute', attribute);
    const body = await requestJson(url.toString(), itunesHeaders, 'iTunes search failed');
    const results = Array.isArray(body?.results) ? body.results : [];
    // 中国大陆店铺不返回任何条目；这不是「没搜到」，界面要能说清是店铺的问题。
    if (results.length === 0 && storefront === 'cn') {
        throw new OnlineProviderError(
            'region-restricted',
            'The mainland China storefront does not expose Apple Music catalog entries; pick another storefront',
            APPLE_MUSIC_PROVIDER_ID,
        );
    }
    return results;
};

/** 匿名层按 id 批量取详情（歌曲 / 专辑 / 歌手）。 */
export const lookupItunes = async (
    ids: Array<string | number>,
    entity?: 'song' | 'album' | 'musicArtist',
    limit = 200,
): Promise<any[]> => {
    const clean = ids.map(id => String(id).trim()).filter(Boolean);
    if (!clean.length) return [];
    const url = new URL(`${ITUNES_API_BASE}/lookup`);
    url.searchParams.set('id', clean.join(','));
    if (entity) url.searchParams.set('entity', entity);
    url.searchParams.set('limit', String(Math.max(1, Math.min(200, limit))));
    const storefront = storefrontOf();
    if (storefront) url.searchParams.set('country', storefront.toUpperCase());
    const body = await requestJson(url.toString(), itunesHeaders, 'iTunes lookup failed');
    return Array.isArray(body?.results) ? body.results : [];
};

/**
 * 歌曲预览地址：优先用已存下来的 previewUrl，缺失时回落到一次目录查询。
 * 匿名层按 id 查单曲，授权层走官方接口。
 */
export const resolveApplePreviewUrl = async (mediaId: string, storefrontHint?: string): Promise<string> => {
    const storefront = storefrontHint ? normalizeStorefront(storefrontHint) : storefrontOf();
    if (state.developerToken) {
        const body = await requestAppleMusicApi<{ data?: any[] }>(`/catalog/${storefront}/songs/${encodeURIComponent(mediaId)}`);
        const attributes = body?.data?.[0]?.attributes;
        const url = attributes?.previews?.find?.((entry: any) => entry?.url)?.url;
        if (typeof url === 'string' && url) return url;
    }
    const results = await lookupItunes([mediaId], 'song', 5);
    const match = results.find((entry: any) => String(entry.trackId) === String(mediaId)) || results[0];
    const url = match?.previewUrl;
    if (typeof url === 'string' && url) return url;
    throw new OnlineProviderError('preview-only', 'Apple Music has no preview for this track', APPLE_MUSIC_PROVIDER_ID);
};
