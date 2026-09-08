# React PWA 正式发布

2026-09-09：已完成构建、部署和线上回读，https://pairfob.com/pair 已提供 React + TypeScript + SCSS + Tailwind CSS 页面。

## 发布身份与范围

- BUILD：`2026-09-09.2`。
- Cloudflare Worker version：`09f5cac6-5c19-491e-b76e-7fb21f54fdcf`。
- 发布提交：`531d5bfad2f580ae8f641472b43d7b0cbfeabedf`；React 迁移提交：`fa2828d`。
- 独立分支：`release/pwa-react-20260909`；工作树：`/tmp/pairfob-react-ship-20260909`。
- 上线前发现当前生产已前进至 `be8b3cc` / BUILD `2026-09-09.1`，因此以该提交为发布基础，保留最新 daemon、安装脚本、文档和 Worker 实现。
- 保留既有 `v1.1.1` 四个平台下载包，没有运行 `release.sh`，没有升级本机运行中的 daemon。
- 没有新增 D1 迁移。远程 bindings 和 runtime 配置逐项比较，仅 BUILD 改变；`ENROLL_OPEN` / `SIGNUP_OPEN` 继续保持原有未配置状态。
- 发布源码已在独立分支提交，并快进合入 `main`。主工作区同步了 BUILD、四处文件末尾空行整理和发布文档；`design/` 与两份性能文档的本地删除保持未提交。

## 合入与构建验证

PWA 与已完成独立复审的候选没有语义差异。合入最新线上提交时，旧 `ui/daemon-update.ts` 的删除冲突按 React 替代实现解决；最新版本识别修复已在 React 组件和回归测试中保留。

| 检查 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 成功；发布依赖复制到隔离目录后再次检查，未改 lock |
| `./scripts/verify.sh` | 全流程退出 0 |
| Go | format、vet、普通测试、race、govulncheck 通过；无漏洞命中 |
| PWA | 1,326 pass / 0 fail，192 个文件，53.34 s |
| Worker | 86 个 source tests、5 个 harness tests、5 个真实 Wrangler runtime tests 通过 |
| 类型与构建 | PWA、Worker 类型检查，额外 `typecheck:qa`，PWA 和文档生产构建通过 |
| 文件约束 | 787 个手写源码/测试/脚本均不超过 800 行；diff whitespace 检查通过 |
| 发布包 | `PAIRFOB_PACK_DL=1 ./scripts/pack-origin-assets.sh` 通过，下载 checksum guard 通过 |
| 部署 | `wrangler deploy --dry-run --keep-vars` 和正式 `wrangler deploy --keep-vars` 均退出 0 |

最终隔离构建与上一轮已复审 PWA 产物逐字相同：

- `index-DOzHKj84.js`，871,038 B；SHA256 `03aef4c1f819f9833584ddfeedcdc54b5ed5a080d412dac1264c0b7c9b23854f`。
- `index-DHsBwTY1.css`，102,617 B；SHA256 `10b57c3c1a0d8f1eb3c557b0cf3274aaad4918cf27dff4f7889a9a1544949e20`。

## 线上验收

- 20 个公开路径通过：首页、PWA、文档、安装脚本、SW、manifest、config、health、未绑定 grants、全部 PWA chunks 和完整 `/dl/`。
- 静态响应与正式发布包字节匹配，包含四个平台二进制的完整下载与 SHA256 核对。manifest 由 Worker 按语言解析和重新序列化，因此按完整 JSON 字段及 MIME 验证，不要求格式空白相同。
- `/api/config` 和响应头回读 BUILD `2026-09-09.2`；`/v2/health` 返回 protocol 2 / ok；未绑定 `/v2/grants` 继续 fail closed。
- 已存在 SW 的浏览器通过正常重载加载 `index-DOzHKj84.js`，没有清理 SW 或修改生产缓存策略。
- 使用新的测试设备，完成正式 HTTPS/WSS 路由 → 浏览器配对证明 → 电脑确认 → 真实 daemon / Herdr 的已连接会话。
- 设置页正常显示，读取到本机实际 `v1.1.0`；刷新后保存的配对成功恢复。配对、设置和刷新记录的页面 error / unhandled rejection 均为空。
- 测试完成后，仅撤销新建的 Mac 测试设备，原有两个配对设备保留；本轮浏览器空间已关闭。

本轮没有执行生产会话里的终端命令或 daemon 更新。物理 iOS/Android、软键盘/IME、相机和真实手机性能仍需现场验收；桌面经生产公网的连接验证不替代这些项目。

## 证据

- 完整验证：`/tmp/pairfob-react-ship-verify-final.log`；QA 类型：`/tmp/pairfob-react-ship-qa-types.log`。
- 产物：`/tmp/pairfob-react-ship-artifacts.json`；下载清单：`/tmp/pairfob-react-ship-download-manifest.json`。
- 打包、预演、部署：`/tmp/pairfob-react-ship-pack-final.log`、`/tmp/pairfob-react-ship-dry-run.log`、`/tmp/pairfob-react-ship-deploy.log`。
- 线上回读：`/tmp/pairfob-react-ship-live/results.json`；远程配置比较：`/tmp/pairfob-react-ship-bindings-verification.json`。
- 真实浏览器：`/tmp/pairfob-react-ship-browser-paired.json`、`/tmp/pairfob-react-ship-browser-settings.json`、`/tmp/pairfob-react-ship-browser-resumed.json`。
- 合入复核：`/tmp/pairfob-react-ship-review.json`；清理：`/tmp/pairfob-react-ship-cleanup.json`。

此前独立审查、完整本地终端执行及缓存升级测试见 [上线前复审](pwa-react-release-review.md)。
