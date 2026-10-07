import type { UnifiedSong } from '../../types';
import type {
    MediaId,
    OnlineCatalogProvider,
    OnlineMusicProvider,
    PlaybackSourceRef,
    ProviderCollection,
    ProviderCredentialField,
    ProviderCredentialValues,
    ProviderLyricsResult,
    ProviderPage,
    ProviderUser,
} from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { parseAppleMusicLyrics } from '../../utils/lyrics/appleMusicLyrics';
import {
    APPLE_MUSIC_PROVIDER_ID,
    appleArtworkUrl,
    applePage,
    applePreviewUrl,
    appleRecord,
    isApplePlayableTrack,
    normalizeAppleCollection,
    normalizeAppleSong,
    normalizeAppleUser,
} from './appleMusicNormalize';
import {
    clearAppleMusicCredentials,
    getAppleMusicCredentials,
    getAppleMusicTransportStatus,
    normalizeStorefront,
    lookupItunes,
    requestAppleMusicApi,
    requestAppleMusicUserApi,
    resolveApplePreviewUrl,
    searchItunes,
    setAppleMusicCredentials,
} from './appleMusicTransport';

// src/services/onlineMusic/appleMusicProvider.ts
// Apple Music adapter。能力范围由 Apple 官方接口本身决定，不是实现取舍：
//   · 目录 / 搜索：官方 API（需 developer token）或 iTunes Search API（匿名，免 token）。
//   · 播放：只有 30 秒试听（预览）。完整曲目是 FairPlay DRM，任何第三方播放器都拿不到音频流，
//     所以这里声明 previewPlayback，UI 与缓存都必须把它当试听而不是整曲。
//   · 歌词：官方接口返回 TTML（逐行/逐音节时间轴由 Apple 提供，Folia 用现成的 TTML 解析器读）；
//     iTunes 匿名层没有歌词接口，只能等用户配置凭据。
//   · 登录：不是扫码。用户从自己的 Apple Music 会话里取 developer token 与 Music-User-Token。

const DEFAULT_PAGE_LIMIT = 25;

const storefront = (): string => getAppleMusicCredentials().storefront;

const authorized = (): boolean => getAppleMusicTransportStatus().authorized;

type AppleDataEnvelope<T> = { data?: T[]; next?: string; meta?: { total?: number } };

const pageFromEnvelope = <T>(body: AppleDataEnvelope<any>, map: (item: unknown) => T, offset: number, limit: number): ProviderPage<T> => {
    const items = Array.isArray(body?.data) ? body.data.map(map) : [];
    return applePage(items, body?.meta?.total, offset, limit);
};

/** 官方目录搜索；资源类型限定 songs / albums / artists，避免把 mv、电台混进结果。 */
const searchOfficial = async (
    term: string,
    types: string,
    limit: number,
    offset: number,
): Promise<AppleDataEnvelope<any>> => requestAppleMusicApi<AppleDataEnvelope<any>>(
    `/catalog/${storefront()}/search`,
    { term, types, limit, offset },
);

const searchSongs = async (query: string, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> => {
    const trimmed = query.trim();
    if (!trimmed) return applePage<UnifiedSong>([], 0, offset, limit);
    if (authorized()) {
        const body = await searchOfficial(trimmed, 'songs', limit, offset);
        return pageFromEnvelope(body, normalizeAppleSong, offset, limit);
    }
    const results = await searchItunes(trimmed, 'song', limit, offset);
    return applePage(results.filter(isApplePlayableTrack).map(normalizeAppleSong), undefined, offset, limit);
};

const searchAlbums = async (query: string, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> => {
    const trimmed = query.trim();
    if (!trimmed) return applePage<ProviderCollection>([], 0, offset, limit);
    if (authorized()) {
        const body = await searchOfficial(trimmed, 'albums', limit, offset);
        return pageFromEnvelope(body, item => normalizeAppleCollection(item, 'album'), offset, limit);
    }
    const results = await searchItunes(trimmed, 'album', limit, offset);
    return applePage(results.map(item => normalizeAppleCollection(item, 'album')), undefined, offset, limit);
};

const searchArtists = async (query: string, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> => {
    const trimmed = query.trim();
    if (!trimmed) return applePage<ProviderCollection>([], 0, offset, limit);
    if (authorized()) {
        const body = await searchOfficial(trimmed, 'artists', limit, offset);
        return pageFromEnvelope(body, item => normalizeAppleCollection(item, 'artist'), offset, limit);
    }
    const results = await searchItunes(trimmed, 'musicArtist', limit, offset);
    return applePage(results.map(item => normalizeAppleCollection(item, 'artist')), undefined, offset, limit);
};

/** 专辑曲目：官方接口一次给全；匿名层用 lookup 展开该专辑。 */
const albumTracks = async (id: MediaId, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> => {
    if (authorized()) {
        const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(
            `/catalog/${storefront()}/albums/${encodeURIComponent(String(id))}/tracks`,
            { limit, offset },
        );
        return pageFromEnvelope(body, normalizeAppleSong, offset, limit);
    }
    const results = await lookupItunes([id], 'song', 200);
    const songs = results.filter(isApplePlayableTrack).map(normalizeAppleSong);
    return applePage(songs.slice(offset, offset + limit), songs.length, offset, limit);
};

const albumDetail = async (id: MediaId): Promise<ProviderCollection | null> => {
    if (authorized()) {
        const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(`/catalog/${storefront()}/albums/${encodeURIComponent(String(id))}`);
        const first = body?.data?.[0];
        return first ? normalizeAppleCollection(first, 'album') : null;
    }
    const results = await lookupItunes([id], 'song', 1);
    const first = results[0];
    return first ? normalizeAppleCollection(first, 'album') : null;
};

const artistSongs = async (id: MediaId, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> => {
    if (authorized()) {
        const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(
            `/catalog/${storefront()}/artists/${encodeURIComponent(String(id))}/songs`,
            { limit, offset },
        );
        return pageFromEnvelope(body, normalizeAppleSong, offset, limit);
    }
    // 匿名层没有歌手 id 的曲目接口，只能按歌手名搜歌；结果是近似集合，不是完整作品表。
    const results = await searchItunes(String(id), 'song', limit, offset, 'artistTerm');
    return applePage(results.filter(isApplePlayableTrack).map(normalizeAppleSong), undefined, offset, limit);
};

const artistAlbums = async (id: MediaId, limit: number, offset: number): Promise<ProviderPage<ProviderCollection>> => {
    if (authorized()) {
        const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(
            `/catalog/${storefront()}/artists/${encodeURIComponent(String(id))}/albums`,
            { limit, offset },
        );
        return pageFromEnvelope(body, item => normalizeAppleCollection(item, 'album'), offset, limit);
    }
    const results = await searchItunes(String(id), 'album', limit, offset, 'artistTerm');
    return applePage(results.map(item => normalizeAppleCollection(item, 'album')), undefined, offset, limit);
};

const artistDetail = async (id: MediaId): Promise<ProviderCollection | null> => {
    if (authorized()) {
        const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(`/catalog/${storefront()}/artists/${encodeURIComponent(String(id))}`);
        const first = body?.data?.[0];
        return first ? normalizeAppleCollection(first, 'artist') : null;
    }
    const results = await lookupItunes([id], 'musicArtist', 1);
    const first = results[0];
    return first ? normalizeAppleCollection(first, 'artist') : null;
};

/** 公开歌单在官方接口下可读；匿名层没有歌单接口。 */
const playlistTracks = async (id: MediaId, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> => {
    const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(
        `/catalog/${storefront()}/playlists/${encodeURIComponent(String(id))}/tracks`,
        { limit, offset },
    );
    return pageFromEnvelope(body, normalizeAppleSong, offset, limit);
};

const playlistDetail = async (id: MediaId): Promise<ProviderCollection | null> => {
    const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(`/catalog/${storefront()}/playlists/${encodeURIComponent(String(id))}`);
    const first = body?.data?.[0];
    return first ? normalizeAppleCollection(first, 'playlist') : null;
};

const appleMusicCatalog: OnlineCatalogProvider = {
    canResolveSongCatalogRefs: song => (
        song.sourceRef?.kind === 'online' && song.sourceRef.providerId === APPLE_MUSIC_PROVIDER_ID && authorized()
    ),
    async resolveSongCatalogRefs(song) {
        const detail = await getSongDetail(song.id);
        return detail || (song as UnifiedSong);
    },
    getPlaylistTracks: (id, limit = DEFAULT_PAGE_LIMIT, offset = 0) => playlistTracks(id, limit, offset),
    getPlaylistDetail: id => playlistDetail(id),
    getAlbumTracks: (id, limit = DEFAULT_PAGE_LIMIT, offset = 0) => albumTracks(id, limit, offset),
    getAlbumDetail: id => albumDetail(id),
    getArtistSongs: (id, limit, offset) => artistSongs(id, limit, offset),
    getArtistAlbums: (id, limit, offset) => artistAlbums(id, limit, offset),
    getArtistDetail: id => artistDetail(id),
};

const getSongDetail = async (id: MediaId): Promise<UnifiedSong | null> => {
    if (authorized()) {
        const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(`/catalog/${storefront()}/songs/${encodeURIComponent(String(id))}`);
        const first = body?.data?.[0];
        return first ? normalizeAppleSong(first) : null;
    }
    const results = await lookupItunes([id], 'song', 1);
    const first = results[0];
    return first ? normalizeAppleSong(first) : null;
};

// ─── 登录（凭据式，非扫码） ─────────────────────────────────────────────

const CREDENTIAL_FIELDS: ProviderCredentialField[] = [
    {
        id: 'developerToken',
        labelKey: 'options.appleMusicDeveloperToken',
        hintKey: 'options.appleMusicDeveloperTokenHint',
        secret: true,
    },
    {
        id: 'userToken',
        labelKey: 'options.appleMusicUserToken',
        hintKey: 'options.appleMusicUserTokenHint',
        secret: true,
        optional: true,
    },
    {
        id: 'storefront',
        labelKey: 'options.appleMusicStorefront',
        hintKey: 'options.appleMusicStorefrontHint',
        placeholder: 'us',
    },
];

/** 用 developer token 探一次目录接口，验证凭据真的能用，而不是只存下来。 */
const verifyCredentials = async (developerToken: string, userToken: string, target: string): Promise<ProviderUser> => {
    const previous = getAppleMusicCredentials();
    setAppleMusicCredentials({ developerToken, userToken, storefront: target });
    try {
        await requestAppleMusicApi(`/catalog/${normalizeStorefront(target)}/songs/1440935467`);
    } catch (error) {
        // 校验失败就把旧配置放回去，别让一次输错的凭据覆盖掉还能用的配置。
        setAppleMusicCredentials(previous);
        throw error;
    }
    let user: ProviderUser = normalizeAppleUser({ id: 'apple-music-user', nickname: 'Apple Music' });
    if (userToken) {
        try {
            // Music-User-Token 没配时 /v1/me 会 403；有 token 却没开通曲库权限也同样失败，
            // 那种情况下目录仍然可用，所以这里失败不阻断登录。
            const me = await requestAppleMusicUserApi<AppleDataEnvelope<any>>('/me');
            const storefrontId = me?.data?.[0]?.id;
            if (storefrontId) user = normalizeAppleUser({ id: String(storefrontId), nickname: `Apple Music · ${target.toUpperCase()}` });
        } catch {
            // 保持仅目录身份。
        }
    }
    return user;
};

const loginStatus = async (): Promise<ProviderUser | null> => {
    const credentials = getAppleMusicCredentials();
    if (!credentials.developerToken) return null;
    try {
        return await verifyCredentials(credentials.developerToken, credentials.userToken, credentials.storefront);
    } catch {
        // 凭据过期（developer token 最长 6 个月）时不能假装还登录着；也不清掉它，
        // 否则用户看不到「配置过期了，重新贴一份」，只会看到「没配置过」。
        throw new OnlineProviderError('auth-required', 'Apple Music credentials are no longer accepted', APPLE_MUSIC_PROVIDER_ID);
    }
};

/** 试听地址只在归一化时存了一次；源数据里没有（缓存旧条目 / 手工构造的歌曲）就回查目录。 */
const audioSourceFor = async (sourceRef: Extract<PlaybackSourceRef, { kind: 'online' }>) => {
    const data = sourceRef.providerData || {};
    const stored = typeof data.previewUrl === 'string' ? data.previewUrl : '';
    const url = stored || await resolveApplePreviewUrl(String(sourceRef.mediaId));
    if (!url) throw new OnlineProviderError('preview-only', 'Apple Music has no preview for this track', APPLE_MUSIC_PROVIDER_ID);
    return { url, fetchedAt: Date.now(), quality: 'standard' as const };
};

const lyricsFor = async (sourceRef: Extract<PlaybackSourceRef, { kind: 'online' }>): Promise<ProviderLyricsResult> => {
    const mediaId = encodeURIComponent(String(sourceRef.mediaId));
    const body = await requestAppleMusicApi<AppleDataEnvelope<any>>(`/catalog/${storefront()}/songs/${mediaId}/lyrics`);
    const attributes = appleRecord(body?.data?.[0]?.attributes);
    const ttml = typeof attributes.ttml === 'string' ? attributes.ttml : '';
    try {
        return parseAppleMusicLyrics(ttml);
    } catch {
        throw new OnlineProviderError('invalid-response', 'Apple Music returned lyrics in an unexpected format', APPLE_MUSIC_PROVIDER_ID);
    }
};

export const appleMusicProvider: OnlineMusicProvider = {
    id: APPLE_MUSIC_PROVIDER_ID,
    displayName: 'Apple Music',
    shortName: 'Apple',
    getAvailability: () => ({ configured: true }),
    capabilities: {
        search: true,
        // 只有 30 秒试听：整曲是 FairPlay DRM，官方接口不提供音频流。
        playback: true,
        previewPlayback: true,
        lyrics: true,
        staticOnlyLyrics: true,
        // 登录 = 粘贴官方凭据，不是扫码；auth 仍为 true，让账户面板显示入口。
        auth: true,
        manualCredentials: true,
        // 用户曲库、歌单、专辑、歌手与推荐都走官方接口，凭据缺失时由 Omni 报 auth-required。
        userLibrary: true,
        userAlbums: true,
        playlists: true,
        albums: true,
        artists: true,
        recommendations: false,
        mutations: false,
        wordByWordLyrics: false,
    },
    normalizeSong: normalizeAppleSong,
    normalizeUser: normalizeAppleUser,
    normalizeCollection: raw => normalizeAppleCollection(raw, 'album'),
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    getSongPageUrl(song) {
        const mediaId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id;
        return mediaId ? `https://music.apple.com/${storefront()}/song/${mediaId}` : null;
    },
    search: { searchSongs },
    playback: {
        async getSongDetail(id) {
            return getSongDetail(id);
        },
        async getAudioSource(song) {
            if (song.sourceRef?.kind !== 'online' || song.sourceRef.providerId !== APPLE_MUSIC_PROVIDER_ID) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Apple Music', APPLE_MUSIC_PROVIDER_ID);
            }
            return audioSourceFor(song.sourceRef);
        },
        getAvailability(song) {
            if (song.sourceRef?.kind !== 'online' || song.sourceRef.providerId !== APPLE_MUSIC_PROVIDER_ID) {
                return { state: 'unknown' };
            }
            // 试听是 Apple 给的宣传片段，不是「这首歌能播」；界面据此说明 30 秒限制。
            return song.sourceRef.providerData?.unavailable
                ? { state: 'unavailable', label: 'No preview available' }
                : { state: 'playable', label: '30-second preview' };
        },
    },
    lyrics: {
        async getLyrics(song) {
            if (song.sourceRef?.kind !== 'online' || song.sourceRef.providerId !== APPLE_MUSIC_PROVIDER_ID) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Apple Music', APPLE_MUSIC_PROVIDER_ID);
            }
            if (!authorized()) {
                throw new OnlineProviderError('auth-required', 'Apple Music lyrics require a MusicKit developer token', APPLE_MUSIC_PROVIDER_ID);
            }
            return lyricsFor(song.sourceRef);
        },
    },
    auth: {
        getLoginStatus: loginStatus,
        // 只有官方层需要凭据；匿名层（iTunes Search + 试听）不需要，所以未配置时不算「未登录的账户」。
        hasAccount: () => getAppleMusicTransportStatus().authorized,
        async logout() {
            clearAppleMusicCredentials();
        },
        // 声明成「凭据式登录」：不实现 getQrKey / createQr / checkQr，登录会话不会被启动，
        // 界面改用 getCredentialFields + submitCredentials 的表单。
        getCredentialFields: () => CREDENTIAL_FIELDS,
        async submitCredentials(values: ProviderCredentialValues) {
            const developerToken = (values.developerToken || '').trim();
            const userToken = (values.userToken || '').trim();
            if (!developerToken) {
                throw new OnlineProviderError('auth-required', 'A MusicKit developer token is required', APPLE_MUSIC_PROVIDER_ID);
            }
            return verifyCredentials(developerToken, userToken, normalizeStorefront(values.storefront));
        },
    },
    catalog: appleMusicCatalog,
    library: {
        async getUserPlaylists(_userId, limit, offset) {
            const body = await requestAppleMusicUserApi<AppleDataEnvelope<any>>('/me/library/playlists', { limit, offset });
            return pageFromEnvelope(body, item => normalizeAppleCollection(item, 'playlist'), offset, limit);
        },
        async getUserAlbums(_userId, limit, offset) {
            const body = await requestAppleMusicUserApi<AppleDataEnvelope<any>>('/me/library/albums', { limit, offset });
            return pageFromEnvelope(body, item => normalizeAppleCollection(item, 'album'), offset, limit);
        },
        /**
         * 用户曲库里没有「喜欢」这个集合（收藏是「已加入资料库」），所以把已收藏歌曲
         * 当作收藏列表读出来，而不是谎报一个点赞集合。
         */
        async getLikedSongs() {
            const body = await requestAppleMusicUserApi<AppleDataEnvelope<any>>('/me/library/songs', { limit: 300 });
            return (Array.isArray(body?.data) ? body.data : []).map(normalizeAppleSong);
        },
    },
};

export { getSongDetail as getAppleMusicSongDetail, searchAlbums as searchAppleMusicAlbums, searchArtists as searchAppleMusicArtists };
