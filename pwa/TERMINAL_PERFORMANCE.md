# Terminal 性能基线

本页只覆盖完整终端（xterm）在移动端的可重复测量。它不改变 `pairfob.v1` 字节、内层 RPC 字段或服务端 sequence 合同。

## 可观测指标

完整终端每次挂载都会重置一组有界、无内容的采样：

- 生命周期：组件可用、bridge 打开、首个完整 frame 的耗时。
- 命令：排队/合并/发送/完成/失败数，queue wait、RPC RTT，以及 pending command/input 峰值。
- 输出：frame part/完整 frame 数、输入/渲染字节、frame assembly、xterm write drain，以及 pending write 峰值。
- 交互：输入或滚动命令到下一完整 frame、以及到该 frame 完成 xterm write 的 p50/p95。

采样只保存数值和命令类型，不保存终端输入、输出、RPC 参数或密钥。延迟窗口最多保留最近 128 个样本，同时保留全程 count/average/max。

“输入到下一 frame”是无内容的端到端体验代理指标：后台输出也可能成为下一 frame，因此它适合做同设备回归比较，不作为某个字符已经权威回显的证明。

在浏览器控制台打开本机调试输出：

```js
localStorage.setItem("pairfob:terminalPerf", "1");
location.reload();
```

终端退出、断线、关闭或命令失败时会输出快照。自动化也可以监听 `pairfob:terminal-perf` document event；事件的 `detail` 就是同一份快照。

控制模式的 PageUp/PageDown 另发出 `pairfob:pane-page-perf` 事件。每个样本包含点击到 mutation 开始、mutation RTT、ACK 到首次读取、点击到 hash 变化、确认读取次数和最终结果。它不包含 pane 内容、hash、RPC 参数或设备标识。首次读取紧跟 mutation 帧流水发送，因此 `ackToFirstReadMs` 可以为负数；daemon 按 session 串行执行两帧。翻页只发送一次 CSI mutation；若画面仍未变化，客户端以 80/160/320ms 间隔最多重试三次只读 `PaneRead`，并把普通 1.5s fallback 延后。

## 可重复基准

在 `pwa/` 下运行：

```sh
bun run perf:terminal
```

它包含两层：

1. `perf:terminal:command` 使用虚拟时钟，在 80/180/350ms RTT 下复现高频输入，比较命令泵与“一次输入一次 RPC”的串行完成时间，并检查 sequence 连续及 payload 上限。
2. `perf:terminal:browser` 先做生产构建，以 gzip 传输产物，再用全新 Chrome profile 测量 390×844、3x DPR、4x CPU、固定网络下的 xterm chunk 冷/热加载、组件打开、约 1MiB 输出排空、long task 和 heap 增量。热加载模拟 pane 空闲预加载后的模块缓存命中。

浏览器路径可通过 `PAIRFOB_CHROME` 指定。基准使用隔离页面测 renderer；真实配对、WSS、daemon 与 Android 前后台恢复仍需单独做真机验收。

首轮数据只作为 baseline，不直接设置跨机器的硬门槛。连续采集同一设备/Chrome 版本后，再按 p95 回归幅度建立 CI 或发布 guardrail。
