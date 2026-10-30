# 本次发布的平台范围

用户于 2026 年 10 月 30 日确认本次只提供 Windows x64 和 Apple Silicon Mac。

| 平台 | 发行文件 |
| --- | --- |
| Windows x64 安装版 | `XwX-Deck-windows-x64-setup.exe` |
| Windows x64 便携版 | `XwX-Deck-windows-x64.exe` |
| Apple Silicon Mac | `XwX-Deck-mac-arm64.dmg` |

清单必须包含上述三个文件。
缺失、重复、错误架构和不匹配地址均须拒绝。
Node、Swift 签名入口和客户端候选校验执行同一范围。
签名、哈希、来源、正常启动和失败恢复要求保持不变。

本次不提供 Intel Mac、Windows ARM64 或 Linux 安装包。
官网不为 Intel Mac 推荐 Apple Silicon 文件。
未发布时，各下载项明确显示不可下载。
文件由官网和 Cloudflare R2 分发，GitHub 用于源码。

Intel 构建入口和底层架构能力保留。
原有测试与历史制品不删除。
将来恢复该平台时，须重新启用契约、构建、签名和更新验收。
历史 Intel CI 结果不能证明正式包已经签名或公证。

本次平台范围调整不等于发布批准。
当前 `productionReady` 仍为 `false`。
先完成剩余迁移证据，再生成默认功能的正常身份候选。
最终包还须完成安装、更新、数据保留和正式信任验证。
稳定清单在适用门禁通过后最后激活。
