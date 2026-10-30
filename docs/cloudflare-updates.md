# 域名更新与分发

## 来源和状态

客户端使用官网固定入口。
更换代码仓库不改变客户端地址。

- 更新清单：`https://xwxdeck.com/updates/stable/release.json`。
- 版本目录：`https://download.xwxdeck.com/releases/v版本号/`。
- 对象存储：现有 R2 存储桶 `xwx-deck-downloads`。

Pages 将清单请求重定向到 R2。
不新增域名解析，不在网页中保存发布凭据。
网站重新部署不会覆盖 R2 中的清单。

当前没有生产公钥，也未发布正式清单。
端点返回 404 时，客户端显示检查失败。
不能将其显示为已经是最新版。
本文记录目标流程，不代表线上更新已经验收。

## 签名和校验

清单使用 Ed25519 数字签名。
外层记录算法、密钥标识、载荷和签名。
载荷按原始 UTF-8 字节签名，再编码为 Base64。
客户端先验证签名，再解析更新信息。

`assets/update-trust.json` 仅保存公钥。
正式密钥生成和持久配置需要用户单独确认。
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

候选阶段使用 `--unsigned-preview`。
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

| 平台 | 当前安装方式 | 仍需实际验证 |
| --- | --- | --- |
| Windows 安装版 | Setup 替换和重启。 | 安装目录、文件占用、失败恢复和数据保留。 |
| Windows 便携版 | 更新进程替换原路径 EXE，再重启。 | 实际替换、启动失败和备份保留。 |
| Mac arm64、x64 | 下载 DMG，确认后手动替换。 | 两个架构的最终签名包和实际安装。 |

Mac 自动替换助手已有实现，但正式构建尚未启用。
启用前需核对签名身份、公证和原子替换。
不能以合成服务或单测代替真实安装结果。
验证使用独立目录，正常安装和用户数据保持原样。

本项目按新项目维护，不提供旧发行版本桥接。
历史报告保留原版本和来源，不作为当前包的验收证据。

## 参考

- [Cloudflare R2 自定义域名](https://developers.cloudflare.com/r2/buckets/public-buckets/)。
- [Cloudflare R2 上传对象](https://developers.cloudflare.com/r2/objects/upload-objects/)。
- [Tauri 更新签名说明](https://v2.tauri.app/plugin/updater/)。

本项目当前使用自有更新器。
Tauri 插件的格式和配置不能直接套用。
