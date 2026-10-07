import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, Loader2, LogOut, Music4 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { omni } from '../../../services/onlineMusic/omni';
import {
    APPLE_MUSIC_STOREFRONTS,
    getAppleMusicCredentials,
    getAppleMusicTransportStatus,
    subscribeAppleMusicCredentials,
} from '../../../services/onlineMusic/appleMusicTransport';
import type { ProviderCredentialField } from '../../../types/onlineMusic';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';

// src/components/modal/settings/AppleMusicSettingsSection.tsx
// Apple Music 的设置区。这里放的是「接入方式」而不是一个开关：Apple Music 的目录接口分两层，
// 匿名层（iTunes Search + 30 秒试听）不需要任何配置，官方层需要用户自己粘贴 MusicKit 凭据。
// 组件自己读写 transport 的凭据状态，所以设置面板与登录弹窗看到的是同一份配置。

type Props = {
    settingsCardClass: string;
    successBgColor: string;
    successTextColor: string;
    errorBgColor: string;
    errorTextColor: string;
};

const APPLE_MUSIC_PROVIDER_ID = 'apple';

const AppleMusicSettingsSection: React.FC<Props> = ({
    settingsCardClass,
    successBgColor,
    successTextColor,
    errorBgColor,
    errorTextColor,
}) => {
    const { t } = useTranslation();
    const [status, setStatus] = useState(() => getAppleMusicTransportStatus());
    const [draft, setDraft] = useState<Record<string, string>>(() => {
        const credentials = getAppleMusicCredentials();
        // 密钥类字段从不回填：读回来等于把凭据留在界面上，而它已经存在本地了。
        return { storefront: credentials.storefront, developerToken: '', userToken: '' };
    });
    const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'success' | 'failed'>('idle');
    const [errorText, setErrorText] = useState<string | null>(null);

    useEffect(() => subscribeAppleMusicCredentials(() => setStatus(getAppleMusicTransportStatus())), []);

    const fields = useMemo<ProviderCredentialField[]>(
        () => omni.getProviderCredentialFields(APPLE_MUSIC_PROVIDER_ID),
        [],
    );

    const handleSubmit = useCallback(async () => {
        setSubmitState('submitting');
        setErrorText(null);
        try {
            await omni.submitProviderCredentials(APPLE_MUSIC_PROVIDER_ID, draft);
            setSubmitState('success');
            setDraft(current => ({ ...current, developerToken: '', userToken: '' }));
        } catch (error) {
            setSubmitState('failed');
            setErrorText(error instanceof Error ? error.message : String(error));
        }
    }, [draft]);

    const handleClear = useCallback(async () => {
        await omni.logout(APPLE_MUSIC_PROVIDER_ID);
        setSubmitState('idle');
        setErrorText(null);
        setDraft(current => ({ ...current, developerToken: '', userToken: '' }));
    }, []);

    return (
        <SettingsAnchor anchorId="appleMusic" label={t('options.appleMusic')}>
            <SettingsSectionHeading icon={Music4} label={t('options.appleMusic')} />
            <div className={`p-4 rounded-xl border space-y-4 ${settingsCardClass}`}>
                <div className="space-y-1">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('options.appleMusicIntro')}
                    </div>
                    <div className="text-[10px] opacity-40 max-w-[420px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.appleMusicPreviewNotice')}
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-1 rounded-full text-[10px] ${successBgColor} ${successTextColor}`}>
                        {t('options.appleMusicCatalogReady')}
                    </span>
                    <span className={`px-2 py-1 rounded-full text-[10px] ${status.authorized ? `${successBgColor} ${successTextColor}` : `${errorBgColor} ${errorTextColor}`}`}>
                        {status.authorized ? t('options.appleMusicOfficialReady') : t('options.appleMusicOfficialMissing')}
                    </span>
                    <span className="text-[10px] opacity-50" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.appleMusicStorefrontCurrent', { storefront: status.storefront.toUpperCase() })}
                    </span>
                </div>

                {fields.map(field => (
                    <div key={field.id} className="space-y-2">
                        <label className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t(field.labelKey)}
                            {field.optional ? <span className="opacity-40"> · {t('options.appleMusicOptional')}</span> : null}
                        </label>
                        {field.id === 'storefront' ? (
                            <select
                                value={draft.storefront || status.storefront}
                                onChange={event => setDraft(current => ({ ...current, storefront: event.target.value }))}
                                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-white/30 transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                            >
                                {APPLE_MUSIC_STOREFRONTS.map((storefront: string) => (
                                    <option key={storefront} value={storefront} className="bg-zinc-900 text-white">
                                        {storefront.toUpperCase()}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <input
                                type={field.secret ? 'password' : 'text'}
                                value={draft[field.id] ?? ''}
                                onChange={event => setDraft(current => ({ ...current, [field.id]: event.target.value }))}
                                placeholder={field.placeholder}
                                autoComplete="off"
                                spellCheck={false}
                                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-white/30 transition-colors"
                                style={{ color: 'var(--text-primary)' }}
                            />
                        )}
                        {field.hintKey && (
                            <div className="text-[10px] opacity-40 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                {t(field.hintKey)}
                            </div>
                        )}
                    </div>
                ))}

                {status.storefront === 'cn' && (
                    <div className={`rounded-xl border p-3 text-[11px] leading-relaxed ${settingsCardClass}`} style={{ color: 'var(--text-secondary)' }}>
                        {t('options.appleMusicMainlandNotice')}
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                        type="button"
                        onClick={() => void handleSubmit()}
                        disabled={submitState === 'submitting' || !draft.developerToken}
                        className="px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {submitState === 'submitting'
                            ? <Loader2 size={16} className="animate-spin" />
                            : submitState === 'success'
                                ? <Check size={16} className={successTextColor} />
                                : <Music4 size={16} />}
                        {submitState === 'success' ? t('options.appleMusicSaved') : t('options.appleMusicSave')}
                    </button>
                    {status.developerToken && (
                        <button
                            type="button"
                            onClick={() => void handleClear()}
                            className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 ${errorBgColor} hover:bg-red-500/20 ${errorTextColor}`}
                        >
                            <LogOut size={16} />
                            {t('options.appleMusicClear')}
                        </button>
                    )}
                </div>

                {submitState === 'failed' && errorText && (
                    <div className={`flex items-start gap-2 text-[11px] ${errorTextColor}`}>
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span className="break-all">{errorText}</span>
                    </div>
                )}
            </div>
        </SettingsAnchor>
    );
};

export default AppleMusicSettingsSection;
