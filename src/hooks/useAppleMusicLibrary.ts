import { useCallback, useEffect, useRef } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { clearProviderAccountSnapshot, loadProviderAccountSnapshot, saveProviderAccountSnapshot } from '../services/onlineMusic/providerAccountCache';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '../types/onlineMusic';
import type { MediaId, ProviderCollection } from '../types/onlineMusic';

// src/hooks/useAppleMusicLibrary.ts
// Apple Music 的账户刷新。与 bodian 的不同在于「没配置凭据」是正常状态而不是失败：
// 匿名层（iTunes Search + 30 秒试听）本来就无需登录，所以凭据缺失时清账户、返回 false，
// 不写 error，也不用 auth-required 弹任何东西。凭据失效（developer token 过期）才归为 auth-required。

export const useAppleMusicLibrary = () => {
    const generation = useRef(0);
    const pendingSave = useRef<Promise<unknown>>(Promise.resolve());

    const refresh = useCallback(async () => {
        const current = ++generation.current;
        const store = useOnlineProviderAccountStore.getState();
        try {
            if (!omni.getProviderCapabilities('apple').auth) {
                store.clearAccount('apple');
                return false;
            }
            store.updateAccount('apple', { freshness: 'refreshing', error: undefined });
            let user = null;
            try {
                user = await omni.getLoginStatus('apple');
            } catch (error) {
                // 凭据存在但已失效：保留配置（用户要能看到自己配过），把状态标成 auth-required。
                if (error instanceof OnlineProviderError && error.code === 'auth-required') {
                    store.updateAccount('apple', { status: 'error', hydration: 'ready', freshness: 'error', error: 'auth-required' });
                    return false;
                }
                throw error;
            }
            if (generation.current !== current) return false;
            if (!user) {
                // 没配凭据：目录与试听照常可用，账户面板显示未登录即可。
                store.clearAccount('apple');
                await pendingSave.current.catch(() => {});
                await clearProviderAccountSnapshot('apple');
                return false;
            }
            const visibleUser = useOnlineProviderAccountStore.getState().accounts.apple?.user;
            if (!visibleUser || String(visibleUser.id) !== String(user.id)) {
                store.clearAccount('apple');
                const snapshot = await loadProviderAccountSnapshot('apple').catch(() => null);
                if (generation.current !== current) return false;
                const matching = snapshot && String(snapshot.user.id) === String(user.id) ? snapshot : null;
                store.updateAccount('apple', {
                    status: 'authenticated', user,
                    collections: matching?.collections || [], likedSongIds: matching?.likedSongIds || [],
                    hydration: 'ready', freshness: 'refreshing', lastUpdatedAt: matching?.savedAt, error: undefined,
                });
            }
            const likesBeforeRefresh = useOnlineProviderAccountStore.getState().accounts.apple.likedSongIds;
            const collections: ProviderCollection[] = [];
            const capabilities = omni.getProviderCapabilities('apple');
            let offset = 0;
            if (capabilities.userLibrary) {
                while (true) {
                    const page = await omni.getProviderUserPlaylists('apple', user.id, { offset, limit: 50 });
                    if (generation.current !== current) return false;
                    collections.push(...page.items);
                    if (!page.hasMore || page.nextOffset <= offset) break;
                    offset = page.nextOffset;
                }
            }
            // Apple 没有「喜欢」集合，点赞列表由已收藏歌曲推导；这里按 library.getLikedSongs 读。
            const fetchedLikedSongIds: MediaId[] = capabilities.likes
                ? await omni.getProviderLikedSongIds('apple', user.id)
                : [];
            if (generation.current !== current) return false;
            const save = pendingSave.current.catch(() => {}).then(() => {
                if (generation.current !== current) return null;
                const latestLikes = useOnlineProviderAccountStore.getState().accounts.apple.likedSongIds;
                const likedSongIds = latestLikes === likesBeforeRefresh ? fetchedLikedSongIds : latestLikes;
                store.updateAccount('apple', {
                    status: 'authenticated', user, collections, likedSongIds,
                    hydration: 'ready', error: undefined,
                });
                return saveProviderAccountSnapshot('apple', { user, collections, likedSongIds });
            });
            pendingSave.current = save;
            const saved = await save;
            if (generation.current !== current) return false;
            if (!saved) return false;
            store.updateAccount('apple', { freshness: 'fresh', lastUpdatedAt: saved.savedAt });
            return true;
        } catch (error) {
            if (generation.current !== current) return false;
            store.updateAccount('apple', {
                hydration: 'ready', freshness: 'error',
                status: useOnlineProviderAccountStore.getState().accounts.apple?.user ? 'authenticated' : 'error',
                error: 'apple-refresh-failed',
            });
            return false;
        }
    }, []);

    const logout = useCallback(async () => {
        generation.current++;
        useOnlineProviderAccountStore.getState().clearAccount('apple');
        await pendingSave.current.catch(() => {});
        await Promise.all([omni.logout('apple'), clearProviderAccountSnapshot('apple')]);
    }, []);

    useEffect(() => {
        useOnlineProviderAccountStore.getState().clearAccount('apple');
        void refresh();
        return () => { generation.current++; };
    }, [refresh]);

    return { refresh, logout };
};
