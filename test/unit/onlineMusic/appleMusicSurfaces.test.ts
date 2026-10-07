import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import zhCN from '@/i18n/locales/zh-CN';
import indonesian from '@/i18n/locales/in';
import { getAppleMusicTransportStatus } from '@/services/onlineMusic/appleMusicTransport';
import { appleMusicProvider } from '@/services/onlineMusic/appleMusicProvider';
import { getOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';

// test/unit/onlineMusic/appleMusicSurfaces.test.ts
// Apple Music 接入的接线契约：provider 真的注册进了 registry、能力声明与 Apple 的实际限制一致、
// 凭据字段与设置界面里的文案三份 i18n 都齐（缺一份就会在运行时显示成键名）。
// 界面本身按仓库既有做法（settingsAnchorCoverage.test.ts）在源码层校验，不做 SSR 渲染：
// 这台机器上依赖布局会产生两份 React，SSR 单测一律拿不到 dispatcher。

const SETTINGS_DIR = path.join(process.cwd(), 'src/components/modal/settings');
const localeFiles = { en, 'zh-CN': zhCN, in: indonesian } as const;

const readLocaleValue = (locale: Record<string, unknown>, key: string): unknown => (
    key.split('.').reduce<unknown>((current, part) => (
        current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
    ), locale)
);

describe('Apple Music wiring', () => {
    it('is registered under the apple id and declares the limits Apple actually has', () => {
        expect(getOnlineMusicProvider('apple')).toBe(appleMusicProvider);
        const capabilities = appleMusicProvider.capabilities;
        expect(capabilities).toMatchObject({
            search: true,
            playback: true,
            // 整曲是 FairPlay DRM：这里必须声明「只能试听」，否则界面会把 30 秒片段当整曲。
            previewPlayback: true,
            // 登录靠粘贴凭据，不是扫码。
            auth: true,
            manualCredentials: true,
            lyrics: true,
            staticOnlyLyrics: true,
            wordByWordLyrics: false,
            // Apple 的「喜欢」与歌单写入语义不同，宁可不声明。
            mutations: false,
            recommendations: false,
        });
    });

    it('reports the anonymous tier as usable without credentials, and no linked account', () => {
        const status = getAppleMusicTransportStatus();
        expect(status.configured).toBe(true);
        expect(status.authorized).toBe(false);
        expect(appleMusicProvider.getAvailability?.()).toEqual({ configured: true });
        // 未配置凭据 => 不算「未登录的账户」，界面直接切换而不是要求先登录。
        expect(appleMusicProvider.auth?.hasAccount?.()).toBe(false);
    });

    it('offers a credential form instead of QR login', () => {
        const fields = appleMusicProvider.auth?.getCredentialFields?.() ?? [];
        expect(fields.map(field => field.id)).toEqual(['developerToken', 'userToken', 'storefront']);
        // developer token 是必填的，user token 可留空。
        expect(fields.find(field => field.id === 'developerToken')).toMatchObject({ secret: true });
        expect(fields.find(field => field.id === 'userToken')).toMatchObject({ secret: true, optional: true });
        // 没有二维码入口：登录会话不会被启动。
        expect(appleMusicProvider.auth?.getQrKey).toBeUndefined();
        expect(appleMusicProvider.auth?.createQr).toBeUndefined();
        expect(appleMusicProvider.auth?.checkQr).toBeUndefined();
        expect(appleMusicProvider.auth?.getQrLoginMethods?.() ?? []).toEqual([]);
    });

    it('keeps every credential label and setting string in all three locales', () => {
        const keys = [
            ...(appleMusicProvider.auth?.getCredentialFields?.() ?? [])
                .flatMap(field => [field.labelKey, field.hintKey]),
            'options.appleMusic',
            'options.appleMusicIntro',
            'options.appleMusicPreviewNotice',
            'options.appleMusicCatalogReady',
            'options.appleMusicOfficialReady',
            'options.appleMusicOfficialMissing',
            'options.appleMusicStorefrontCurrent',
            'options.appleMusicOptional',
            'options.appleMusicMainlandNotice',
            'options.appleMusicSave',
            'options.appleMusicSaved',
            'options.appleMusicClear',
            'home.loginTitleAppleMusic',
            'home.loginNoteAppleMusic',
        ].filter((key): key is string => Boolean(key));
        for (const [name, locale] of Object.entries(localeFiles)) {
            for (const key of keys) {
                const value = readLocaleValue(locale as unknown as Record<string, unknown>, key);
                expect(typeof value, `${name}: ${key}`).toBe('string');
                expect(String(value).trim(), `${name}: ${key}`).not.toBe('');
            }
        }
    });

    it('renders the credential section from Integration settings with a registered anchor', () => {
        const source = fs.readFileSync(path.join(SETTINGS_DIR, 'AppleMusicSettingsSection.tsx'), 'utf8');
        // 明确的 30 秒试听说明必须出现在界面上，而不是只在代码注释里。
        expect(source).toContain("t('options.appleMusicPreviewNotice')");
        // 凭据字段的文案由 provider 声明的 labelKey 驱动，组件按声明渲染。
        expect(source).toContain('t(field.labelKey)');
        expect(source).toContain('t(field.hintKey)');
        expect(source).toContain('<SettingsAnchor anchorId="appleMusic"');
        // 密钥输入框按密码渲染，且不回填已保存的凭据。
        expect(source).toContain("field.secret ? 'password' : 'text'");
        expect(source).toContain('developerToken: \'\', userToken: \'\'');

        const integration = fs.readFileSync(path.join(SETTINGS_DIR, 'IntegrationSettingsSubview.tsx'), 'utf8');
        expect(integration).toContain('<AppleMusicSettingsSection');

        const anchors = fs.readFileSync(path.join(SETTINGS_DIR, 'navigation/settingsAnchorModel.ts'), 'utf8');
        expect(anchors).toContain("appleMusic: { section: 'integration', labelKey: 'options.appleMusic' }");
    });
});
