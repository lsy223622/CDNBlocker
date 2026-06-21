# CDNBlocker

一个用于 Bilibili 普通视频页的 Tampermonkey 用户脚本。它可以屏蔽指定 CDN
主机，也可以一键禁用所有 `*.mcdn.bilivideo.cn` PCDN 节点，让播放器使用其他
候选 CDN。

## 安装

1. 安装 Tampermonkey。
2. 打开 Tampermonkey 管理面板，选择“添加新脚本”。
3. 将 [`CDNBlocker.user.js`](./CDNBlocker.user.js) 的完整内容粘贴进去并保存。
4. 重新打开或刷新视频页面。

脚本使用 `@run-at document-start`，安装或更新后必须刷新页面，网络拦截才能在
播放器初始化前生效。

## 使用

### 从统计信息面板屏蔽当前 CDN

在播放器画面上右键，打开播放器自带的“统计信息”。脚本会在 `Video Host` 和
`Audio Host` 右侧各添加一个“屏蔽”按钮。

普通 CDN 右侧显示“屏蔽”。如果当前地址属于 `*.mcdn.bilivideo.cn`，按钮会改为
“屏蔽所有 MCDN”，点击效果与管理窗口中勾选“禁用所有 mcdn 节点”相同。

点击按钮后，脚本会：

1. 将当前 hostname 加入精确屏蔽列表；
2. 保存当前播放时间和播放/暂停状态；
3. 刷新页面，让播放器重新选择 CDN；
4. 恢复播放位置，刷新前正在播放时会尝试继续播放。

规则只匹配 hostname，协议和端口会被忽略。例如面板中的
`xy1.example.com:8082` 会保存为 `xy1.example.com`。

### 管理规则

点击浏览器工具栏中的 Tampermonkey 图标，选择“管理 CDN 屏蔽列表”。管理窗口
支持：

- 开关“禁用所有 mcdn 节点”；
- 输入 hostname、带端口的 host 或完整 URL 添加规则；
- 删除单条规则；
- 清空精确 Host 列表；
- 保存并刷新页面应用修改。

“禁用所有 mcdn 节点”严格匹配 `mcdn.bilivideo.cn` 及其子域，不会匹配名称中
仅仅包含 `mcdn.bilivideo.cn` 字样的其他域名。

## 工作原理

Bilibili DASH 播放器会为同一音视频轨道维护多个候选地址，并在请求失败后尝试
其他地址。PCDN SDK 可能通过独立 Loader 或 Worker 绕过页面请求函数，因此只要
存在任意屏蔽规则，脚本还会禁用当前页面的 P2P/PCDN Loader 选择，使媒体请求
回到播放器的普通 HTTP 候选列表。随后脚本在页面脚本环境中包装
`XMLHttpRequest.open` 和 `fetch`：

- 命中规则的 XHR 会被改写到保留的 `.invalid` 域名，产生正常网络失败；
- 命中规则的 Fetch 会以网络错误拒绝；
- 未命中的请求完全交给原生实现。

播放器收到失败后会使用其原有回退机制选择下一个候选 CDN。脚本不修改视频
数据、登录状态、弹幕或字幕接口。

如果统计面板仍显示一个已经命中规则的 Host，按钮会明确显示“屏蔽未生效”或
“MCDN 屏蔽未生效”，而不是把规则存在误报为拦截成功。

## 范围与限制

- Tampermonkey 是主要支持目标；Violentmonkey 仅作尽力兼容。
- 如果浏览器阻止自动播放，刷新恢复时间后会保持暂停，需要手动点击播放。
- Bilibili 更新播放器 DOM 或网络实现后，统计面板按钮或请求拦截可能需要同步更新。

## 许可证

[GPL-3.0-or-later](./LICENSE)
