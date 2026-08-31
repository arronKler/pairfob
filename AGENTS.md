# Pairfob agent notes

**产品、协议与规模以仓库里的代码和 `proto/` 为准。** 托管数据面是 `pairfob.v2`（Cloudflare Worker + 一 Durable Object / `daemon_id`，origin `https://pairfob.com`）。信封字节仍是 `pairfob.v1`：`proto/envelope.md`、`proto/rpc.schema.json`、`proto/pairfob-vectors.json`。不得改 HKDF info、AAD、Argon2id、DeviceHello transcript、内层 RPC 字段。v2 只增加 mux 控制面（见 `proto/envelope-v2.md`）；`pair_loc` 不进 SPAKE / Argon2。

```
phone PWA --HTTPS/WSS pairfob.v2--> pairfob.com (Worker+R2)
                                      Worker /v2/ws → DaemonRoom DO
pairfob --outbound WSS--> 该 DO --opaque FWD-- 同一 DO 上的 phone
pairfob --loopback--> HarnessRuntime
```

Relay / DO 只做帧级 relay，不解析 `FWD`。身份与密钥只在 daemon。读和写都要求 `Established` 会话。产品 relay 只有 `workers/pairfob-origin`（`pairfob.v2`）。`https://pairfob.com` 是本项目的官方实例。新电脑登记可关（`SIGNUP_OPEN` / `ENROLL_OPEN`），这是成本阀，已登记的电脑继续可用。用户文档不提供自建 origin。`internal/mux` Hub 仅作 daemon 进程内测试替身，不是可部署 origin。

## 文件规模（硬性）

**每个手写源文件最多 800 行。** 适用于 Go、TypeScript、CSS、测试文件与脚本。不含 `node_modules/`、`pwa/dist/`、生成物与依赖锁文件。

目的：项目结构清晰，模块拆分合理，逻辑易读易理解。

改代码时：

- 已超过 800 行的文件：先按职责拆开，再改行为。禁止继续往里堆。
- 将要超过 800 行：同一轮改动里拆出去，不要留下「先写完再拆」的巨型文件。
- 不要用「utils / helpers / misc / part2」这类垃圾桶文件凑行数。
- 不要靠删空行、挤注释、把无关逻辑塞进另一个已经很大的文件来规避上限。
- 测试与实现分开文件；一个测试文件只覆盖一个模块或一种行为族。
- 拆分后每个文件仍应能独立读懂：包注释或文件头只写非显然的边界，不写变更流水账。

按**职责**拆，不按行号切。优先边界：

| 层 | 拆什么 |
| --- | --- |
| `internal/daemon` | 会话握手、RPC 分发、具体 mutation（worktree / layout / keys / push）、持久化 |
| `internal/mux` | daemon 注册、配对绑定、session attach、FWD 转发 |
| `internal/runtime` | 传输/fault、snapshot 适配、各 Command 的 Herdr 调用 |
| `pwa/src/main.ts` | 启动/配对/SAS、dashboard、pane 会话、设置 |
| `pwa/src/lib/protocol` | 配对握手、会话 RPC、帧校验 |
| `pwa/src/style.css` | 按画面或控件族拆，用 CSS 源文件 import，不要复制选择器 |

当前没有超限文件。改动后用 `wc -l` 复查，超了先拆再继续。

`internal/runtime/herdr.go`、`internal/mux/hub.go`、`pwa/src/lib/protocol/client.ts`、`pwa/src/style.css` 已按职责拆完。Herdr 适配在 `herdr_observe.go` / `herdr_execute.go`，会话画面在 `pwa/src/ui/session/`，PWA 样式在 `pwa/src/styles/`。

同包多文件在 Go 里是正常做法。TypeScript 拆文件后从原模块再导出，避免扩散 import 翻新。

## 目录

| 路径 | 职责 |
| --- | --- |
| `cmd/pairfob` | 出站连 origin、配对 CLI、本机 Herdr |
| `workers/pairfob-origin` | 唯一 relay：Worker + R2 + DaemonRoom DO（线上与 `wrangler dev`） |
| `cmd/genvectors` | 从 Go 密码学实现生成 `proto/pairfob-vectors.json` |
| `internal/mux` | 帧级路由；不碰 FWD 明文 |
| `internal/daemon` | 配对、会话、RPC、推送、操作账本 |
| `internal/runtime` | Herdr 适配；Herdr 方法名不得穿过 `Runtime` 接口 |
| `internal/envelope` `aeadfwd` `canon` `hkdfk` `spake2plus` `session` | 协议原语 |
| `pwa/src/lib/protocol` | 浏览器侧协议 |
| `pwa/src/lib` | UI 纯函数与 DOM 辅助；`main.ts` 只编排 |
| `proto/` | 冻结的信封、RPC schema、向量、PGP words |
| `scripts/verify.sh` | 格式、vet、Go 测试（含 race）、PWA 测试、Worker origin 测试、typecheck、生产构建 |
| `scripts/install.sh` | 官网一键安装 pairfob（checksum、enroll、用户级服务） |
| `scripts/release.sh` | 交叉编译 `dist/dl/pairfob-{os}-{arch}` + SHA256SUMS |

新代码放到已有模块。只有现有包无法表达一个独立职责时才新增 `internal/<name>`。

## 实现约束

- 密码学与信封字节仍是 `pairfob.v1`（头 `version=0x01`）。mux 子协议只有 `pairfob.v2`。canonical 字节、Argon2id、SPAKE2+、HKDF info、DeviceHello 以 `proto/`（尤其 `pairfob-vectors.json`）与 Go/TS 实现为准；两端必须 bit-identical。mux JSON `"v":2` 见 `proto/envelope-v2.md`。禁止再实现 `/v1/ws` origin。
- 公网路径 default-deny。不要信任客户端声称的 `device_id`，也不要把 Herdr HTTP/Unix socket 暴露给 relay。
- mutation 带新鲜 `operation_id`，不自动重试；`unknown_outcome` 只刷新，不重放。
- `GetConfig.capabilities` 的十一键是展示与放行的权威；不要发明聚合别名。
- 路径与 cwd 必须落在 live snapshot 根或 `PAIRFOB_ALLOWED_ROOTS`；失败时 fail-closed。
- 产品循环不是终端模拟器：读已渲染 pane，把按键打回 PTY。

## 验证

改协议或跨语言原语后，先 `go run ./cmd/genvectors`（若向量会变），再：

```
(cd pwa && bun install)
./scripts/verify.sh
```

Go 必须 `gofmt`。PWA 用 bun。不要为了过测试放宽 schema 或把 fail-closed 改成猜测成功。
