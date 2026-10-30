# 构建候选与发布门禁

GitHub 用于维护公开源码和代码审查。
公开制品通过 Cloudflare 分发。
首个正式版本为 `1.0.0`。

## 候选来源

每个候选记录提交、源码指纹和制品 SHA-256。
Windows、Apple Silicon 与 Intel 使用同一份公共源码。
各平台结果分别登记。
旧包结果不改绑到新候选。

候选构建使用对应平台的原生工具链。
构建成功不等于安装和更新通过。
调试程序不进入正式下载目录。

## 更新分发

官网为 <https://xwxdeck.com/>。
稳定清单为 <https://xwxdeck.com/updates/stable/release.json>。
安装包放入既有 R2 存储桶。
下载地址使用 `download.xwxdeck.com`。
每个版本使用独立路径。
不覆盖已发布的同版本制品。

本轮源码已采用固定域名及独立签名校验。
仓库原有 Release workflow 仍包含 GitHub 草稿上传步骤。
两处都必须在正式发布前调整并验证。
不通过旧标签流程发布本轮候选。

## 验收要求

Windows 分别验收安装版和便携版。
覆盖下载、校验、替换、重启和数据保留。
坏包、断流、签名错误及启动失败均需实测。
夜间更新还需核对空闲状态和安全停机。

Mac 分别验收两种架构。
正式制品完成 Developer ID 签名、公证和票据装订。
客户端使用已批准的发布公钥校验更新。
私钥保持在既有安全存储中。

最终从生产域名下载同一候选。
核对版本、架构、签名、大小和哈希。
完成跨平台验收后再更新稳定清单。
当前进度见 [Windows 更新验收](maintenance/windows-release-validation-20261030.md)。

## Mac 隔离验收

生产构建使用 `build:mac:arm64:production` 或 `build:mac:x64:production`。
这两个入口使用默认 Rust features，不启用人工验收功能。
未完成的 `productionReady` 门禁仍会阻止生产构建。

需要先核对生产代码时，使用对应架构的 `:candidate` 入口。
它从干净提交生成普通身份的签名候选。
候选不启用 `manual-acceptance` 或 `update-validation`。
构建报告记录 `production-candidate` 和实际请求的 features。
该模式不改变 readiness，也不执行安装或发布。
readiness 尚未通过时，只能用明确的隔离数据根启动候选。
普通用户目录的启动限制保留。

Mac 签名与恢复机制已在早期独立候选实测。
当前归并候选必须重新构建和验收。
旧包结论不改绑，详见 [签名更新隔离验收](mac-signed-update-validation.md)。
生产更新继续等待全部平台关口。
