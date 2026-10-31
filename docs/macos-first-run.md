# macOS 安装

本次发行支持 Apple Silicon Mac。
首个正式版本 `1.0.0` 尚未发布，当前官网不提供正式下载。
以下步骤用于正式包发布后。

## 安装

1. 在 [官网下载入口](https://xwxdeck.com/#download) 获取 Apple Silicon DMG。
2. 打开 DMG，将 `XwX Deck.app` 拖入“应用程序”。
3. 从“应用程序”启动，完成首次设置。

在苹果菜单的“关于本机”中查看芯片。
Apple M 系列使用 Apple Silicon 包，本次不提供 Intel Mac 包。
安装包由官网通过 Cloudflare 分发，GitHub 仅用于公开源码。
正式包须完成 Developer ID 签名和 Apple 公证。
请核对官网下载来源和对应版本的 SHA-256 摘要。

## 更新

正式更新发布后，在应用设置中检查版本。
应用完成下载和校验后，按提示确认安装与重启。

如果仍有活动请求，先按提示等待或停止。
需要手动安装时，从官网重新获取正式 DMG。
停止 Trace 并退出旧应用，再拖入“应用程序”并选择替换。
从“应用程序”打开新版。
确认新版正常运行，再推出安装映像。

首次使用步骤见 [快速开始](getting-started.md)。
