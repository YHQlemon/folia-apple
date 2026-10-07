import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSong } from '@/types';
import { OnlineProviderError } from '@/types/onlineMusic';
import {
    appleArtworkUrl,
    applePage,
    normalizeAppleCollection,
    normalizeAppleSong,
    normalizeAppleUser,
} from '@/services/onlineMusic/appleMusicNormalize';
import {
    getAppleMusicCredentials,
    normalizeStorefront,
    setAppleMusicCredentials,
    subscribeAppleMusicCredentials,
} from '@/services/onlineMusic/appleMusicTransport';

// test/unit/onlineMusic/appleMusicProvider.test.ts
// Apple Music 接入的两层信封（iTunes Search 的平铺字段与官方 API 的 attributes）都必须在
// adapter 边界归一，且「只有 30 秒试听」这个事实不能被任何一层伪装成完整曲目。

// iTunes Search API 的歌曲结果（平铺字段）。
const itunesTrack = {
    wrapperType: 'track',
    kind: 'song',
    trackId: 1440935467,
    trackName: 'Blank Space',
    artistId: 159260351,
    artistName: 'Taylor Swift',
    collectionId: 1440935467,
    collectionName: '1989',
    trackTimeMillis: 231833,
    previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/preview.m4a',
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/cover/100x100bb.jpg',
    country: 'USA',
};

// 官方 Apple Music API 的歌曲资源（attributes 信封）。
const officialSong = {
    id: '1440935467',
    type: 'songs',
    attributes: {
        name: 'Blank Space',
        artistName: 'Taylor Swift',
        albumName: '1989',
        durationInMillis: 231833,
        artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music/cover/{w}x{h}bb.jpg' },
        previews: [{ url: 'https://audio-ssl.itunes.apple.com/itunes-assets/preview-official.m4a' }],
    },
};

describe('Apple Music normalization', () => {
    it('normalizes an iTunes search result without losing catalog identity', () => {
        const song = normalizeAppleSong(itunesTrack);
        expect(song).toMatchObject({
            id: '1440935467',
            name: 'Blank Space',
            durationMs: 231833,
            album: { id: '1440935467', name: '1989' },
            sourceRef: { kind: 'online', providerId: 'apple', mediaId: '1440935467' },
        });
        expect(song.artists[0]).toMatchObject({ id: '159260351', name: 'Taylor Swift' });
        // 试听地址随归一化结果保存，音频请求不必再打一次目录接口。
        expect(song.sourceRef).toMatchObject({
            providerData: { previewUrl: itunesTrack.previewUrl, previewOnly: true },
        });
    });

    it('normalizes the official attributes envelope to the same shape', () => {
        const song = normalizeAppleSong(officialSong);
        expect(song).toMatchObject({
            id: '1440935467',
            name: 'Blank Space',
            durationMs: 231833,
            sourceRef: { kind: 'online', providerId: 'apple', mediaId: '1440935467' },
        });
        expect(song.sourceRef).toMatchObject({
            providerData: { previewUrl: officialSong.attributes.previews[0].url },
        });
        expect(song.album.coverUrl).toBe('https://is1-ssl.mzstatic.com/image/thumb/Music/cover/1000x1000bb.jpg');
    });

    it('marks a song without any preview as unavailable instead of claiming it plays', () => {
        const song = normalizeAppleSong({ ...itunesTrack, previewUrl: undefined });
        expect(song.sourceRef).toMatchObject({ providerData: { unavailable: true } });
        expect(song.sourceRef).not.toMatchObject({ providerData: { previewUrl: expect.anything() } });
    });

    it('is idempotent and rejects a record with no id', () => {
        const song = normalizeAppleSong(itunesTrack);
        expect(normalizeAppleSong(song)).toEqual(song);
        expect(() => normalizeAppleSong({ name: 'no id' })).toThrow(OnlineProviderError);
    });

    it('splits a combined artist credit and builds catalog references', () => {
        const song = normalizeAppleSong({ ...itunesTrack, artistName: 'Jay Chou & Landy Wen' });
        expect(song.artists.map(artist => artist.name)).toEqual(['Jay Chou', 'Landy Wen']);
        expect(song.album.catalogRef).toEqual({ providerId: 'apple', kind: 'album', id: '1440935467' });
    });

    it('rewrites the artwork template to a single requested size', () => {
        expect(appleArtworkUrl(officialSong, 600)).toContain('/600x600bb.jpg');
        expect(appleArtworkUrl(itunesTrack, 600)).toContain('/600x600bb.jpg');
        expect(appleArtworkUrl({}, 600)).toBe('');
    });

    it('normalizes collections and users, and paginates on limit/offset', () => {
        const album = normalizeAppleCollection({
            collectionId: 1440935467, collectionName: '1989', trackCount: 13,
            releaseDate: '2014-10-27T07:00:00Z', artistName: 'Taylor Swift',
        }, 'album');
        expect(album).toMatchObject({ providerId: 'apple', id: '1440935467', type: 'album', name: '1989', trackCount: 13 });
        expect(album.publishedAt).toBe(Date.parse('2014-10-27T07:00:00Z'));
        expect(normalizeAppleUser({ id: 'u1', name: 'Listener' })).toMatchObject({ id: 'u1', nickname: 'Listener' });

        // 有总数时按总数判断；没有总数时只有取满一页才认为还有下一批。
        expect(applePage([1, 2], 5, 0, 2)).toMatchObject({ nextOffset: 2, hasMore: true, total: 5 });
        expect(applePage([1], 5, 4, 2)).toMatchObject({ nextOffset: 5, hasMore: false });
        expect(applePage([1, 2], undefined, 0, 2)).toMatchObject({ nextOffset: 2, hasMore: true });
        expect(applePage([1], undefined, 0, 2)).toMatchObject({ nextOffset: 1, hasMore: false });
    });
});

describe('Apple Music transport credentials', () => {
    const store = new Map<string, string>();

    beforeEach(() => {
        store.clear();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => { store.set(key, value); },
            removeItem: (key: string) => { store.delete(key); },
        });
    });

    it('accepts only a two-letter storefront, including one pasted from an API URL', () => {
        expect(normalizeStorefront('US')).toBe('us');
        expect(normalizeStorefront('jp')).toBe('jp');
        expect(normalizeStorefront('https://api.music.apple.com/v1/catalog/gb/songs/1')).toBe('gb');
        expect(normalizeStorefront('')).toBe('us');
        expect(normalizeStorefront('china')).toBe('us');
    });

    it('persists credentials and notifies subscribers', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeAppleMusicCredentials(listener);
        setAppleMusicCredentials({ developerToken: 'dev-token', userToken: 'user-token', storefront: 'JP' });
        expect(getAppleMusicCredentials()).toEqual({ developerToken: 'dev-token', userToken: 'user-token', storefront: 'jp' });
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        setAppleMusicCredentials({ storefront: 'us' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getAppleMusicCredentials().developerToken).toBe('dev-token');
    });
});
