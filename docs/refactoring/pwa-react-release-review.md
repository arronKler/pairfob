# PWA React 上线前复审

日期：2026-09-09。结论：**本次 PWA 候选已通过本地发布前验收，独立复审无剩余 Required 项。**
该预验收结束时尚未提交或部署。后续已完成 [2026-09-09 正式发布](pwa-react-deployment-20260909.md)；下文保留当时的候选范围与验收记录。

## 验证范围

- 稳定候选：`/tmp/pairfob-react-preflight-20260908`。
- daemon、Worker、安装脚本使用 `224e9772553e4787bb12d8214b6e24936378445a`。
- PWA 使用本轮开始时的工作区快照，包括当时已有的 daemon-update UI/文案变更。
- 本轮审查的 10 个文件已同步回主工作区；475 个 PWA 源码、配置和 QA 文件逐字匹配候选。
- 主工作区另外进行的 daemon 安装、服务、更新相关改动没有混入本次验证。
- 原有 `design/`、两份性能文档的删除及其他未归属改动保持原样。

## 发现和修复

| 场景 | 修复后的行为 |
| --- | --- |
| 旧电脑的关闭操作返回时，新电脑正打开同 ID pane | 旧结果不清除新电脑的选择、草稿或页面 |
| 确认框/表单打开后切换电脑或离开原视图 | 提交前重新检查 session、daemon、视图归属，失效操作不发送 |
| 新建表单打开后 capability 被撤回 | 提交时重新检查对应 capability |
| guided SendText 等待期间切换视图，新草稿恰好相同 | 旧成功回包不清除新草稿；失败和提示也遵循归属 |
| 新建 pane 后等待旧完整终端关闭，此时用户又导航 | 显式导航和终端退出凭据保护跳转，较新的导航获胜；不预测 incarnation 的增量 |
| 旧聊天请求完成时，新操作正在等待 | 不释放新操作的 busy 锁，不清除新操作的提示 |

上述检查包含旧版已有问题。保留了 21 项新增回归测试，覆盖正常成功、取消、延迟成功/失败、
同 ID 不同电脑、视图重入、较晚导航、跨聊天/控制模式的锁和提示归属。
`unknown_outcome` 继续只刷新状态，不自动重放 mutation。协议和密码学字节没有改动。

另外删除了 Brand/SetHeading 的 6 条重复 SCSS 声明，让实际使用的 Tailwind utilities 承担相应样式。
独立编译 CSS 检查确认其他共同规则顺序保持；浏览器的尺寸及 display/align/gap/flex 与去重前一致。
SetHeading 定点截图像素一致；Brand 的动画/栅格颜色差异未计为零像素结果。

## 最终自动检查

| 检查 | 结果 |
| --- | --- |
| 独立目录 `bun install --frozen-lockfile` | 111 个包安装成功，候选使用这份安装构建 |
| `./scripts/verify.sh` | 全流程退出 0 |
| PWA | **1,326 pass / 0 fail，192 个文件，49.53 s** |
| Go | 格式、vet、测试、race 全部通过；govulncheck 无命中 |
| Worker | 86 个 source tests、5 个 harness tests、5 个 Wrangler runtime tests 全部通过 |
| 类型检查 | PWA、Worker、额外 `typecheck:qa` 均通过 |
| 旧构建到新构建的 SW/交付执行探针 | 10 pass / 75 assertions，最终产物再次通过 |
| 独立修复复审 | 113 项相关测试及 8 个独立探针通过，无 Required、无 React act/unhandled warnings |
| 依赖检查 | audit 无已知漏洞命中；21 个直接依赖的版本、lock、registry integrity、engines、必要 peers 一致 |
| 仓库约束 | diff whitespace 检查通过；手写 PWA 文件不超过 800 行 |

不同测试组有重叠，不将上表数字相加为独立覆盖量。
QA 升级探针是本次两份实际构建之间的验收工具，保存在隔离候选的 `pwa/test-support/service-worker-upgrade.review.test.ts`；
它依赖 `/tmp/pairfob-react-baseline-224e977/pwa/dist`，没有混入主工作区的常规测试。

## 真实浏览器与运行时

使用独立 loopback Worker、独立 Pairfob 状态目录和独立 Herdr socket/workspace，未操作用户日常 Herdr 会话。
Herdr 为实际安装的 0.8.2 / protocol 20，非 Fake Runtime；配对经过浏览器和电脑确认。

- 真实 Worker → 配对握手 → 电脑确认 → Established 会话 → 真实 Herdr → xterm/WebGL。
- 页面发送测试命令，宿主文件只出现一条标记；PWA WorkspaceRead 再读到相同内容。
- 刷新后从保存的配对恢复；断网/联网后恢复，原命令没有重复执行。
- guided 视图实际显示 `seq 1 200` 的输出，连续输入保留同一个输入节点和完整草稿。
- 最终构建 `index-DOzHKj84.js` 重新加载后，真实新建 `w1:p2` / `react-preflight` 标签页并进入新终端。
- 最终构建在新 pane 执行一次标记命令，并完成宿主和 PWA 文件双回读；随后通过页面关闭测试 pane。
- 最终浏览器上述流程记录的 runtime errors 为空。

独立浏览器还运行了旧版 → React 升级、停服务后 SW 返回缓存 HTML/JS/CSS，以及恢复服务后刷新。
旧/新 xterm JS、xterm CSS、扫码 worker 三个 lazy 资源逐字相同，SW 也没有变更。
该独立 SW 浏览器组的网络失败注入未改变 `navigator.onLine`，因此不把它作为原生 offline 事件证明；
主流程另行记录了 `navigator.onLine=false` 和应用离线提示。

## 最终发布包

- JS：`index-DOzHKj84.js`，871,038 B；Vite 报告 gzip 约 283.56 kB。
- CSS：`index-DHsBwTY1.css`，102,617 B。
- JS SHA256：`03aef4c1f819f9833584ddfeedcdc54b5ed5a080d412dac1264c0b7c9b23854f`。
- CSS SHA256：`10b57c3c1a0d8f1eb3c557b0cf3274aaad4918cf27dff4f7889a9a1544949e20`。
- `PAIRFOB_PACK_DL=1 ./scripts/pack-origin-assets.sh` 通过，保留既有 `v1.1.0` 四个平台二进制，checksum guard 通过。
- `bunx wrangler deploy --dry-run --keep-vars --config wrangler.jsonc` 退出 0。
- 从最终完整包重新启动本地 Worker 后，10 个首页/PWA/docs/安装/下载/JS/CSS 路径回读成功；应当匹配的响应与磁盘字节一致。

实际部署时需要从明确的发布提交更新 `vars.BUILD`，再次保留当时应发布的 `/dl/`，使用 `--keep-vars`，
并回读线上 BUILD、真实加载模块和下载校验值。本轮没有执行远程部署、D1 迁移或 daemon 升级。
不能直接把主工作区另外进行的 daemon 改动一同算作已验证发布内容。

## 仍需区分的边界

- 本轮是真实桌面 Chromium 和 loopback 端到端验证，不等于物理手机、相机、软键盘/IME、后台恢复或 WAN 验收。
- 首入口较旧版增加约 68 kB gzip，Vite 500 kB 提示阈值未放宽。没有新的手机性能达标结论。
- 连续输入的功能和节点保持已检查；rAF 采样未形成足以归因 React 主线程耗时的稳定测量，不报告延迟预算通过。
- SW 原有 activate 会清除通知语言 cache；本次 SW 字节未变，不会新增这次激活。未来改 SW 时应单独修复并验证语言保持。
- 上一轮的 148 个像素相同场景及 112 个 fixture smoke 属于原迁移记录，见 `pwa-react-progress.md`；本轮没有重新计数。

## 证据位置

- 全套：`/tmp/pairfob-react-preflight-verify-final-r2.log`。
- 独立修复复审：`/tmp/pairfob-react-preflight-owner-fix-review.md`。
- 依赖/样式：`/tmp/pairfob-react-preflight-dependencies-review.md`。
- 升级/缓存：`/tmp/pairfob-react-preflight-upgrade-review.md`。
- 实际配对/恢复：`/tmp/pairfob-react-preflight-browser-live.json`。
- 最终浏览器：`/tmp/pairfob-react-preflight-browser-final.json`。
- 最终 HTTP：`/tmp/pairfob-react-preflight-packed-http-final.json`。
- 打包/预演：`/tmp/pairfob-react-preflight-release-pack-final.log`、`/tmp/pairfob-react-preflight-wrangler-dry-run-final.log`。
- 产物/hash：`/tmp/pairfob-react-preflight-artifacts-final.json`、`/tmp/pairfob-react-preflight-final-owned-hashes.json`。
- 主工作区同步：`/tmp/pairfob-react-preflight-root-sync.json`。
- 清理：`/tmp/pairfob-react-preflight-cleanup.json`。测试配对已移除，独立浏览器空间、Worker、daemon、Herdr 均已关闭。
