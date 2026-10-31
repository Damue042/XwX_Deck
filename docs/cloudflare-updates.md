# 域名更新与分发

本次范围为 Windows x64 安装版、便携版和 Apple Silicon Mac。
旧的四制品流程完整保留在[历史归档](maintenance/archive/cloudflare-updates-before-three-artifacts-20261031.md)。
当前证据见[正式候选验收](maintenance/production-candidate-https-20261031.md)。

## 来源和状态

客户端使用官网固定入口。
更换代码仓库不改变客户端地址。

- 更新清单：`https://xwxdeck.com/updates/stable/release.json`。
- 版本目录：`https://download.xwxdeck.com/releases/v版本号/`。
- 对象存储：现有 R2 存储桶 `xwx-deck-downloads`。

Pages 将清单请求重定向到 R2。
不新增域名解析，不在网页中保存发布凭据。
网站重新部署不会覆盖 R2 中的清单。

当前已配置获准使用的 Ed25519 公钥。
本轮已上传隔离候选清单和严格三制品。
候选前缀为 `candidates/8db902ff6375cf8407a43bd0dedf17bcef533f75/`。
Mac 实际 HTTPS 更新和失败恢复已完成。
Windows Setup 和便携版的实际结果已由协调方回传。
三条分支的真实 HTTPS 更新核心链与受控恢复均已通过。
普通可视界面和托盘仍未通过。
本轮没有激活 stable，`productionReady=false`。
候选上传不表示正式版本已经发布。

更新端点返回 404 时，客户端显示检查失败。
不能将其显示为已经是最新版。

## 签名和校验

清单使用 Ed25519 数字签名。
外层记录算法、密钥标识、载荷和签名。
载荷按原始 UTF-8 字节签名，再编码为 Base64。
客户端先验证签名，再解析更新信息。

`assets/update-trust.json` 仅保存公钥。
本轮复用已有签名身份，不生成密钥或扩展读取权限。
未配置公钥时，正式签名清单会被拒绝。
测试仅使用进程内密钥，不保存测试私钥。

建议私钥离线备份，并限制发布端读取权限。
新增发布凭据时，仅授权指定存储桶。
公钥轮换需先发布同时信任新旧公钥的客户端。
随后切换签名端，最后移除旧公钥。

每个制品还必须通过大小和 SHA-256 校验。
Windows Setup 另行核对产品和安装范围。
Mac 正式包需要 Developer ID 签名和公证。
数字签名不能代替平台安装与数据保留验收。

## 发布顺序

1. 冻结源码提交，完成共享代码审计。
2. 分平台构建，并记录最终安装包哈希。
3. 完成下载、替换、重启、失败恢复和数据保留验收。
4. 生成签名清单和精确制品验收文件。
5. 上传不可变版本包，再从公开地址下载校验。
6. 保存版本清单，最后更新 stable 清单。
7. 通过官网入口复核签名和公开清单字节。

`release-acceptance.json` 记录版本、源码提交和制品结果。
顶层字段为 `passed`、`version`、`commit`、`files`。
每个文件记录 `name`、`sha256`、`passed`。
该文件必须来自实际验收，不能以构建成功代填。

Mac 手动发布可使用已批准的专用钥匙串条目。
`--keychain` 通过本地 Security API 完成签名。
私钥只在签名进程内存中使用，不导出到文件或命令参数。
系统可能要求确认本次读取，不能改为永久允许所有应用。
该命令不生成新密钥，也不搜索其他凭据。
使用以下命令准备正式清单，实际发布仍需全部验收通过：

```sh
node tools/release/write-release-manifest.mjs release-assets --keychain
```

候选预览可使用 `--unsigned-preview`。
该模式仅生成 `release-unsigned.json`，不能用于正式更新。

验收通过且发布凭据获准配置后，再执行上传：

```sh
npm run release:cloudflare -- release-assets --publish
```

上传器读取 `CLOUDFLARE_ACCOUNT_ID`、`R2_ACCESS_KEY_ID` 和 `R2_SECRET_ACCESS_KEY`。
缺少设置时停止，不创建或保存凭据。
相同版本的不同文件不得覆盖。
版本号不得回退，stable 写入使用条件更新。
上传或公开下载校验失败时，不切换 stable。
切换后复核失败时，需先检查实际状态，再决定下一步。

## 平台能力和验收边界

| 平台 | 当前安装方式 | 已验范围与剩余限制 |
| --- | --- | --- |
| Windows x64 安装版 | Setup 替换和重启。 | 真实注册安装、更新握手、故障恢复和数据回读通过；普通可视界面和托盘待验。 |
| Windows x64 便携版 | 更新进程替换原路径 EXE，再重启。 | 实际 HTTPS、替换、握手与受控恢复已回传；普通界面和托盘待验。 |
| Apple Silicon Mac（arm64） | 签名应用下载并校验 DMG，确认后替换重启。 | 本轮成功与故障恢复已通过；持久浏览器偏好未验。 |

普通签名构建已接入 Mac 自动替换助手。
未签名和临时签名应用继续使用手动 DMG。
开启自动更新后，夜间安装仍受空闲和安全退出条件限制。
接线不表示正式制品验收已通过。
最终需核对签名身份、公证和原子替换。
不能以合成服务或单测代替真实安装结果。
验证使用独立目录，正常安装和用户数据保持原样。

本项目按新项目维护，不提供旧发行版本桥接。
历史报告保留原版本和来源，不作为当前包的验收证据。

## 隔离候选分发

候选沿用同一 HTTPS 域名和已批准公钥。
它不增加产品更新频道。
候选清单记录完整提交、源码指纹和隔离标识。
三份制品仅使用 `candidates/完整提交/` 前缀。
候选使用显式候选签名参数。
stable 发布器拒绝这类清单。
普通客户端只有指定隔离数据根和匹配候选来源时才接受。

清单生成器的候选参数为 `--candidate` 和 `--source-fingerprint`。
正式签名同时要求 `--keychain`。
签名前核对三份本地制品及 `candidate-acceptance.json`。
该文件逐项记录摘要、大小、构建模式和验收结果。
制品不得带人工验收或更新验证 feature。
Mac 制品还需通过 Developer ID 和公证检查。
`--unsigned-preview` 只生成未签名草稿，不读取钥匙串。

`release:cloudflare:candidate` 默认只生成已校验的上传计划。
实际上传还需 `--upload-candidate`、已审查的清单 SHA 和现有 Wrangler CLI 路径。
它复用 Wrangler 4.155.0 的现有授权，不读取或新建 R2 令牌。
所有本地文件和远端冲突均在写入前检查。
只允许三份制品和候选 `release.json`，清单最后上传。
每次写入后重新下载并核对字节。
工具不读写 stable，不覆盖已发现内容不同的对象。
Wrangler 未提供条件写入参数，因此该检查不是原子比较交换。
同一候选前缀应由一个上传任务独占。

## 已签候选的保留要求

已上传候选 `release.json` 的 SHA-256 为：

`36cfac7e190e1a7342ad1204b66595db385b5e4fa214c262cb2a7828515034de`。

该清单仍包含历史更新说明。
其原文涉及已取消的 Intel 范围，不作为当前支持承诺。
本次文档修订不覆盖、重签或改写该清单。
后续正式发布使用活动 Changelog，并按批准范围生成新清单。
已有候选结果继续绑定原源码、清单和包哈希。

## 参考

- [Cloudflare R2 自定义域名](https://developers.cloudflare.com/r2/buckets/public-buckets/)。
- [Cloudflare R2 上传对象](https://developers.cloudflare.com/r2/objects/upload-objects/)。
- [Tauri 更新签名说明](https://v2.tauri.app/plugin/updater/)。

本项目当前使用自有更新器。
Tauri 插件的格式和配置不能直接套用。
