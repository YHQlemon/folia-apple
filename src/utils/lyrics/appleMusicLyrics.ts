import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseTTML } from './parserCore';
import { isPureMusicLyricText } from './pureMusic';

// src/utils/lyrics/appleMusicLyrics.ts
// Apple 的歌词接口直接返回 TTML（`/v1/catalog/{sf}/songs/{id}/lyrics` 的 attributes.ttml），
// 所以这里只是把它交给仓库里现成的 TTML 解析器；Apple 不提供逐音节之外的额外文本字段。

/** 解析 Apple Music 的 TTML 歌词；空内容按无歌词处理，解析失败向上抛给 adapter 归类。 */
export function parseAppleMusicLyrics(ttml: string | null | undefined): ProviderLyricsResult {
    const content = typeof ttml === 'string' ? ttml : '';
    if (!content.trim()) return { lyrics: null, isPureMusic: false };
    const lyrics = parseTTML(content);
    if (!lyrics.lines.length) return { lyrics: null, isPureMusic: false };
    return { lyrics, isPureMusic: isPureMusicLyricText(content) };
}
