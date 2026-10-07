# Apple Music 接入

Apple Music 使用独立的 `apple` provider。普通在线操作经过 Omni；请求边界在
`src/services/onlineMusic/appleMusicTransport.ts`，归一化在 `appleMusicNormalize.ts`。

## 先明确能力边界

Apple 官方接口对第三方客户端只开放 **30 秒试听**。完整曲目走 FairPlay DRM，音频流只在
Apple Music 自家的播放器内核里解密，任何第三方播放器（包括 Folia）都拿不到完整音频。所以
这个 provider 声明 `playback: true` + `previewPlayback: true`：

- `previewPlayback` 告诉界面与缓存层「拿到的是宣传片段，不是整曲」。完整曲目缓存不得把它当成
  整曲写入，界面也不能把它当成「这首歌能播」——`src/services/onlineMusic/songAvailability.ts` 的
  `isPreviewOnlySong` 读的就是归一化时写进 `sourceRef.providerData.previewOnly` 的标记，
  `playedTrackCache.ts` 据此跳过音频落盘（封面照常缓存）。
- 试听地址（`previewUrl`）在归一化时就存进 `sourceRef.providerData`，音频请求不必再打一次目录接口。
- 没有试听的曲目记为 `unavailable`，而不是给一个会失败的播放按钮。

歌词是另一条线：Apple 的 `/v1/catalog/{storefront}/songs/{id}/lyrics` 返回 TTML，逐行与逐音节
时间轴由 Apple 提供，Folia 用现成的 TTML 解析器读（`src/utils/lyrics/appleMusicLyrics.ts`）。
没有逐字时间轴的曲目按 `staticOnlyLyrics` 声明处理。

## 两层接入

| | 匿名层（无需配置） | 授权层（需要凭据） |
| --- | --- | --- |
| 接口 | iTunes Search API（`itunes.apple.com`） | Apple Music API（`api.music.apple.com/v1`） |
| 搜索 | 歌曲 / 专辑 / 歌手 | 歌曲 / 专辑 / 歌手、公开歌单 |
| 播放 | 30 秒试听 | 30 秒试听（同样不含整曲） |
| 歌词 | 无 | TTML 歌词 |
| 用户曲库 | 无 | 歌单、收藏专辑、已收藏歌曲 |
| 凭据 | 不需要 | developer token（+ 可选 Music-User-Token） |

选择哪一层由 `getAppleMusicTransportStatus().authorized` 决定，调用方不需要知道自己落在哪一层。
iTunes 匿名层与试听、封面域名都会在响应里带上 `Access-Control-Allow-Origin: *`，桌面端另有
`electron/apple/appleMediaCors.cjs` 与波点同样地重写 CORS 头，避免 CDN 或缓存层改掉它之后
封面取色与 Web Audio 分析失败。

## 凭据从哪来

Folia 不代签 JWT，也不做 OAuth 回调：那需要一个注册过的开发者域名与 Apple 的授权服务器，
第三方客户端无法在本地完成授权。用户自己在 Apple 侧准备好两样东西，粘进
「设置 > 集成 > Apple Music」，保存时 Folia 会真的打一次目录接口校验，校验失败会把旧配置放回去。

- **developer token**：在 Apple Developer 的 Keys 里创建一把启用了 MusicKit 的私钥，用它与
  Team ID、Key ID 签出 ES256 的 JWT（Apple 文档里的「Creating a developer token」）。有效期最长
  6 个月，过期后 Folia 会把账户标成需要重新配置，而不是假装还登录着。
- **Music-User-Token**：来自一次已授权的 Apple Music 会话（MusicKit JS 授权后得到的用户令牌，
  或从已登录的 Apple Music 网页会话里取）。没有它只能读公开目录。

## 店铺（storefront）

目录请求都带店铺代码（两位国家/地区）。**中国大陆（CN）店铺不通过这个接口返回任何条目**，
这不是「没搜到」：匿名层遇到 CN 会直接报 `region-restricted`，界面上也有对应提示。用不了官方
目录的用户应换一个店铺（us / jp / hk / tw / sg …），或配置凭据走官方接口。

## 登录流程

Apple Music 不是扫码登录。`capabilities.manualCredentials` 声明这件事，登录会话不会被启动
（`getCredentialFields` + `submitCredentials` 就是它的登录入口，没有 `getQrKey` / `createQr`）。

- 未配置凭据时 `auth.hasAccount()` 返回 false，账户摘要里 `requiresAccount` 随之为 false：
  匿名目录与试听照常可用，界面按「无账户来源」直接切换，不要求先登录，也不会去扫一个不存在的码。
- 配置凭据后 `getLoginStatus()` 用一次真实目录请求确认凭据仍然有效；失效时报 `auth-required`，
  界面显示为「需要重新配置」，而不是清掉配置假装从没配过。

## 未实现

- 收藏 / 取消收藏、歌单增删（`mutations: false`）。Apple 的「喜欢」要写用户资料库，语义与
  网易 / 酷狗的点赞不同，没有对应能力时宁可声明不支持，也不要给一个改不动的按钮。
- 每日推荐、私人电台（`recommendations: false`）：官方接口没有与网易日推等价的入口。
- 逐字歌词：Apple 的 TTML 里确实可能有音节时间轴，但按 `staticOnlyLyrics` 声明，界面不承诺。

## 验证

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run -c vitest.config.ts test/unit/onlineMusic/appleMusicProvider.test.ts
```

匿名层可以离线验证：搜索一首歌、看结果里的 `sourceRef.providerData.previewUrl` 能不能播。
官方层需要真实凭据与真实账号，由用户手动验收；账号、token、试听地址都不写入仓库。
