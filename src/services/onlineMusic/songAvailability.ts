import type { SongResult } from '../../types';
import type { ProviderSongAvailability, ProviderSongReplacement } from '../../types/onlineMusic';
import { getOnlineMusicProviderForSong } from './providerRegistry';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';

// src/services/onlineMusic/songAvailability.ts

const PLAYABLE: ProviderSongAvailability = { state: 'playable' };
const UNKNOWN: ProviderSongAvailability = { state: 'unknown' };

// Resolves provider-owned availability without exposing provider-specific fields to UI code.
export const getSongAvailability = (song: SongResult): ProviderSongAvailability => {
    if (getPlaybackSourceRef(song).kind !== 'online') return PLAYABLE;

    const provider = getOnlineMusicProviderForSong(song);
    return provider?.playback?.getAvailability?.(song) || UNKNOWN;
};

export const isSongUnavailable = (song: SongResult | null | undefined): boolean => (
    Boolean(song && getSongAvailability(song).state === 'unavailable')
);

export const getSongUnavailableLabel = (
    song: SongResult | null | undefined,
    fallbackLabel: string,
): string => {
    if (!song) return fallbackLabel;
    return getSongAvailability(song).label || fallbackLabel;
};

export const getSongReplacement = async (
    song: SongResult,
): Promise<ProviderSongReplacement | null> => {
    if (getPlaybackSourceRef(song).kind !== 'online') return null;
    return getOnlineMusicProviderForSong(song)?.playback?.getReplacement?.(song) || null;
};

/**
 * True when the bytes this song resolves to are a promotional clip rather than the complete
 * recording (Apple Music hands out 30-second previews). The provider adapter stamps it into the
 * source ref when it normalizes the song, so every layer reads the same value: the adapter also
 * declares `previewPlayback`, but that is a capability, not something a cached song still carries.
 *
 * A caller must not store such bytes as "this song's audio": it would answer an offline play with
 * a fragment, and the media cache counts it as a cached song.
 */
export const isPreviewOnlySong = (song: SongResult | null | undefined): boolean => {
    if (!song) return false;
    const sourceRef = getPlaybackSourceRef(song);
    return sourceRef.kind === 'online' && sourceRef.providerData?.previewOnly === true;
};
