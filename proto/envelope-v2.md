# pairfob.v2 mux 增量（冻结）

本文只冻结 **托管 mux 控制面**。二进制信封头、FWD AEAD、AAD、HKDF info、SPAKE2+ transcript、DeviceHello、内层 RPC 仍以 `envelope.md`、`rpc.schema.json`、`pairfob-vectors.json` 为准。

**不得**把 `pair_loc` 写入 SPAKE `idProver` / `idVerifier` / Argon2id salt。salt 仍是 `daemon_id` + `pair_ref_hex`。

## 子协议与路径

| | 历史 v1 origin（已移除） | 现行 origin |
| --- | --- | --- |
| WebSocket 子协议 | `pairfob.v1` | `pairfob.v2` |
| Upgrade | `/v1/ws` | `/v2/ws` |
| 信封 `version` 字节 | `0x01` | **`0x01`（不变）** |
| 控制 JSON `"v"` | `1` | `2` |
| 内层 RPC / DeviceHello `"v"` | `1` | **`1`（不变）** |
| Origin | Go `pairfob-relay` | Worker（`https://pairfob.com` 或本地 `wrangler dev`） |

现行 origin 对 `/v1/ws` 返回 **426**。没有 Go relay 进程。

## 二进制信封（与 v1 相同）

24 字节头：`version=0x01`、`typ`、`flags=0`、`length` uint32 BE ≤ 262144、`route_id` 16 字节。FWD payload = nonce(12) || ciphertext || tag(16)。AAD 仍 21 字节且 `ver=0x01 typ=0x05`。

`typ` 0x01–0x0F 与 v1 相同。无新信封 typ。rekey 走 HTTP `POST /v2/rekey`。

## HTTP

无 cookie。enroll / pair-intent / rekey / config：`Cache-Control: no-store`。

| 方法 | 路径 | Origin | 说明 |
| --- | --- | --- | --- |
| GET | `/` `/assets/*` `/sw.js` `/manifest.webmanifest` `/pair` | — | PWA；全套安全头 |
| GET | `/api/config` | — | `{protocol:2, build}` |
| GET | `/v2/health` | — | `{ok:true, protocol:2}` |
| POST | `/v2/enroll` | 必须空或非浏览器 | 客户端持久化的 `daemon_id` / `reconnect_token`（可选 `join_grant`）→ 校验并回显 |
| POST | `/v2/pair-intent` | **必须同源** | 计量 loc 查找；10 / 10 min / IP |
| POST | `/v2/rekey` | 必须空或非浏览器 | 旧 reconnect + 客户端持久化的新 token → 原子替换并回显 |
| GET | `/v2/ws` | 手机须同源；daemon 可空 Origin | Upgrade `pairfob.v2` |
| GET | `/v1/ws` | — | **426** |

IP 只信 `CF-Connecting-IP`。

### pair-intent

请求：

```json
{"v":2,"pair_loc":"WJ3K9M"}
```

`pair_loc`：6 字符 Crockford（字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`；规范化去空白、大写、`I/L→1`、`O→0`、`U→V`）。分片前缀 = **规范化后**前两字符。

Index miss、过期、unknown、以及 Room 当前槽与 loc **不符**：同一 HTTP **404**、同一时延、同一体：

```json
{"ok":false,"error":{"code":"unpaired"}}
```

成功 200：

```json
{"ok":true,"v":2,"daemon_id":"d_…","pair_ref":"<32 hex>","pair_ticket":"<32 hex>","expires_in":15}
```

`pair_ticket` 128-bit CSPRNG，小写 hex，**15 s**。只用于手输 PairingWS。

### enroll

产品路径不带 `join_grant`：Worker 为该次登记铸造内部 1 槽 grant（每 IP 有上限）。兼容路径仍接受 `join_grant`（`jg_` + 32 小写 hex）。`pairfob` 先生成并持久化 `daemon_id`（`d_` + 20 小写 hex，即 10 随机字节）与 `reconnect_token`（`rt_` + 32 小写 hex），再随 enroll 请求发送；成功响应必须原样回显。相同凭据在 D1 + Room 已登记时可幂等恢复，且不再次消耗 grant。D1 已有行而 Room 未写入时，持同一 `daemon_id` + `reconnect_token` 即可补完 Room。云上只存 reconnect 的 SHA-256。

rekey 请求含 `{v:2, daemon_id, reconnect_token, new_reconnect_token}`。Room 在当前 hash 等于旧值时原子替换；当前 hash 已等于新值时把同请求视为成功重放。响应必须回显新 token。

失败：`bad_grant` `grant_exhausted`。CAS：`UPDATE grants SET used = used + 1 WHERE grant_hash=? AND revoked_at IS NULL AND used < max_daemons`。Room 失败必须补偿 `used`。

kick 留行、`kicked_at`、`used--`。revoke 不踢已建立连接。

环境：禁止 `PAIRFOB_JOIN_TOKEN`。产品路径不需要 `PAIRFOB_JOIN_GRANT`；该变量只作兼容。

## WebSocket Upgrade 查询

| 角色 | 必带 | 禁止 |
| --- | --- | --- |
| daemon 新登记 | 无（先 HTTP enroll）HELLO 带 reconnect | — |
| daemon 重连 | HELLO reconnect | — |
| 手输 PairingWS | `role=client&pair_ticket=<32 hex>` | `pair_loc` 出现在 URL → **404 无 Upgrade** |
| 扫码 PairingWS | `role=client&daemon_id=&pair_ref=`（fragment 已在客户端剥掉码） | `pair_ticket` |
| SessionWS | `role=client&daemon_id=` | ticket / loc |

手输 ticket 在 **Upgrade 时原子 DELETE**；成功才 101。第二 Upgrade 同一 ticket → 不解 Upgrade 到房间（`unpaired`）。ATTACH 前断线：PWA 重新 pair-intent。扫码路径 **无** ticket；PAIR_ATTACH 只对照当前槽的 `pair_ref`。

Worker 必须在 `WebSocketPair` + `stub.fetch` 之前知道目标 DO。`acceptWebSocket` 只在 DO 内调用，禁止 `server.accept()`。

## 控制 JSON

HELLO_CLIENT：`{"v":2,"protocol":2}`。

HELLO_DAEMON 成功（每次，含重连）仍回显明文 `reconnect_token`：

```json
{"v":2,"op":"RegisterDaemon","ok":true,"daemon_id":"d_…","reconnect_token":"rt_…","relay_time":0}
```

PAIR_OPEN（daemon 不带 `pair_loc`）：

```json
{"v":2,"op":"CreatePairing","daemon_id":"d_…","pair_ref":"<32 hex>","ttl_s":180}
```

ack（Room 铸造 loc，**ack 之后** pairfob 才打印）：

```json
{"v":2,"op":"CreatePairing","ok":true,"pair_ref":"<32 hex>","pair_loc":"WJ3K9M","ttl_s":180}
```

失败：`index_unavailable`（槽不留下）。无 `pair_lookup`。

PAIR_ATTACH：`{"v":2,"pair_ref":"<32 hex>"}`。必须匹配 **当前** 槽的 ref **与** loc（手输经 ticket 已绑定房间）。过期 loc → `unpaired`。

PAIR_ATTACHED / SESSION_BOUND / SESSION_ESTABLISHED / DAEMON_REPLACED / ERROR：字段同 v1，外层 `"v":2`。

SESSION_* / FWD 语义同 v1：relay/DO 不解析 FWD；只认 daemon 的 `SESSION_ESTABLISHED`；Established ≤ 10；ResumeHello ≤ 2、15 s **软门**（CF alarm 最多约 1 分钟迟到；配额靠 LRU）；PING 不续期。DO **不** pin `device_id`。同设备 `kicked` 由 daemon 发 ERROR。

## 错误码

保留 v1：`unbound` `unpaired` `pair_busy` `pair_timeout` `pairing_expired` `pairing_replaced`（v2 **仅同房间**）`too_many_devices` `kicked` `daemon_offline` `rate_limited` `wrong_ws` `bad_token`。

新增：`locator_required` `bad_grant` `grant_exhausted` `enroll_required` `index_unavailable`。

## 心跳

v2 cut：**25 s** 信封 PING/PONG。DO 必须应用层 PONG。PING/PONG **零 SQLite、不 setAlarm**。`RecvWithin(60s)` 是客户端存活，不是房间 RIP。

## 安全头

与自托管相同：CSP（含 `wasm-unsafe-eval`）、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy: camera=(self), microphone=(), geolocation=()`。
