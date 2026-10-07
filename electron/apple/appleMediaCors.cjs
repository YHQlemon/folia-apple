// electron/apple/appleMediaCors.cjs
// Apple Music 的媒体与封面域名：试听音频在 audio-ssl.itunes.apple.com，封面在 is*-ssl.mzstatic.com。
// 两者本身已经返回 Access-Control-Allow-Origin: *，但 webRequest.onHeadersReceived 的既有做法是
// 对这些平台域名重写 CORS 头（换 CDN、代理或缓存层可能把 * 换掉），从而不依赖上游是否照发。

const AUDIO_HOST = 'audio-ssl.itunes.apple.com';
const AUDIO_HOST_SUFFIXES = ['itunes.apple.com'];
const ARTWORK_HOST_PATTERN = /^is\d*-ssl\.mzstatic\.com$/i;
const ITUNES_API_HOST = 'itunes.apple.com';

const isAppleAudioHost = hostname => (
  hostname === AUDIO_HOST || AUDIO_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
);

const isAppleArtworkHost = hostname => ARTWORK_HOST_PATTERN.test(hostname) || hostname === 'mzstatic.com' || hostname.endsWith('.mzstatic.com');

/**
 * 只放行 Apple 的三个用途：试听音频（media）、封面图片（image），以及 iTunes Search API 的
 * JSON（xhr）。目录接口 api.music.apple.com 走 fetch，不需要这里重写响应头。
 */
function createAppleMediaPolicy() {
  return {
    allows(details) {
      if (!['media', 'xhr', 'image'].includes(details.resourceType)) return false;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(details.method)) return false;
      let url;
      try {
        url = new URL(details.url);
      } catch {
        return false;
      }
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (isAppleAudioHost(url.hostname)) {
        return details.resourceType === 'media' || details.resourceType === 'xhr'
          || /\.(m4a|aac|mp3|aacp)(?:$|\?)/i.test(url.pathname);
      }
      if (isAppleArtworkHost(url.hostname)) return details.resourceType === 'image' || details.resourceType === 'xhr';
      if (url.hostname === ITUNES_API_HOST && url.pathname.startsWith('/search')) return details.resourceType === 'xhr';
      return false;
    },
  };
}

module.exports = { createAppleMediaPolicy };
