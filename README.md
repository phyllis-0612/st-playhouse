# 梨园·PlayHouse v0.2

署名：克克姐&奶盖&鱼仔

SillyTavern 正文分轨朗读扩展。AI 消息生成结束后，本地先按引号和动作标记切分原文，再让便宜的 OpenAI 兼容模型只标注「旁白 / 角色 / 情绪 / 语速」，最后按角色分别调用 MiniMax 合成并顺序播放。

## 安装

把整个 `st-playhouse` 目录放入：

```text
SillyTavern/public/scripts/extensions/third-party/st-playhouse/
```

刷新酒馆。在扩展抽屉或魔法棒菜单打开「梨园·PlayHouse」。

## 初次配置

1. 设置 → 朗读：确认正文标签，点击保存。默认只读取 `<content>…</content>`；可用逗号填写多个自定义候选标签。
2. 设置 → 分轨模型：填写 OpenAI 兼容 Base URL、API Key，点击「拉取模型」后从下拉框选择并保存。也可选择「手动填写」。
3. 设置 → 语音服务：填写 MiniMax Base URL 和 API Key，然后保存。现行 MiniMax 接口可不填 GroupId；旧中转要求时再填。
4. 音色 → 音色库：手填官方/已有 `voice_id`，或直接上传录音克隆新音色。
5. 选择全局旁白、兜底音色，并配置自动分组池。
6. 给当前角色卡绑定主角、旁白和常驻配角音色。

## 音色克隆

1. 先在「设置 → 语音服务」保存 MiniMax API Key。
2. 在「音色 → 克隆新音色」选择 mp3、m4a 或 wav：时长 10 秒–5 分钟，大小不超过 20 MB。
3. 自定义 Voice ID：8–256 位，必须以英文字母开头，可含字母、数字、`-`、`_`，结尾不能是 `-` 或 `_`。
4. 确认已获得声音本人许可，再点击「上传并克隆」。成功后自动加入音色库。
5. 建议保留「创建后立即合成一句以激活」。这会产生一次很短的 TTS 费用；克隆后 7 天内没有正式用于 TTS 的音色会被 MiniMax 删除。

MiniMax 中国区的声音复刻要求账号完成个人或企业认证。克隆录音直接发送给用户自己配置的 MiniMax 接口，不经过梨园作者服务器。

## 正文标签安全边界

梨园只会把设置中指定标签以内的文本送给分轨模型和 MiniMax。默认标签名为 `content`，支持 `<content 属性="值">…</content>`、同名标签在一条消息中出现多次，以及用逗号配置多个候选标签。候选标签全部找不到或内容为空时，梨园会停止并提示，不会回退读取整条消息，避免把 COT、状态栏和摘要发送出去。

## 已验证的直连架构

- 分轨中转 `https://gcli.ggchan.dev/`：HTTPS、浏览器 CORS 预检与实际请求均通过；`gemini-2.5-flash-lite` 已从梨园设置面板真实返回分轨结果。该中转不接受 `max_tokens`，默认留空即可。
- MiniMax 中国区 `https://api.minimaxi.com/v1/t2a_v2`：HTTPS，CORS 允许浏览器携带 `Authorization` 与 `Content-Type`；无需额外 SillyTavern 后端转发。现行接口的 `GroupId` 可留空。
- MiniMax 中国区音色克隆 `/v1/files/upload` 与 `/v1/voice_clone`：HTTPS，浏览器 CORS 预检允许 `POST`、`Authorization` 与 `Content-Type`，可直接从梨园上传并复刻。

## emotion 枚举

当前限定为：`happy`、`sad`、`angry`、`fearful`、`disgusted`、`surprised`、`calm`、`whipser`。最后一个拼写来自 MiniMax 官方接口枚举，保持原样；分轨模型返回其它值时按 `calm` 处理。`fluent` 只适用于部分新模型，当前为兼容默认的 `speech-02-hd` 暂不开放。

## iOS / Safari

- 梨园只创建一个全局 `AudioContext`，使用 `AudioBufferSourceNode` 连播；不会逐段替换 `<audio src>`。
- 第一次使用时必须在用户手势同步调用栈中解锁声音。若自动朗读时尚未解锁，播放条会提示点击。
- 切后台、锁屏、来电后 `AudioContext` 可能变为 suspended；回到页面后点击继续。
- 如果进度正常但没有声音，请检查硬件静音键。网页无法检测静音键状态。
- 内存中最多保留当前及后两段的解码缓冲；播完立即释放。

## 缓存

音频以 segment 为粒度存入 IndexedDB，key 由正文、voice_id、语速、情绪和模型计算。超过容量按 LRU 淘汰。IndexedDB 不可用时自动降级为无缓存，不影响朗读。

iOS Safari、无痕模式或长期不访问站点可能清理缓存，这是浏览器限制，不是配置丢失。音色库和角色绑定保存在 SillyTavern 的扩展设置中。

## 配置分享

导出功能会把所有分轨 API Key 和 MiniMax API Key 清空。导入时合并而非覆盖，音色库按 `voice_id` 去重。

## 已知限制

- iOS 锁屏或切后台后播放可能暂停，无稳定锁屏控制。
- 无法检测 iPhone/iPad 的硬件静音键状态。
- 当前不包含整章预生成、合并导出单文件、用户消息朗读，也不提供 MiniMax 账号内音色删除功能。
