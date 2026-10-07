import type { Artist, UnifiedSong } from '../../types';
import type { JsonValue, ProviderCollection, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/appleMusicNormalize.ts
// Apple 的数据有两种信封：iTunes Search API 把字段平铺在结果对象上（trackId / artworkUrl100），
// 官方 Apple Music API 把它们收在 attributes 里（id / attributes.artwork.url）。两者在这里归一。

export const APPLE_MUSIC_PROVIDER_ID = 'apple';
export const APPLE_MUSIC_DEFAULT_STOREFRONT = 'us';

export type AppleRecord = Record<string, any>;

export const appleRecord = (value: unknown): AppleRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as AppleRecord : {}
);

const text = (value: unknown): string => (value == null ? '' : String(value));

/** 官方 API 把 id 拆成 catalogId / id 两处，iTunes 用 trackId / collectionId / artistId。 */
const idOf = (item: AppleRecord, ...keys: string[]): string => {
    for (const key of keys) {
        const value = item[key];
        if (value !== undefined && value !== null && value !== '') return text(value);
    }
    const attributes = appleRecord(item.attributes);
    for (const key of keys) {
        const value = attributes[key];
        if (value !== undefined && value !== null && value !== '') return text(value);
    }
    return '';
};

const attributesOf = (item: AppleRecord): AppleRecord => appleRecord(item.attributes);

/**
 * artwork 有两种形态：iTunes 给 artworkUrl100（100x100bb.jpg），官方 API 给
 * artwork.url 模板（{w}x{h}bb.jpg）。取一张尽量大的方图给封面用。
 */
export const appleArtworkUrl = (item: AppleRecord, size = 1000): string => {
    const attributes = attributesOf(item);
    const template = text(attributes.artwork?.url || item.artwork?.url);
    if (template) return template.replace('{w}', String(size)).replace('{h}', String(size));
    const hundred = text(item.artworkUrl100 || attributes.artworkUrl100);
    if (hundred) return hundred.replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}x${size}bb.$1`);
    const coarse = text(item.artworkUrl60 || item.artworkUrl30);
    return coarse ? coarse.replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}x${size}bb.$1`) : '';
};

const isSongRecord = (item: AppleRecord): boolean => (
    text(item.wrapperType) === 'track' || text(item.type) === 'songs' || Boolean(attributesOf(item).previews)
    || Boolean(item.previewUrl) || Boolean(item.trackId) || Boolean(item.attributes?.durationInMillis)
);

/** iTunes 的 kind 字段会把非歌曲条目（music-video、podcast）也放进 entity=song 的结果里。 */
const isPlayableAudioTrack = (item: AppleRecord): boolean => {
    const kind = text(item.kind);
    if (!kind) return true;
    return kind === 'song' || kind === 'music video' || kind.startsWith('song');
};

const artistsOf = (item: AppleRecord): Artist[] => {
    const attributes = attributesOf(item);
    const raw = Array.isArray(attributes.artistName) ? attributes.artistName
        : Array.isArray(item.artists) ? item.artists
            : null;
    if (raw) {
        return raw
            .map((entry: unknown) => (typeof entry === 'string' ? { name: entry } : entry as AppleRecord))
            .filter((entry: AppleRecord) => text(entry.name || entry.artistName))
            .map((entry: AppleRecord) => ({
                id: idOf(entry, 'id', 'artistId') || text(entry.name || entry.artistName),
                name: text(entry.name || entry.artistName),
                catalogRef: { providerId: APPLE_MUSIC_PROVIDER_ID, kind: 'artist' as const, id: idOf(entry, 'id', 'artistId') || text(entry.name || entry.artistName) },
            }));
    }
    // iTunes 只给一个 artistName；完整署名在 artistName 里用 " & " / ", " 分隔。
    const names = text(item.artistName || attributes.artistName)
        .split(/\s*(?:&|,|、|\/|feat\.|ft\.)\s*/i)
        .map(name => name.trim())
        .filter(Boolean);
    const artistId = idOf(item, 'artistId');
    return (names.length ? names : [text(item.artistName || attributes.artistName)]).filter(Boolean).map(name => ({
        id: artistId || name,
        name,
        ...(artistId ? { catalogRef: { providerId: APPLE_MUSIC_PROVIDER_ID, kind: 'artist' as const, id: artistId } } : {}),
    }));
};

/** preview 只出现在歌曲上；官方 API 的 previews[0].url 与 iTunes 的 previewUrl 语义相同。 */
export const applePreviewUrl = (item: AppleRecord): string => {
    const attributes = attributesOf(item);
    const previews = Array.isArray(attributes.previews) ? attributes.previews : Array.isArray(item.previews) ? item.previews : [];
    const first = previews.find((entry: unknown) => text(appleRecord(entry).url));
    return text(appleRecord(first).url || item.previewUrl || attributes.previewUrl);
};

export const normalizeAppleSong = (raw: unknown): UnifiedSong => {
    const item = appleRecord(raw);
    // 已归一化的缓存对象直接透传，避免把毫秒时长再乘一次。
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === APPLE_MUSIC_PROVIDER_ID) {
        return item as UnifiedSong;
    }
    const attributes = attributesOf(item);
    const id = idOf(item, 'id', 'trackId', 'catalogId');
    if (!id || !isSongRecord(item)) {
        throw new OnlineProviderError('invalid-response', 'Apple Music song has no id', APPLE_MUSIC_PROVIDER_ID);
    }
    const durationMs = Number(attributes.durationInMillis ?? item.trackTimeMillis ?? 0) || 0;
    const collectionId = idOf(item, 'collectionId');
    const preview = applePreviewUrl(item);
    const data: Record<string, JsonValue> = {};
    // 预览地址随归一化结果一起存下来：音频请求不必再打一次目录接口，也解释了这不是整曲。
    if (preview) {
        data.previewUrl = preview;
        data.previewOnly = true;
    }
    if (!preview) data.unavailable = true;
    const artwork = appleArtworkUrl(item);
    const albumName = text(attributes.albumName || item.collectionName);
    return {
        id,
        name: text(attributes.name || item.trackName),
        artists: artistsOf(item),
        album: {
            id: collectionId,
            name: albumName,
            coverUrl: artwork,
            ...(collectionId ? { catalogRef: { providerId: APPLE_MUSIC_PROVIDER_ID, kind: 'album' as const, id: collectionId } } : {}),
        },
        durationMs: Math.max(0, durationMs),
        sourceRef: {
            kind: 'online',
            providerId: APPLE_MUSIC_PROVIDER_ID,
            mediaId: id,
            providerData: data,
        },
    };
};

export const normalizeAppleCollection = (raw: unknown, type: 'album' | 'artist' | 'playlist' = 'album'): ProviderCollection => {
    const item = appleRecord(raw);
    if (item.providerId === APPLE_MUSIC_PROVIDER_ID) return item as ProviderCollection;
    const attributes = attributesOf(item);
    const id = idOf(item, 'id', 'collectionId', 'artistId');
    if (!id) throw new OnlineProviderError('invalid-response', 'Apple Music collection has no id', APPLE_MUSIC_PROVIDER_ID);
    const trackCount = Number(attributes.trackCount ?? item.trackCount ?? 0) || 0;
    const releaseDate = text(attributes.releaseDate || item.releaseDate);
    const publishedAt = Date.parse(releaseDate);
    const artwork = appleArtworkUrl(item);
    return {
        providerId: APPLE_MUSIC_PROVIDER_ID,
        id,
        type,
        name: text(attributes.name || item.collectionName || item.artistName),
        coverUrl: artwork,
        description: text(attributes.description?.standard || attributes.editorialNotes?.standard || item.description),
        ...(trackCount ? { trackCount } : {}),
        ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
        ...(releaseDate ? { publisher: releaseDate.slice(0, 4) } : {}),
        artists: type === 'artist' ? [] : artistsOf(item),
    };
};

export const normalizeAppleUser = (raw: unknown): ProviderUser => {
    const item = appleRecord(raw);
    const id = text(item.id || item.userId || 'apple-music-user');
    return {
        id,
        nickname: text(item.nickname || item.name || 'Apple Music'),
        avatarUrl: text(item.avatarUrl) || undefined,
    };
};

/** Apple 的分页是 limit / offset；总数只在部分接口出现，缺失时按「取满一页就还有下一批」处理。 */
export const applePage = <T>(items: T[], total: unknown, offset: number, limit: number): ProviderPage<T> => {
    const count = Number(total);
    const knownTotal = total != null && Number.isFinite(count) && count >= 0;
    const nextOffset = offset + items.length;
    return {
        items,
        ...(knownTotal ? { total: count } : {}),
        nextOffset,
        hasMore: knownTotal ? nextOffset < count : items.length === limit && items.length > 0,
    };
};

export const isAppleSongRecord = isSongRecord;
export const isApplePlayableTrack = isPlayableAudioTrack;
export const appleText = text;
