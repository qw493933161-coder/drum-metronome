# 鼓手节拍器（PWA）

离线可用的架子鼓练习 App，手机、平板装到主屏幕使用。

线上地址：https://qw493933161-coder.github.io/drum-metronome/

## 功能

- 节拍器：每小节拍数、每拍细分、每拍单独设节奏型（音符图标）
- 基础节奏：常用鼓组节奏，五线谱鼓谱 + 跟随光标
- 鼓垫练习：手序基本功（R/L、重音）
- 变速练习：拼时值成一页谱、数字记谱、随机出题、保存/导入/导出，每遍之间的预备拍
- 曲谱：打开 Guitar Pro / MusicXML 谱（alphaTab），跟随播放、按小节循环、全屏看谱
- 练习辅助：渐进加速、随机静音小节
- 开始前倒计时、声画同步校准、音量、横屏
- 云同步：设置、练习谱、曲谱文件存到自己 GitHub 账号的秘密 Gist（令牌只存在本机）；新设备扫码加入

## 开发

- 无构建步骤，纯静态文件；本地预览：`node scripts/serve.js`，打开 http://localhost:5173
- 改了任何预缓存文件都要改 `service-worker.js` 里的 `CACHE_NAME`
- `vendor/alphatab/` 是 alphaTab 1.8.4（MPL-2.0），字体 Bravura（OFL），音色 Sonivox（Apache-2.0）；`vendor/qrcode/` 是 qrcode-generator 2.0.4（MIT），用于扫码配对
- 版权歌曲的谱文件不要放进这个公开仓库
