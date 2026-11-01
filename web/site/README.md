# 官网构建与部署

2026-11-01，点阵背景调整已部署到 `xwxdeck.com`，部署编号为 `1a7a6d56`。本次保留已有三个安装包的下载地址，仅更新官网资源和使用手册。应用内的重置、迁移确认与权限修复尚未进入新的安装包。下方发布准备说明保留原有制品范围。

官网源码用于介绍产品和演示界面。
演示复用 XwX Deck 前端。
品牌名只保留在顶部导航；首屏依次展示用途标题、一句说明和下载入口，点阵背景贯穿整页。点阵使用应用默认尺寸和透明度，不再叠加淡化。减少动态效果时保留静止画面。
标题为“更简单的 AI 管理工具”。说明为“交互体验更流畅、使用更方便的配置管理与日志查看工具。”
模型演示说明强调选好服务与模型后自动写入配置。下方功能文案强调配置集中保存、客户端分别选用和请求按需查看，不新增教学模块。
标题与其他官网文字共用 xVf 和 Noto Sans SC，按屏幕宽度缩放。
首屏默认使用居中布局。通过底部留白，让一般桌面视口仅露出约 24 px、手机视口约 12 px 的真实演示窗口上沿；短屏保留最小高度。切换栏靠近窗口，形成独立的一组。支持滚动动画且未启用减少动态效果时，窗口随进入视野从 72% 不透明度显现到完整显示；其他情况直接完整显示。
`?hero-layout=compact` 保留原居中比例，`?hero-layout=split` 保留左右分栏，`?hero-layout=brand` 保留顶部品牌强化预览。各版共用相同文案、点阵背景和真实演示，中间不重复放品牌名。
操作演示直接点击同一套前端中的服务、模型和日志控件，不绘制替代界面。
窗口上方是一行浏览与播放控件，只提供模型、Trace 和请求记录三个入口。
设置页保留在演示应用内，不单独占用官网切换栏。
窗口下方只显示一句说明，随当前操作或手动浏览的页面变化。
演示鼠标按真实控件位置移动、停留并显示点击反馈，坐标随 iframe 缩放换算。
用户接管、窗口尺寸改变或演示结束时移除鼠标；减少动态效果时省略移动和点击动画。
窗口进入视野时自动播放一次连贯操作：选择服务和模型，再从应用内打开一条请求。
用户交互、减少动态效果偏好和指定演示的链接均优先；停止后不自动重播。
账号、服务和额度使用合成示例。
仪表盘使用 `dashboard-examples.json` 中的真实请求脱敏记录。
当前示例为经用户授权的真实天气对话，已移除个人信息。
数据来自正式上游响应，保留实际用量、耗时和冻结参考费用。
参考费用不等于服务商账单。
界面使用当前版本前端和 Viewer。
演示不读取本机客户端配置或真实凭据。

## 构建与验证

新手引导可通过生成页面的 `app.html?tour=1&guide=installed&lang=zh-CN` 体验。
`guide=missing` 模拟未安装推荐客户端，`guide=import` 模拟检测到可导入配置。
`guide=single` 模拟仅安装 ChatGPT，`guide=enroll` 模拟已安装但尚未添加到 Deck。
这些场景复用调整后的真实引导组件，只使用内存中的安装与配置示例。
刷新后重新开始，不读取本机安装、文件或凭据，导入不自动切换服务。
当前候选按已有 AI 来源的定位修改引导：已有客户端不推荐另装，无导入任务时跳过该页，功能导览合为三步，完成后回到模型页。源码已调整，尚未打包或发布。

在仓库根目录执行以下命令。

```sh
npm run build:site
npm run test:site
```

浏览器测试复用已安装的 Playwright。
可通过 `XWX_PLAYWRIGHT_MODULE` 指定该模块。
`XWX_SITE_PREVIEW_DIR` 可指定待验证的预览目录。

生成文件统一放在 `test-results/site-preview`。
该目录不提交到 Git。
源码目录不保存生成的 JavaScript 或应用快照。
应用字体资源在 `assets/fonts` 中维护，采用 SIL Open Font License。
人工审核的脱敏请求数据随源码维护。
构建不会读取本机日志或账号文件。
日志首屏仅包含请求摘要。选中请求时，再读取按内容版本组织的完整脱敏记录。
日志查看器与应用共享字体文件，避免在 HTML 中重复嵌入字体。

## 仪表盘示例

`view.html` 展示纽约与上海天气对话中的 12 次真实请求。
`viewer.html` 保留为兼容入口。
页面注明采集日期，天气属于当时的查询结果。
身份、鉴权头、原始会话 ID、本机路径和不透明推理项均已移除。
公开问题、回复、联网查询、Token、耗时和参考费用按采集结果保留。
构建校验数据白名单与用量证据，拒绝私密字段。

## 下载与发布

本次版本为 `1.0.0`，范围为 Windows x64 安装版、便携版和 Apple Silicon Mac。
静态手动下载和稳定自动更新分两阶段开放。
本轮只准备本地构建与测试，没有上传制品或部署官网。
Windows 普通身份验收补齐前，不执行 R2 或 Pages 写入。

### 静态手动下载

源码与默认 `build:site` 的 `DOWNLOADS` 三项保持为空。
主按钮展开发布状态，三个入口均不提供下载链接。
显式选择静态模式时，构建从 `web/site/static-downloads.json` 注入下载配置。
该文件是版本、来源提交、三包大小、SHA-256 与来源指纹的唯一配置源。
构建复用 `tools/release/static-downloads.mjs` 校验配置，不另行填写下载地址。

```sh
npm run build:site
npm run test:site
npm run build:site -- --static-downloads
node tools/site/site-static-downloads-test.mjs
```

默认输出仍为 `test-results/site-preview`。
静态模式输出为 `test-results/site-static-downloads`，二者分开审核。
静态模式同时生成 JavaScript 配置和无脚本下载链接。
安装版、便携版与 Mac 分别显示 EXE、EXE 和 DMG。
下载菜单中的 `SHA-256` 链接指向同批总校验表。

静态预览需单独组装使用手册，再检查文档入口。

```sh
DOCS_BASE=/docs/ npm run docs:build
cp -R docs/.vitepress/dist test-results/site-static-downloads/docs
XWX_SITE_PREVIEW_DIR=test-results/site-static-downloads npm run test:docs
```

只复制到全新的 `docs` 目标，避免目录嵌套。

静态对象位于 `releases/v1.0.0/`，文件扩展名前追加完整的 64 位 SHA-256。
单文件校验对象为静态文件名加 `.sha256`。
总校验文件名为 `static-downloads-来源提交-checksums.txt`。
下载响应通过 `Content-Disposition` 提供原标准文件名。
具体 URL 均由配置校验模块生成，不手工复制哈希。

静态模式不会带出 stable 清单重定向及其专用缓存头。
它不上传或激活 `updates/stable/release.json`，也不占用标准包名或 `release.json`。
下载可用不表示自动更新渠道已经启用。
后续正式更新仍需独立准备签名清单并完成发布验收。

静态上传沿用已批准的 Wrangler 身份与既有存储桶。
写入前先核对全部目标是否不存在或字节完全一致；不同字节必须停止。
每次写入后，从公开地址读回并核对大小与完整哈希。
Wrangler 不提供条件写入，预检不能替代原子比较交换（CAS）。
同一批目标只允许一个发布任务写入，不覆盖已发现冲突的对象。
本地页面测试拦截下载到合成 fixture，不访问尚未上传的 URL。

本轮生产包仍来自 `870d6e0aacad72e572722022f111b8d78af8d13e`。
官网准备不改变这些包，不要求重建应用。

### 静态文件准备与上传

先把已签候选的三份制品及验收记录放在独立目录。
工具使用现有公钥验签，再核对版本、来源、大小和完整摘要。
静态目录与候选输入目录保持分离。

```sh
node tools/release/static-downloads.mjs --prepare --source=../validated-candidate --directory=../static-downloads
node tools/release/static-downloads.mjs --check --directory=../static-downloads --acceptance=../static-downloads/static-downloads-acceptance.pending.json
node tools/release/static-downloads-test.mjs
```

准备操作生成三份包、三份单文件校验和一份总校验表。
同目录的来源证明、计划和验收模板只供本地核对，不会上传。
重复准备会核对既有内容，不覆盖不同字节。

初始验收模板的 `passed` 和 `windowsNormalGui.passed` 均为 `false`。
完成普通 Windows 界面验收后，另存实际验收记录。
记录应包含本批三包摘要、来源指纹和该界面收据的 SHA-256。
禁止仅修改状态来代替实际验收。

产品所有者也可根据已有实测，明确调整该项验收范围。
此时保留 `status=waived`、`performed=false` 和 `passed=false`。
界面收据摘要保持为空，不生成未做过的收据。
另列 `releaseApproved`、功能证据、所有者决定和摘要绑定。
该决定只用于静态手动下载，不改变工具权限或其他完整性检查。
本次记录见 [手动下载验收](../../docs/maintenance/manual-download-acceptance-20261031.md)。

以下命令仅用于全部对应验收通过后。
`<已有 Wrangler 路径>` 应指向已核实的 `wrangler.js` 4.155.0。
当前尚未执行上传。

```sh
node tools/release/static-downloads.mjs --upload-static --directory=../static-downloads --acceptance=../static-downloads/static-downloads-acceptance.json --wrangler-cli="<已有 Wrangler 路径>" --single-writer
```

上传先完整读取所有既有对象，核对大小和摘要。
每次写入前再次核对，写入后重新下载验证。
相同字节会复用，不同字节会停止。
整个过程只使用静态内容名，不写标准更新对象。

本地锁只保护同一静态目录，不是远端锁。
执行者须确认没有其他发布进程。
中断后的日志若表示结果未知，远端仍不可见时会停止。
先核实原进程和 R2 实际结果，再处理本地恢复点。
工具没有强制覆盖或跳过验收开关。

本地回归接入 `npm run test:release-manifest`。
新增测试仅使用合成包、临时测试密钥和内存网络替身。
不会调用正式密钥、真实网络或上传服务。

### 稳定自动更新

以下标准路径留给后续稳定发布，不用于本次静态对象。
最终验收及公开读回通过后，才可生成生产 URL 的签名清单并激活 stable。
不得将 `candidates/` 清单或地址直接当作正式更新源。

最终包完成验收并上传后，核对以下不可变地址，再填写 `DOWNLOADS`。
目录中的版本标签带 `v` 前缀。

| 入口 | 后续稳定发布地址（保留，不表示已上传） |
| --- | --- |
| `windows` | `https://download.xwxdeck.com/releases/v1.0.0/XwX-Deck-windows-x64-setup.exe` |
| `portable` | `https://download.xwxdeck.com/releases/v1.0.0/XwX-Deck-windows-x64.exe` |
| `mac` | `https://download.xwxdeck.com/releases/v1.0.0/XwX-Deck-mac-arm64.dmg` |

三份文件分别核对最终字节数和 SHA-256。
验收结果绑定最终包、源码提交和签名清单，不复用旧包摘要。
`checksums.txt` 和各文件的 `.sha256` 必须来自同批最终包。
当前上传器仅处理包与签名清单，发布时还需单独核对校验文件的上传及公开响应。
版本清单使用 `releases/v1.0.0/release.json`。
稳定清单最后激活，不随官网构建自动更新。
网页上线前重新核对所有下载响应，不以网页更新表示软件已经发布。
GitHub 仅提供源码入口，不作为制品下载源。

现有生产站点由 Cloudflare Pages 托管。
已只读核实项目为 `xwx-deck-site`，生产分支为 `main`。
项目绑定 `xwxdeck.com` 和 `www.xwxdeck.com`。
该项目采用直接上传，没有连接 Git 自动发布。
仓库中的 `.github/workflows/pages.yml` 保留 GitHub Pages 构建与手动部署入口。
它不等于当前 Cloudflare Pages 的生产部署配置。
本地预览输出可作为审核目录。
对应阶段的验收和公开下载验证完成后，才可由发布协调者执行部署。
以下命令仅说明已核实的目标，本轮没有执行。

```sh
wrangler pages deploy test-results/site-preview --project-name xwx-deck-site --branch main
```

静态阶段审核和部署的目录为 `test-results/site-static-downloads`。
该目录不包含未来 stable 专属路由，不可与默认预览混用。

文档发布在站点的 `docs/` 目录。构建使用 Pages 提供的路径，支持独立域名和仓库子路径。
站点绑定 `xwxdeck.com`，Cloudflare 管理 DNS。
更新清单入口使用官网固定路径。安装包使用 R2 版本路径。发布过程见 [域名更新与分发](../../docs/cloudflare-updates.md)。
下载入口仅在首屏展示。
主按钮根据浏览器提供的系统和架构推荐已发布安装包。
无法确定架构时，点击后展开选择，不按 `MacIntel` 猜测芯片。
识别在本地进行，最多等待 600 毫秒，不新增网络请求。
用户开始操作后，迟到的识别结果不再更改按钮。
“其他版本”提供本次三种制品和 Mac 芯片查看提示。
可靠识别到 Intel 时说明本次不提供该安装包，不增加下载入口。
历史 Intel 构建能力和证据继续保留。
默认预览未启用 JavaScript 时，仍可展开列表查看未发布状态。
静态模式的 HTML 地址、文件格式和状态均由同一配置注入。
后续稳定阶段也需同步维护无脚本下载入口。
页尾提供 GitHub、QQ 群聊和 Discord 文字链接。
官网采用用户已确认的 xVf 和 Noto Sans SC 字体参数。
发布页面不包含本地调试面板。

## 网站语言

右上角的地球图标提供简体中文和 English。
首次访问按浏览器语言显示，手动选择优先并在本地保留。
存储不可用时，当前页面仍可切换语言。
页面文案、下载提示和内嵌演示随语言切换。
切换保留当前演示页签，真实对话正文保留原语言。
菜单支持方向键、Home、End 和 Esc。
文档入口继续打开现有中文手册。

## 文档阅读页

官网的“文档”直接打开 `/docs/` 的快速开始正文。
根入口和 `getting-started` 共用一份内容，不再展示介绍首页。
旧入口保留，快速开始只收录根入口。
网站只构建明确列出的使用手册章节，搜索使用相同范围。
开发说明、同步记录、历史审计与执行报告只在仓库中维护，不发布到网站。
文档分为开始使用、使用指南、进一步了解三个目录组。
文档主题复用应用的 Urbanist、Noto Sans SC 和 Geist Mono 本地字体。
官网继续使用独立的 xVf 字体，不以文档主题覆盖。
标题字重为 500，正文为 450，正文行高为 1.85。
表格使用独立滚动区域，窄屏不会撑宽整页。
Markdown 链接只为已发布页面或公开资源保留跳转；缺少目标的本地引用显示为普通文字。

文档与官网组装后，执行 `npm run test:docs`。

```sh
DOCS_BASE=/docs/ npm run docs:build
cp -R docs/.vitepress/dist test-results/site-preview/docs
npm run test:docs
```

在全新的官网构建目录中组装，避免重复复制产生嵌套目录。
该检查覆盖首页入口、目录、搜索、锚点、旧链接、表格与五档视口。
长表格使用仓库中的功能清单作为测试样本，不加入发布目录。
Pages 工作流在上传站点前执行此检查。

## 分享演示

`/?demo=dashboard#experience` 滚动到体验区并选中仪表盘。
`/?demo=models#experience` 直接选择模型管理。
刷新保留链接中的演示选择，未知参数沿用默认页签。

## 草稿归并验证

官网保留用户重构的居中、左右与品牌布局。
字体、胶囊按钮、播放图标和栅格对齐一并归并。
字体文件为 `web/site/fonts/xVf-Variable.woff2`，构建时复制到官网字体目录。
应用与文档继续使用各自字体。

自动演示操作真实前端控件。
日志详情按需加载，保留请求取消与错误处理。
引导保留欢迎标题、三步导览和空任务跳过。
检测未知时保留继续入口。

未验收的平台保持不可下载，不恢复旧版本产物链接。
本轮只生成本地预览，不代表已经部署。
