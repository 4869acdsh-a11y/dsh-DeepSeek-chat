# 变更记录（CHANGELOG）

> **关于版本号**：本包自即日起版本号定为 **v1.0.0**，作为首个正式版发布。
> 下面 v1.7.1 及更早的 `v1.x.0` 是开发期的内部迭代号，保留原样仅作历史留档，
> 不表示存在过 v1.1 ~ v1.7 的正式发布。两套编号的对应关系是：
> v1.0.0 = v1.7.1 的代码（v1.7.1 本身相对 v1.7.0 只有文档与注释改动，无功能变化）。

## v1.0.0 — 2026-09-29（首个正式版）

### 命名统一：`web` → `chat`

包名从 `dsh-deepseek-web` 改为 **`dsh-deepseek-chat`**，界面文案从「DeepSeekchat」
改为 **「DeepSeek chat」**。同步替换的还有：

| 位置 | 旧 | 新 |
|---|---|---|
| `package.json` 的 `name` | `dsh-deepseek-web` | `dsh-deepseek-chat` |
| `cordis.patch.yml` 的 `id` / `name` | `dsh-deepseek-web` | `dsh-deepseek-chat` |
| 宿主 `BASE` 路由前缀 | `/dsh-deepseek-web/*` | `/dsh-deepseek-chat/*` |
| 三个 slot 的 `id` | `dsh-deepseek-web-panel` 等 | `dsh-deepseek-chat-panel` 等 |
| 菜单项 `label` / toast 文案 | `DeepSeekchat` | `DeepSeek chat` |
| 专用浏览器 profile 目录 | `<Home>\deepseek-web-profile` | `<Home>\deepseek-chat-profile` |
| 安装/卸载脚本里的包名常量、文件头 | `dsh-deepseek-web` | `dsh-deepseek-chat` |

> ⚠️ **升级注意**：包名变了，**必须先跑 `uninstall.ps1` 把旧的 `dsh-deepseek-web` 摘干净，
> 再跑新的 `install.ps1`**，否则 `dsh.profile.bundles` 里会同时留着旧包名（指向已失效的联接）
> 而新包名又没登记，插件不会被加载。另外 profile 目录换了名字，
> **旧目录里的登录态不会自动迁移** —— 想保留登录就在首次启动新窗口前手动改个名：
>
> ```powershell
> Rename-Item D:\dshl\deepseek-web-profile deepseek-chat-profile
> ```
>
> 不改也行，代价只是在新窗口里重新登录一次 DeepSeek。

### 文档修订（README 全文对齐当前实现）

- **开篇界面描述换掉**：删掉"在侧边栏顶部品牌行注入下拉切换器"和那张下拉菜单示意图，
  改成左侧面板列表里的原生菜单项 **DeepSeek chat**。
  同时删除已不存在的"选 DSH 默认模式 / 选 DeepSeek chat"两个选项、"打勾状态""`localStorage` 记忆"等描述。
  实测当前代码里没有 `localStorage` 读写，也没有"DSH 默认模式"这个词。
- **点击反馈文案对齐源码**：改成 `正在打开 DeepSeek chat 窗口…` →
  `DeepSeek chat 窗口已就绪（over-dsh / center / focused）`，失败为 `打开失败：<原因>`。
  括号里是宿主返回的落点：`over-dsh` / `center` = 新开窗口的定位方式，`focused` = 窗口本来就在、只是切回前台。
- **第四节「使用」表重写**：删掉"点品牌行右边的 ▾""点菜单外面 / 按 Esc 关闭菜单"等已不存在的交互，
  补上"打开失败"这一行。
- **排障一节按新 slot 重写**：诊断表的 `diag` 关键字换成
  `左侧菜单项注入已提交` / `已注册左侧菜单项 DeepSeek chat（第 N 次尝试成功）` /
  `菜单项自检: 已出现在侧边栏 ✓` / `glyph-bound` / `click-fired` / `panellist-register-failed`；
  删掉 `sidebar.brand.name` 那套 priority -1000 抢位的说明（该 slot 已不再使用），
  改成 `sidebar.panellist` 的两个真实坑（list slot 必须带 `id`、注册时机要退避重试）。
- **附录标题加历史存档标注**：鲸鱼 Logo 那一节明确写上"只对 v1.6.0 及以前的代码有意义"，
  并说明 v1.7.0 起图标是自绘的「对话气泡 + 折线」轮廓（`DeepSeekChatIcon`）。
- **目录结构、自检 JSON 示例、C.4 验证清单**按当前 10 个文件 / 当前 `registered` 数组更新。
- 修正过时表述：桌面发布包名、`reattach` 接口补上"v1.7.0 起界面上没有入口"。

### 功能改动

**无。** `client.js` / `index.js` 相对 v1.7.0 逻辑一行未动 —— 除上表列出的字符串替换外，
只改了两个文件头注释（原文还在讲"侧边栏品牌行下拉切换器"）。

> 说明：v1.7.0 当时的 README 与 `client.js` 头部注释都还停留在旧版界面描述，
> 属于文档滞后于代码，不是行为回归。

---

## v1.7.1 — 2026-09-29（开发期内部迭代号，已并入 v1.0.0）

见上文 v1.0.0 条目，内容与之一致。

---

## v1.7.0 — 2026-09-27（当天第二版）

### ⚠️ 界面变化：顶部下拉按钮 → 左侧原生菜单项

- **删除**：旧的「顶部品牌行下拉切换器」及其全部代码（`BrandSwitcher` 组件、`sidebar.brand.name` 注册块、优先级阶梯）。
  **原因**：该 slot 位于官方「新建会话」按钮的子树里，桌面壳会把该子树的插件节点隐藏 ——
  实测元素在 DOM 中、尺寸 0×0、`display:none`，且**内联样式 + !important 都压不过**，属于结构性不可用。
- **新增**：注册进 `sidebar.panellist`（`kind:"list"`）—— 即左侧「扩展管理 / 定时任务 / IM」那一列。
  条目选项 `{ id: 'dsh-deepseek-chat-panel', order: 40, label: 'DeepSeek chat' }`，图标为自绘 SVG。
- **点击行为**：点击菜单项打开独立 DeepSeek 窗口（复用既有 `openWeb()`：Tauri 优先 → 宿主 `/open` 回退），
  并弹提示反馈。**未接入右侧内嵌面板**（那需要 `ctx.sidebarRightTabs`，属后续项）。

### 实现过程中踩到并修掉的两个坑（留档）

1. **注册时机**：`ctx.slots.inject('sidebar', …)` 回调触发时，子表 `sidebar.panellist` **可能还没声明**
   （报错 `slot "sidebar.panellist" is not declared`）。修法：**退避重试**（最多 8 次，250ms×n），
   只有全部失败才落诊断，并把当前可见的 `sidebar*` slot 打印出来。
2. **点击收不到**：图标节点确实挂载（16×16、`pointer-events:auto`），但 **React 的 `onClick` 从未被调用**
   —— DSH 的行按钮用 React 委托处理点击，我们挂在其子节点上的合成事件收不到。
   修法：改用**原生 DOM 监听器**，通过 callback ref **同时绑到图标节点和整行按钮**上
   （图标只占 16×16，用户多数会点在文字区域），并带"找到即绑"的重试。

### 未受影响

接力（B→A）、划词注入（A→B）、CDP 通道、`index.js`、`page-script.js` **一行未改**；
实测互传仍正常（`接力已写入输入框(replace)`、`A→B inject -> ok:true`）。

---

## v1.6.0 — 2026-09-27

这一版集中修复「DSC → DSH 接力」方向的一系列问题。**默认行为有一处变化，请先读第 1 条。**

### ⚠️ 行为变化：接力默认改为「覆盖」

`relayAppendMode` 默认值 = `'replace'`。

- **以前**：每次接力都**追加**到输入框已有内容后面。
- **现在**：每次接力**覆盖**输入框内容，里面永远只有最新这一条。
- **为什么**：DSH 输入框是 Lexical 编辑器，官方 `setDraft` 会**清空并重建整棵内容树**，
  代价随草稿长度线性增长。追加模式下几轮就累积到几千字，写入从毫秒涨到数秒 ——
  现场表现就是「输入框越撑越大 / 卡爆点不动 / 同一段出现好几遍」。
  覆盖模式下写入规模恒定（实测 10 轮全是 183 字），从机制上不可能再累积。
- **想恢复追加**：在插件配置里写 `relayAppendMode: "append"`（仍带上限与镜像读取，比旧版安全，但会比覆盖模式卡）。

### 修复清单

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 每次都弹「自动填入失败，内容已复制到剪贴板」，但 DSH 其实写成功了 | 宿主 CDP WebSocket **僵死但 `readyState` 仍是 OPEN**，`ensureCdpAttached()` 的幂等短路一直放行；命令条条等 10 秒超时，且**永不恢复** | 新增 `forceCdpDisconnect()`；`cdpEvaluate()` 超时后强制断开 → 重建 → **只重试一次** |
| 2 | 气泡长时间停「发送中…」，最后仍误报失败 | 竞态：网页端先 `send()` 再登记 `pending`，而宿主回执只用了 ~110ms，回执**赶在 pending 之前**到达 → 被 `if (!pending) return` 丢弃 | 宿主回执**推迟 250ms** 再发送 |
| 3 | 窗口明明开着，却报「没有调试端口」 | 宿主重启或窗口由上一条实例打开时，`relayCdp.port` 为空 | `/inject` 前**自救**：复用 `findDebugPortInCmdline()` 从 Chrome 命令行找回端口 |
| 4 | 输入框被撑到滚不回去 | 追加无上限 + 编辑器自动长高 | 草稿总量上限 `draftMaxChars`（默认 6000，超出裁最老的）；并见上方默认改覆盖 |
| 5 | 输入框里「大量空白」 | ① 三处前缀文案历史上不一致 → 去重永不成立 → 每接一次多贴「前缀 + 空行」；② Lexical 把每个 `\n` 变成一个**段落**，空行 = 真空段落（还带段间距） | 三处前缀统一；`stripRelayPrefixes()` 支持"前缀独占一行"和"前缀贴正文同一行"两种格式，**每块恰好一个前缀**；块间只用 1 个换行 |
| 6 | 同一段内容出现好几遍 | 草稿 > 4000 字时旧逻辑「跳过读取」→ 旧内容被当作不存在后重写；另外 `innerText` 会被**渲染高度截断**（实测写入 5869 字只读回 4821） | 新增镜像 `lastDraftWritten` 作基准；读回值比镜像短时一律采信镜像 |
| 7 | 读→写循环让空行翻倍 | 编辑器段落边界读回成 `\n` | 新增 `normalizeDraftReadback()`：读回时做**幂等**归一（3+ 换行压成 2） |
| 8 | 长文本拖死另一端 | 无上限 | 两端硬截断 `TRANSFER_MAX_CHARS = 2000`；`safeCleanText` 内先 `slice` 再清洗，catch 分支返回**已截断**文本 |
| 9 | 纯空白选区残留气泡 | 只判断了"选区为空" | `stripRelayPrefixes` 等清洗后为空即不冒气泡（此问题实测为轻微，无功能影响） |

### 新增配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `relayAppendMode` | `"replace"` | `replace` 覆盖 / `append` 追加 |
| `draftMaxChars` | `6000` | 输入框草稿总长上限（仅 append 模式生效） |
| `ackTimeoutMs` | `15000` | 网页端等回执的上限（原为写死 6000，会把成功误判为失败） |

### 版本标记（便于确认实际加载的是哪一版）

- `client.js` → `CLEAN_VERSION = 'clean-text-v3-trunc2000'`
- `page-script.js` → `SCRIPT_VERSION = 'selection-bubble-v1.4-ack15s'`，`CLEAN_VERSION = 'clean-text-v3-trunc2000'`
- 接力轮询间隔：**800ms**（日志里会打印「接力轮询已启动（每 800ms）」）
- 写入日志：`接力已写入输入框(replace)，本条 N 字符，草稿总长 M 字符`

### 已知限制（如实记录）

1. `cdpEvaluate` 的「超时 → 重连 → 重试」这条分支**没有在真实僵尸 socket 上被直接复现过**（造不出该状态），只有间接证据（超时确实发生、`forceCdpDisconnect` 确实被调用）。失败时的降级是干净的：返回 `CDP 未连接`，1ms 拒绝，不会挂 10 秒。
2. 自检文件 `%TEMP%\dsh-deepseek-chat-status.json` 是**全机器共用**的，多个实例会互相覆盖 —— 不能用它区分实例。
3. 同一实例 Home + 同 profile **不要同时跑两个进程**：插件按"该 profile 的 Chrome 进程"识别窗口，两个实例会互抢同一个 DeepSeek 窗口，表现为「窗口开着却没有调试端口」。
