# dsh-deepseek-chat

> **版本**：v1.0.0（2026-09-29）—— 首个正式版。
>
> ⚠️ **包名变更**：本版从 `dsh-deepseek-web` 改名为 **`dsh-deepseek-chat`**，
> 界面文案从「DeepSeekchat」改为「**DeepSeek chat**」（多一个空格），
> 专用浏览器 profile 目录从 `deepseek-web-profile` 改为 `deepseek-chat-profile`。
> **升级步骤**：先跑旧包的 `uninstall.ps1` 摘掉 `dsh-deepseek-web`，再跑本包 `install.ps1`，
> 否则 `dsh.profile.bundles` 里会留着失效的旧包名。详见 CHANGELOG 的 v1.0.0 一节。
>
> **界面（v1.7.0 起沿用）**：原来的「顶部品牌行下拉切换器」已删除（该位置被桌面壳结构性隐藏，
> 详见 CHANGELOG）。现在改为在**左侧边栏**新增原生菜单项 **DeepSeek chat**
> （与「扩展管理 / 定时任务 / IM」并列）。点击它在独立窗口里打开 chat.deepseek.com。
> 划词互传功能不受影响。
>
> **功能改动**：无。`client.js` / `index.js` 相对 v1.7.0 逻辑一行未动 —— 除命名替换外，
> 只改了两个文件头注释。本 README 已全文对齐当前实现。


插件在 DSH 的**左侧面板列表**（「扩展管理 / 定时任务 / IM」那一列）里加一个原生菜单项：

```
┌──────────────────────────────┐
│  🧩 扩展管理                  │
│  ⏰ 定时任务                  │
│  💬 DeepSeek chat          ← 本插件新增
│  …                            │
└──────────────────────────────┘
          ↓ 点一下
   用系统里的 Chrome/Edge 打开一个没有地址栏的独立窗口，
   内嵌 https://chat.deepseek.com，登录态永久保存在磁盘上。
```

- 点 **DeepSeek chat** → 用系统里的 Chrome/Edge 打开一个**没有地址栏的独立窗口**，
  内嵌 `https://chat.deepseek.com`，登录态**永久保存在磁盘上**，关掉再开不用重新登录。
- 那个窗口**已经开着**时再点 → **不再新开**，直接把已有窗口切到前台（判活规则见第四节）。
- 点完右下角会依次弹提示：`正在打开 DeepSeek chat 窗口…` → `DeepSeek chat 窗口已就绪（over-dsh）`；
  失败则是 `打开失败：<原因>`，不会静默。括号里是宿主返回的落点/状态：
  `over-dsh` / `center` = 新开的窗口按哪种定位摆，`focused` = 窗口本来就在、只是切回前台。
- **没有「模式切换」这回事了**：旧版下拉菜单里的「DSH 默认模式 / DeepSeek chat」二选一、
  打勾状态、`localStorage` 记忆，都随下拉框一起删除 —— 菜单项只负责打开那个窗口，DSH 本体不受影响。
- ⚠️ **右侧内嵌面板还没接**：点菜单项不会在右侧打开内嵌页面（那需要 `ctx.sidebarRightTabs`，属后续项）。

目标环境：DSH **0.1.5-rc.3** + 启动器 **DSH-Launcher 0.0.15**（Tauri + WebView2），
测试实例 Home = `D:\dshl`，profile = `tauri`，端口以启动器分配为准（常见 `3081` / `3082`）。

---

## ⚠️ v1.6.0 起有一处默认行为变化（先读这个）

**接力（网页端 → DSH）默认改为「覆盖」输入框内容**，不再追加。

| | 旧版（≤ v1.5.1） | v1.6.0 |
|---|---|---|
| 每次都传 | 追加在输入框已有内容**后面** | **覆盖**，输入框里只保留最新这一条 |
| 连续传多次 | 草稿不断变长 | 每条都是独立一条，长度恒定 |
| 副作用 | 草稿几千字后**输入框被撑爆、卡到点不动、内容重复叠加** | 无（写入规模恒定） |

**为什么改**：DSH 输入框是 Lexical 编辑器，官方 `setDraft` 会**清空并重建整棵内容树**，
代价随草稿长度线性增长 —— 追加模式下几轮就会把界面拖死。

**想恢复追加**：配置 `relayAppendMode: "append"`（仍带 6000 字上限与镜像读取，比旧版安全，但会比覆盖模式卡）。

完整改动清单见同目录的 **`CHANGELOG.md`**；本节以下的正文若与 CHANGELOG 冲突，以 CHANGELOG 为准。

---


## 一、先读这一节：为什么不是 iframe（也不是 Tauri WebviewWindow）

你原始需求里的第 4 条是「在 DSH 内部**内嵌**加载 `https://chat.deepseek.com`」。
这一条**在物理上做不到**，我把实测证据放在这里，免得你后面反复试。

### 1. 用 `<iframe>` 内嵌：站点自己拒绝

```
$ curl -sSI https://chat.deepseek.com
HTTP/1.1 403 Forbidden            # 非浏览器指纹，AWS WAF 直接拒
server: CloudFront
```

浏览器指纹的请求则拿到 JS 挑战（`x-amzn-waf-action: challenge`），
并且正常响应头里带：

```
content-security-policy: frame-ancestors 'none'
set-cookie: ds_session_id=...; HttpOnly; Secure; SameSite=Strict
```

三条加起来，iframe 方案必死：

| # | 原因 | 后果 |
|---|---|---|
| 1 | `frame-ancestors 'none'` | 浏览器拿到响应头就直接拒绝渲染，**任何**来源都不行 |
| 2 | WAF 的 JS 机器人挑战 | 跨源 iframe 里跑不完 → `Max challenge attempts exceeded` |
| 3 | `SameSite=Strict` 登录 Cookie | 第三方上下文里根本不会被发送，**即使**前两条都过了也登不上 |

这是**站点侧的安全策略**，纯前端插件没有任何绕过手段。

### 2. 用 Tauri 的 `WebviewWindow`：拿不到这个能力

你提到的「利用 DSH 底层（Tauri）提供的能力」这条路，有两个硬障碍：

1. **DSH 的插件体系里没有 Tauri 这一层。** DSH 0.1.5-rc.3 的全部代码里搜不到
   `tauri` 字样 —— 它被设计成既能跑在启动器的 WebView2 里，也能跑在普通浏览器里
   （还有一个 `web` profile）。插件能拿到的只有：
   - **宿主半边**：cordis 插件（Node 进程里跑）
   - **浏览器半边**：slot UI（网页里跑）
   没有 `WebviewWindow` / 自定义协议这类原生出口。

2. **Tauri 的 CSP / capability 是编译进 exe 的。** 你的启动器是
   `DSH-Launcher_0.0.15_windows_x64_portable.exe` —— 一个 21 MB 的单文件，
   **根本没有可编辑的 `tauri.conf.json`**。想改也改不了。

> **所以你问的「tauri.conf.json 要改哪一行」——答案是：一行都不用改，也没有得改。**
> 本插件刻意既不用 iframe（不需要放宽 CSP），也不用 Tauri IPC（不需要 capability）。

### 3. 本插件实际采用的方案

把 DeepSeek 放进一个**独立的浏览器窗口**（顶层浏览上下文），于是：

- 它是**第一方页面** → WAF 的 JS 挑战能正常跑完；
- Cookie 是**第一方 Cookie** → 不再被第三方 Cookie 策略拦截；
- 配合专用 `--user-data-dir` → Cookie / LocalStorage / 缓存全部落盘，重启不掉登录。

窗口用 Chrome（你的默认浏览器）或 Edge 以 `--app=` 模式打开：**没有地址栏、没有标签页**，
视觉上就是一个属于 DSH 的窗口，零额外安装。

**实测证据**（本机 Windows 11 + Chrome 154）：

```
窗口标题                      : DeepSeek - 探索未至之境
专用 profile 的 Cookies 库里  : chat.deepseek.com / smidV2
                               .deepseek.com     / aws-waf-token
窗口关闭后再打开              : 仍是登录态（Cookie 在磁盘上）
```

即：挑战通过 ✅、站点正常加载 ✅、登录态落盘 ✅。

**诚实说明它和「内嵌」的差距**：它是 DSH 窗口**旁边/上面**的一个独立窗口，不是画在
DSH 页面里的一个 `<div>`。DSH 侧边栏和输入框不会被它遮住（默认按 DSH 窗口内容区定位，
避开了左侧边栏）。这是当前技术条件下能做到的最接近「内嵌」的效果。

---

## 二、目录结构

```
dsh-deepseek-chat\
├── package.json          # 插件清单：dsh.bundle.patch + dsh.client + exports["./client"]
├── cordis.patch.yml      # 唯一的「启用开关」+ 配置写在这里
├── index.js              # 宿主半边：HTTP 路由 + 启动/关闭浏览器窗口 + CDP 通道
├── client.js             # 客户端半边：左侧菜单项 + 划词气泡（全部 UI 在这里）
├── page-script.js        # 注入到 chat.deepseek.com 页面里的那一半（划词 / 回传）
├── install.ps1           # 一键安装（幂等，可反复跑）
├── uninstall.ps1         # 一键卸载 / 紧急禁用（幂等）
├── tools\
│   └── patch-bundles.cjs # 安全增删 dsh.profile.bundles 的小工具（install/uninstall 会调用）
├── CHANGELOG.md          # 逐版本变更记录
├── README.md             # 这份说明
└── .gitignore            # 仓库卫生用（插件包本身不需要它）
```

一共 **10 个插件文件**，**没有多余的东西**：`package.json` / `cordis.patch.yml` / `index.js` / `client.js`
是 DSH 运行时真正加载的（`page-script.js` 由宿主半边读出来、注入到网页端那个窗口里）；
`install.ps1` / `uninstall.ps1` / `tools\patch-bundles.cjs` 是安装与卸载要用的；
`CHANGELOG.md` / `README.md` 是文档。除此之外没有任何依赖、没有 `node_modules`、没有构建产物。

> `.gitignore` 只在 Git 仓库里有意义（挡掉 `node_modules/`、`*.bak-*`、编辑器目录），
> 不属于插件运行所需文件 —— 直接拷贝文件夹安装的话可以忽略它。

**整个文件夹是自包含的**，可以整体复制到任何位置：

- 代码里没有任何硬编码的本机路径；
- `install.ps1` 用**自己所在目录**当插件路径，所以搬到哪都能直接跑；
- 唯一的外部依赖是 Node（DSH 自带）和 Chrome/Edge（系统本来就有）。

> ⚠️ **但它现在已经被实例「链接」着了**：`D:\dshl\profiles\node_modules\dsh-deepseek-chat`
> 是一个指向本目录的目录联接。所以**不要直接剪切/重命名这个文件夹**，否则那个链接会断，
> 实例下次启动就找不到了。要换位置的话按这个顺序来：
>
> ```powershell
> # 1) 先卸载（摘掉 bundles 登记 + 删掉联接，不动源码）
> powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome D:\dshl
> # 2) 再移动文件夹
> Move-Item D:\dshl-plugins\dsh-deepseek-chat E:\你的新位置\dsh-deepseek-chat
> # 3) 在新位置重新安装
> cd E:\你的新位置\dsh-deepseek-chat
> powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome D:\dshl
> ```

---

## 三、安装（保姆级）

### 步骤 0：确认路径

```powershell
Test-Path D:\dshl\profiles\tauri\package.json    # 期望 True
```

不是 `True` 就说明实例 Home 或 profile 名字不一样，后面所有命令里的
`-DshHome` / `-Profile` 要跟着改。

### 步骤 1：跑安装脚本

**关闭正在运行的那个实例**（脚本本身不需要关，但脚本最后会提示重启，且
运行中的实例会锁住部分文件）。然后在 PowerShell 里：

```powershell
powershell -ExecutionPolicy Bypass -File D:\dshl-plugins\dsh-deepseek-chat\install.ps1 -DshHome D:\dshl
```

脚本做四件事（**都是幂等的，重复跑没问题**）：

1. 在 `D:\dshl\profiles\node_modules\` 下建一个**目录联接**指向本插件目录
   （Junction，**不需要管理员权限**）；
2. 把 `"dsh-deepseek-chat"` 加进 `D:\dshl\profiles\tauri\package.json` 的
   `dsh.profile.bundles`；
3. 备份原 `package.json`（带时间戳）；
4. 跑一次 `--dump-config` 自检。

看到这两行就是成功了：

```
  [OK] dump-config 里已出现 dsh-deepseek-chat —— 插件会被加载
=== 装完了 ===
```

### 步骤 2：重启实例

在 **DSH 启动器**里对着「试验品」那个实例点**重启**（或先停止再启动）。
插件是在启动时加载的，不重启不生效。

### 步骤 3：硬刷新页面

实例窗口起来后按 **Ctrl+Shift+R** 强制刷新。左侧边栏的**面板列表**里应该多出一项 **DeepSeek chat**
（就在「扩展管理 / 定时任务 / IM」那一列；侧边栏处于**收起态**时先点左上角展开）。

### 步骤 4：确认装上了（可选但推荐）

```powershell
Get-Content "$env:TEMP\dsh-deepseek-chat-status.json"
```

期望能看到（`dshHome` 应为 `D:\dshl`）：

```json
{
  "at": "2026-09-27T15:06:42.000Z",
  "dshHome": "D:\\dshl",
  "node": "v22.14.0",
  "platform": "win32",
  "browser": { "kind": "chrome", "exe": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  "profileDir": "D:\\dshl\\deepseek-chat-profile",
  "received": {
    "client": "dsh-deepseek-chat",
    "loaded": true,
    "registered": [
      "sidebar.panellist#dsh-deepseek-chat-panel",
      "shell.overlay#dsh-deepseek-chat-overlay",
      "conversation.session.header.utilities#dsh-deepseek-chat-bridge"
    ],
    "mode": "dsh",
    "phase": "apply",
    "diag": ["apply() 进入", "左侧菜单项注入已提交（等 sidebar slot 声明）",
             "已注册左侧菜单项 DeepSeek chat（第 1 次尝试成功）", "菜单项自检: 已出现在侧边栏 ✓"]
  }
}
```

- **文件不存在** → 浏览器半边没加载。先确认 `bundles` 里有它，再看启动日志。
- **`registered` 里没有 `sidebar.panellist#dsh-deepseek-chat-panel`** → 菜单项没注册上，
  `diag` 里会有具体报错（最后一条通常是 `panellist-register-failed`，并列出当时可见的 `sidebar*` slot 名）。

---

## 四、使用

| 操作 | 结果 |
|---|---|
| 点左侧边栏的 **DeepSeek chat** | 打开 DeepSeek 窗口；右下角依次提示 `正在打开 DeepSeek chat 窗口…` → `DeepSeek chat 窗口已就绪（over-dsh / center / focused）` |
| **窗口已存在时再点** | **不再新开**：切回并聚焦已有窗口（多信号判活，见下） |
| 手动关掉 DeepSeek 窗口 | 下次点会重新打开，**登录态还在** |
| 打开失败（找不到 Chrome/Edge、宿主报错…） | 右下角提示 `打开失败：<原因>`，不会静默 |
| 在网页端点每条回复下面的 **↪ 转到 DSH 继续** | 把那条回复接力回 DSH 的输入框 → 见 [附录 B](#附录-b上下文接力转到-dsh-继续) |

菜单项没有「选中状态」要记：它就是一个按钮，点一次开（或唤起）那个窗口，不存在模式切换，
所以也没有旧版那套 `localStorage` 打勾记忆。

> 💡 **上下文接力**（把网页端的回复一键送回 DSH 输入框）是 v1.1.0 新增的能力，
> 完整说明、配置项和已知限制都在文末的 **附录 B**。默认**已开启**。

### 「窗口已存在」是怎么判定的（v1.2.0 加固）

以前只靠「查进程命令行」判断窗口在不在，一旦 PowerShell 被安全软件挡住或查询超时，
就会被误判成「没开」而**重复开窗**。现在改成**多信号**：

1. **调试端口还应答**（最快最可靠，不依赖 PowerShell）—— 有端口就直接认定「已存在」；
2. 没有端口时再**按命令行特征查进程**；
3. 两者都没有、但 15 秒内刚开过 → 等 2.5 秒复查一次（躲开 Chrome 冷启动竞态）。

判定「已存在」之后，`/open` **不再新建窗口**，而是：
把已有窗口 `ShowWindow(RESTORE)` + 合成一次 Alt 解前台锁 + `SetForegroundWindow`
（与接力唤起 DSH 用的是同一招，实测 `True`）。
窗口靠**进程归属**认（pid 落在本插件专用 profile 的进程集合里），不靠标题，所以网页改标题也认不错。

万一前台锁没解开（极少见），DSH 右下角会弹一条提示让你去任务栏点一下 —— 这是唯一
「点完像没反应」的情况，不会静默。

---

## 五、配置：改哪一行

**所有配置都写在插件自己的 `cordis.patch.yml` 里**。这个文件同时也是插件的启用开关：

```yaml
- insert:
    - id: dsh-deepseek-chat
      name: dsh-deepseek-chat
      # ↓↓↓ 从这里开始加配置，不加就是全默认 ↓↓↓
      config:
        placement: over-dsh
```

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `url` | string | `https://chat.deepseek.com` | 要打开的地址，必须 http(s) 开头 |
| `browserPreference` | `auto`\|`chrome`\|`edge` | `auto` | `auto` = Chrome 优先、Edge 兜底。想固定用 Edge 就写 `edge` |
| `placement` | `over-dsh`\|`center` | `over-dsh` | `over-dsh` 贴着 DSH 窗口内容区摆；`center` 交给系统随便放 |
| `sidebarInset` | number | `268` | `over-dsh` 时给左侧边栏留的宽度（px）。窗口压住侧边栏就调大 |
| `gap` | number | `10` | 四周留白（px） |
| `minWidth` / `minHeight` | number | `520` / `460` | 窗口最小尺寸（px） |
| `relayAppendMode` | `replace`\|`append` | `replace` | 接力写入方式。**v1.6.0 起默认覆盖**；`append` = 追加（带上限） |
| `relayMaxChars` | number | `2000` | 单次互传的字符上限（超出硬截断）。两端一致 |
| `draftMaxChars` | number | `6000` | 输入框草稿总长上限。**仅 `append` 模式生效**，超出裁掉最老的内容 |
| `ackTimeoutMs` | number | `15000` | 网页端等 DSH 回执的上限（毫秒）。太小会把成功误判为失败 |

改完 **要重启实例**（宿主半边改动不热更新）。

> 只改 `client.js`（纯 UI）不用重启，**硬刷新页面**即可 —— 客户端半边按
> `mtime + size` 参与 revision 计算，浏览器会重新取。

---

## 六、登录态持久化 / 重置登录

- 登录态存在 **`D:\dshl\deepseek-chat-profile\`**（一个完整的 Chromium 用户数据目录）。
- 它和 DSH 自己的 WebView2 目录、以及你日常用的 Chrome profile **完全隔离**，
  互不污染。这个窗口里也不会带你日常 Chrome 的书签/扩展/登录。
- **想在 DSH 里换 DeepSeek 账号**：关掉窗口，删掉这个目录，再点一次「DeepSeek chat」。
  ```powershell
  Remove-Item -LiteralPath D:\dshl\deepseek-chat-profile -Recurse -Force
  ```
- **想彻底重置**：删掉整个目录即可，插件下次会自动重建。

---

## 七、紧急禁用 / 卸载（防污染）

这个插件**绝不会**因为自身异常让 DSH 起不来：宿主半边整个 `apply()` 包在
try/catch 里（最坏是静默失效），客户端半边的外部依赖与 slot 注册也都各自 try/catch
（不会把 combo bundle 打断导致首页白屏）。

真出问题时，按**从轻到重**选一个：

### 办法 1（最快，不用动 node_modules）：只把开关关掉

编辑 `D:\dshl-plugins\dsh-deepseek-chat\cordis.patch.yml`，把 `insert:` 那一行删掉或注释掉：

```yaml
# - insert:
#     - id: dsh-deepseek-chat
#       name: dsh-deepseek-chat
```

重启实例。插件完全不加载，DSH 照常。想恢复就把注释去掉。

### 办法 2（推荐）：跑卸载脚本

```powershell
powershell -ExecutionPolicy Bypass -File D:\dshl-plugins\dsh-deepseek-chat\uninstall.ps1 -DshHome D:\dshl
```

它会**先**从 `dsh.profile.bundles` 里摘掉包名、**再**删掉 node_modules 联接
（顺序很重要：留着联接没登记不影响，留着登记没联接才会报错），然后重启。

### 办法 3：DSH 自带的插件管理界面

如果这个实例有「设置 → 插件」面板（`dsh-client-ui-settings-plugins`），
也可以在里面直接禁用。

### 启动前先自检（不用真启动）

改动之后、重启之前，可以先验证配置能不能组起来：

```powershell
$env:DSH_HOME='D:\dshl'
node D:\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile tauri --dump-config | Select-String 'dsh-deepseek-chat'
```

有输出 = 会被加载；没输出 = `cordis.patch.yml` 或 `bundles` 没配对。

---

## 八、排障

**侧边栏没有 DeepSeek chat？**

1. 先看 `%TEMP%\dsh-deepseek-chat-status.json` 在不在。
   它每次加载都会重写，`diag` 数组按时间顺序记录了整条链路，对着看就能定位：

   | diag 里最后出现的那条 | 含义 / 怎么办 |
   |---|---|
   | （文件不存在） | 客户端半边没加载：确认 `bundles` 里有 `dsh-deepseek-chat`、并且重启过实例 |
   | `apply() 进入` | 模块进来了，正在等 slot 声明。**停在这里 = slot 一直没被声明** |
   | `左侧菜单项注入已提交（等 sidebar slot 声明）` | 已提交注册，等 `sidebar` 声明 |
   | `已注册左侧菜单项 DeepSeek chat（第 N 次尝试成功）` | 注册成功（`panellist` 子表可能晚于 `sidebar` 声明，所以带退避重试，见下面第 2 条） |
   | `菜单项自检: 已出现在侧边栏 ✓` | **成功**，DSH 已经把这一行画出来了（带实测尺寸） |
   | `菜单项自检: 未找到（侧边栏可能是收起态，展开后可见）` | 注册成功但当前看不到 —— 多半是侧边栏处于**收起态**（56px 图标轨道），点左上角展开即可 |
   | `glyph-bound` / `click-fired` | 图标节点已绑上原生点击监听 / 点击确实命中了（排查「点了没反应」用） |
   | `panellist-register-failed` | 8 次退避重试全部失败；`diag` 里会列出当时可见的 `sidebar*` slot 名 |

2. **关于 `sidebar.panellist` 的两个坑（v1.7.0 都踩到并修掉了）。**

   - 它是 **`kind:"list"`**，和 `sidebar.brand.name` 那种 `single` 不一样：list 是**追加**语义，
     不需要抢 priority，但**必须带 `id`**（SlotCore 硬校验：
     `list slot "…" requires options.id`）。本插件的条目是：

     ```js
     { name: 'sidebar.panellist', id: 'dsh-deepseek-chat-panel', order: 40, label: 'DeepSeek chat' }
     ```

   - **注册时机**：`ctx.slots.inject('sidebar', …)` 的回调触发时，子表 `sidebar.panellist`
     **可能还没声明**（报错 `slot "sidebar.panellist" is not declared`）。所以注册带
     **退避重试**（最多 8 次，250ms×n），全部失败才落 `panellist-register-failed` 诊断。

   - **点击收不到**：DSH 的行按钮用 React 委托处理点击，挂在我们子节点上的合成事件**收不到**。
     所以改用**原生 DOM 监听器**，通过 callback ref **同时绑到图标节点和整行按钮**上
     （图标只有 16×16，用户多数会点在文字区域），并带「找到即绑」的重试。

3. 旧版那个挂在 `sidebar.brand.name`（`single` slot，priority **-1000** 抢位）上的下拉按钮
   **已整个删除**，所以现在**不需要**关心 priority 抢占。删它的原因：该 slot 位于官方
   「新建会话」按钮的子树里，桌面壳会把这一支隐藏 —— 实测元素在 DOM 里、尺寸 0×0、
   `display:none`，内联样式 + `!important` 都压不过，属于结构性不可用。

**点了「DeepSeek chat」但没反应？**

- 先看**右下角的 toast**（成功/失败原因）—— 它是这个菜单项唯一的反馈出口。
- 也可能是窗口开在**别的屏幕**或被别的窗口挡住了（`placement: center` 时尤其容易）。
- 想改成固定贴合 DSH：确认 `placement: over-dsh`（默认）。

**窗口压住了左侧边栏？**

调大 `sidebarInset`（默认 268，侧边栏更宽就写 300~340）。

**关闭窗口后，下次打开提示要不要「恢复上次会话」？**

已内置 `--hide-crash-restore-bubble` 抑制。还出现的话说明进程是被强杀的，忽略即可。

**想换回只用自己的 Edge？**

`config` 里写 `browserPreference: edge`。

---

## 九、已知限制

1. **不是真正的 DOM 内嵌。** DeepSeek 是独立顶层窗口，不是画在 DSH 页面里的元素。
   原因见第一节 —— 这一点无解。
2. **占用一个独立浏览器 profile。** 你在那个窗口里不会带着日常 Chrome 的登录状态，
   需要**在里面单独登录一次** DeepSeek（之后就一直记住了）。
3. **`placement: over-dsh` 是近似定位。** 按 DSH 窗口内容区 + 左侧边栏宽度估算，
   多显示器 / 高 DPI 缩放下可能有偏差，手动拖一下即可。
4. **「已经开着」的判定靠命令行特征查进程**（`Win32_Process` 的 `CommandLine` 里
   是否含专用 profile 路径）。所以它依赖 PowerShell 可用（Windows 自带）。
   实测：启动后匹配到 12~18 个进程，关闭后归零。
   > 为什么不记住 `spawn()` 返回的 pid？因为实测 Chromium 用新 `--user-data-dir`
   > 首次启动会「自我重启」，spawn 出来的那个进程几秒内就退出了 —— 靠 pid 判断会
   > 误判成「没开」，连点几下就开出一堆窗口。这个坑踩过，所以改成查进程。
   >
   > 另外还有一个**冷启动竞态**也踩到过并已修：Chrome 第一次建专用 profile 时，
   > 进程要把 `--user-data-dir=...` 挂到命令行上需要几秒，这段窗口期查不到进程。
   > 现在「刚开过 15 秒内 + 查不到进程」会先等 2.5 秒复查一次，再决定要不要开新的。
5. **第一次打开会有几秒到几十秒的 WAF 挑战等待**（标题显示「请稍候…」），
   这是 CloudFront 在跑 JS 挑战，通过后变成「DeepSeek - 探索未至之境」。属正常。

---

## 十、License

MIT

---

## 附录：两个品牌图标的来源，以及如何换成图片文件

> ⚠️ **本节是历史存档（v1.6.0 及以前）。** 那时插件挂在侧边栏**顶部品牌行**上，是一个下拉菜单，
> 菜单里两项各带一个鲸鱼图标。**v1.7.0 已删除下拉菜单**，改成左侧边栏的原生菜单项，
> 图标换成一个自绘的「对话气泡 + 折线」轮廓（`client.js` 里的 `DeepSeekChatIcon`，
> 不使用任何商标图形，`stroke:currentColor` 跟随主题）。
> 所以下面关于两个鲸鱼 Logo 的考证只对 **≤ v1.6.0** 的代码有意义；
> 而「想换成自己的图片文件」那一节讲的通用做法（宿主侧注册 `assets/` 路由）现在依然可用。

（历史）下拉菜单里两个图标**不是手画的，也不是随便找的鲸鱼**，都是真实的产品 Logo 矢量：

| 菜单项 | 图标 | 用的是什么 | 颜色 |
|---|---|---|---|
| DSH 默认模式 | 黑鲸鱼 | DSH **自己**的品牌路径 `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX`，从浏览器里的种子模块 `@deepseek-ai/dsh-client-ui-primitives` 运行时读取 —— 与侧边栏品牌行 fallback 用的 `FishLogo` 是**同一份**官方矢量 | `currentColor`（浅色主题=黑，深色主题自动=白） |
| DeepSeek chat | 蓝鲸鱼 | DeepSeek 官方图标，品牌蓝 **#4D6BFE** | 固定品牌色，不跟随主题 |

DSH 图标的兜底矢量取自 DSH 前端自带的 `dsh-web-frontend/dist/favicon.svg`（viewBox `0 0 50 50`），
所以即使种子模块里读不到路径，画出来的仍是 DSH 官方那条鲸鱼。

DeepSeek 图标的矢量来源（CC0 公有领域，可自由使用）：

- <https://commons.wikimedia.org/wiki/File:Deepseek-logo-icon.svg>
- 直链：<https://upload.wikimedia.org/wikipedia/commons/b/ba/Deepseek-logo-icon.svg>

> 取自该文件里那条 `fill="#4D6BFE"` 的鲸鱼路径，**去掉了原图的白底圆角方块** ——
> 否则深色主题下会出现一块白色方块。品牌蓝 `#4D6BFE` 的出处：
> <https://uicolours.com/brands/deepseek>

### 想换成自己的图片文件（可选）

内联 SVG 的好处是颜色/形状不丢、不依赖任何文件、深色主题自动适配，所以**默认就用它，不用改**。
如果你确实想换成官方 PNG 或者别的图，按下面两步做：

**第 1 步**：在插件目录建 `assets\`，把图片放进去，例如
`assets\dsh.svg`、`assets\deepseek.png`。

**第 2 步**：在 `index.js` 里加一条只服务这个目录的路由。

> 为什么必须走宿主半边：客户端半边是在**网页里**执行的，`src="./assets/x.svg"` 会相对
> DSH 的页面地址（`http://127.0.0.1:3080/`）解析，根本找不到插件目录。
> 只有宿主半边（Node）能读到插件目录里的文件。

放在其他 `route(...)` 旁边即可（注意这里**不能**用文件里那个 `route()` 小助手，
它写死了 `kind: 'exact'`，这里要前缀匹配）：

```js
// WebRouteKind 支持 'exact' 与 'prefix'；'prefix' p 会匹配 p 以及 p/<任意子路径>
const ASSET_DIR = path.join(PACKAGE_ROOT, 'assets')

ctx.webServer.register({
  kind: 'prefix',
  path: `${BASE}/asset`,
  handler: async (req, res) => {
    const code = rejection(req)          // 复用文件里已有的信任栅栏
    if (code !== null) {
      res.writeHead(code).end('forbidden')
      return
    }
    const raw = String(req.url || '').split('?')[0]
    const name = decodeURIComponent(raw.slice(`${BASE}/asset/`.length))

    // 白名单：只允许「字母 数字 . _ -」，从根上挡掉 ../ 、子目录、绝对路径
    if (!/^[a-z0-9._-]+$/i.test(name)) {
      res.writeHead(400).end('bad name')
      return
    }
    const file = path.join(ASSET_DIR, name)
    if (!file.startsWith(ASSET_DIR + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    const type =
      { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[
        path.extname(name).toLowerCase()
      ] || 'application/octet-stream'
    const body = fs.readFileSync(file)
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  },
})
```

> ⚠️ 这是一条「把磁盘内容吐给网页」的能力，所以上面做了三道限制：
> 只暴露 `assets/` 这一个目录、文件名白名单、解析后再确认没跑出目录。
> 别把它改成允许任意路径。

**第 3 步**：把 `client.js` 里对应组件的返回值从 `<svg>` 改成 `<img>`：

```js
function DeepSeekWhaleLogo(props) {
  const size = (props && props.size) || 16
  return React.createElement('img', {
    src: `${BASE}/asset/deepseek.png`,   // BASE = '/dsh-deepseek-chat'
    width: size,
    height: size,
    alt: '',
    style: { display: 'block' },
  })
}
```

改完**硬刷新页面**即可（客户端半边热加载，不用重启实例）。

### 我实测确认过的效果

- 菜单里 3 个 `<svg>`：DSH 鲸鱼（`fill` 继承 `currentColor`）、
  DeepSeek 鲸鱼（`fill="#4D6BFE"`）、勾选 ✓。
- 底部那行状态提示已经彻底移除（DOM 里 `.dsw-foot` 不存在）。
- 布局与勾选逻辑没动：图标 → 名称+说明 → 右侧 ✓；当前项恰好一个 ✓。

### 两个图标为什么一定一样大（v1.3.0 修正）

之前它们给的都是 `width/height=16` 的正方框，但**画出来差 1.6 倍**。实测数据：

| 图标 | 用的 viewBox | 路径实际包围盒 | 屏幕上画出来的尺寸 |
|---|---|---|---|
| DSH 鲸鱼 | `0 0 50 50`（DSH 给的） | `23.16 × 17.04`，画在左上角 | **7.41 × 5.45** |
| DeepSeek 鲸鱼 | `0 0 512 509.64`（原图给的） | `377.72 × 277.97` | **11.8 × 8.73** |

根因：DSH 那条路径只占它 viewBox 的 46%×34%，还贴在左上角 —— 又小又偏。

**修法**：不用别人给的 viewBox，改成**用 `getBBox()` 现算路径自己的紧致包围盒**当 viewBox，
再把它缓存起来（不写死数字，将来 DSH 换路径也不用改）。
巧的是两条鲸鱼本来就是同一条，长宽比几乎一致（1.359 vs 1.359），
所以缩放后必然等大。

修完再量（`path.getBoundingClientRect()` 的真实墨迹矩形）：

```
DSH 默认模式   painted 18 × 13.25   left=24  槽内居中偏移 0
DeepSeek chat  painted 18 × 13.25   left=24  槽内居中偏移 0
```

**完全一致。** 另外图标槽尺寸只在 CSS 里定义一处
（`.dsw-item-mark .dsw-logo{width:18px;height:18px}`），
两个图标都带 `dsw-logo` 类，所以不会再因为传参不同而不一致。

### 菜单为什么用 `position:fixed` 而不是 `position:absolute`（v1.3.0）

需求里建议用 `position:absolute; top:100%; left:0`。**那个写法在这里会被裁掉**，原因是：

DSH 侧边栏的品牌行容器带 `overflow:hidden`：

```css
.hHd-Xa_logoRow{ ...; overflow:hidden }   /* ← 品牌行只有 60px 高 */
```

我们的菜单是渲染在品牌行**内部**的。用 `absolute` 的话，它会被这个 60px 高的
`overflow:hidden` 直接剪没（弹出菜单有 160+px 高）。
要让它出来就必须去改 DSH 自己的 CSS —— 那就成了「插件改宿主 DOM」，最不该做的那类耦合。

所以做法是**保留 `position:fixed`**（它不受祖先 `overflow` 影响），
但把坐标算成**你要的那个视觉效果**：

| 你的要求 | 实现方式 |
|---|---|
| 垂直在按钮正下方 | `top = 按钮.getBoundingClientRect().bottom + 6` |
| `left:0` / 宽度在侧边栏以内 | 量出侧边栏矩形，`left = 侧边栏.left + 8`，`width = 侧边栏.width - 16`（并夹在 200~340 之间） |
| 再夹一次防越界 | `left` 再夹进 `[8, 视口宽 - 菜单宽 - 8]`，**右边永远不可能越界** |
| 足够高的 z-index | `z-index: 2147483000`（远高于 9999，DSH 自己的浮层是 20 层级） |
| 文字不被遮挡 | 描述改成 `white-space:normal` 正常换行；菜单再加 `max-height` + 纵向滚动 |

以实测为例（侧边栏 `0→280`，按钮在 `206→226`）：

```
修前：菜单 l=206 r=486   ← 向右伸出侧边栏 206px，盖住主区域
修后：菜单 l=8   r=272   ← 完整落在侧边栏里
```

### 描述文字「被截断」的真实原因（v1.3.0）

之前看到的 `在独立窗口打开网页版，登录态持久…` **不是**被窗口边缘切的，
是我自己 CSS 里写的：

```css
.dsw-item-desc{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
```

实测证据：`scrollWidth 207 > clientWidth 196` → 被 `ellipsis` 截成了三个点。
现在改成 `white-space:normal` + `overflow-wrap:anywhere`，长描述正常换行，实测
`scrollWidth == clientWidth`（不再截断）。

---

## 附录 B：上下文接力（↪ 转到 DSH 继续）

在网页端**每条 AI 回复下面**挂一个小按钮，点一下就把那条回复抓成 Markdown，
自动写进 DSH 当前的输入框，并带上默认前缀。省掉「复制 → 切窗口 → 粘贴」三步。

### B.1 先说清楚：这里不能用 Tauri 的 emit / listen

原始设想是用 Tauri 的 IPC 把数据发回 DSH 主进程。**这条路走不通，而且是双重走不通**：

1. **DSH 的插件体系里没有 Tauri 层。** DSH 0.1.5-rc.3 全部代码里搜不到 `tauri`
   （它被设计成既能跑在启动器的 WebView2 里，也能跑在普通浏览器里）；
   插件只有 cordis 宿主半边（Node）和浏览器半边（slot UI）。
2. **更要紧的**：DeepSeek 那个窗口**根本不是 Tauri webview**，它是本插件用
   `chrome.exe --app=…` 起的**独立 Chrome 进程**，和 DSH 之间没有任何 IPC 通道 ——
   `emit` 发出去也没人收。

所以换了一条**真实存在、且每一段都实测过**的链路：

```
┌─ chat.deepseek.com 页面里的注入脚本（page-script.js）
│     window.__dshRelay(json)   ← CDP Runtime.addBinding 注册的绑定
▼
┌─ 独立 Chrome 窗口的调试端口 127.0.0.1:<随机端口>（--remote-debugging-port）
│     CDP WebSocket（宿主主动连过去）
▼
┌─ 宿主半边 index.js：入队 + 立刻把 DSH 窗口拉到前台
│     GET /dsh-deepseek-chat/relay?since=N（客户端每 800ms 轮询）
▼
└─ DSH 客户端半边 client.js → inputActions.setDraft(前缀 + 内容)
```

**关键点：写输入框走的是 DSH 官方 API，不是改 DOM。**
DSH 的输入框是 Lexical 富文本编辑器，直接改 DOM 会被它下一次渲染冲掉。
官方给每个 **session 作用域** slot 组件提供了 `InputActions`，里面有 `setDraft(text)`；
本插件把接力桥注册到 `conversation.session.header.utilities`
（`kind:"list"` + `scope:"session"`，list 是**追加**语义，不会顶掉别人的东西）。

> ⚠️ **修正（v1.4.0）**：上面这个 list slot 的注册**原先漏了 `options.id`**，
> 而 SlotCore 对 list 类 slot 是硬校验 `requires options.id` —— 所以**接力桥之前从未真正挂上过**，
> 异常还被吞掉了。已在 v1.4.0 修好，详见 [附录 D.3](#d3-两个关键实现细节)。
> 如果你之前测接力没反应，这就是原因。

### B.2 需要新的权限吗？不需要

| 你可能担心的 | 实际情况 |
|---|---|
| Tauri CSP / capability | **一行都不用改**，也用不上（不走 Tauri） |
| DSH 的什么开关 | 不用，插件自身能力范围内 |
| 装浏览器扩展 | **不用**，走 CDP，不需要用户装任何东西 |
| 管理员权限 | 不需要 |

### B.3 用之前要知道的一件事（重要）

> **本节描述的是 v1.4.1 之前的旧设计（给每条回复挂按钮 + MutationObserver + 选择器策略），
> 该设计已被移除。** 现状：改为**划词即传** —— 你选中什么就传什么，
> 不再依赖任何回复容器选择器，因此也不再需要 `relayBodySelector`。
> 保留本节仅为理解历史。真正的现状见 **B.4 配置项** 与 **B.5 行为细节**。

**网页端的 DOM 我无法验证。** 我没有你的 DeepSeek 登录态，看不到真实回复的 DOM 结构。
所以脚本用的是「多级策略」而不是写死一个选择器：

1. 配置里的 `relayBodySelector`（你确定了就填这里，最稳）；
2. 默认猜 `[class*="ds-markdown"]`（DeepSeek 前端是 `ds-` 前缀的设计系统，
   助手回复的 Markdown 正文一般渲染在这个容器里）；
3. 兜底：找带「复制 / Copy」字样的按钮，往上爬到消息容器。

三级都找不到时，脚本会回传一份**结构诊断**（候选元素的标签/类名/文字长度），
DSH 界面会弹一次提示，诊断也会写进
`%TEMP%\dsh-deepseek-chat-status.json`。把这段发给开发者就能把准确选择器定下来。

**怎么自己确认选择器**：在 DeepSeek 窗口里按 **F12** → 元素选择器点一条回复正文 →
看它的 class，把 `relayBodySelector` 填进配置即可。

### B.4 配置项

都在 `cordis.patch.yml` 的 `config:` 下面（改完**要重启实例**）：

```yaml
- insert:
    - id: dsh-deepseek-chat
      name: dsh-deepseek-chat
      config:
        relay: true                     # 总开关
        relayPrefix: '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】'
        relayMaxChars: 2000             # 单次互传字符上限（超出硬截断）
        relayAppendMode: replace        # replace=覆盖（默认）/ append=追加
        draftMaxChars: 6000             # 输入框草稿总长上限（仅 append 生效）
        ackTimeoutMs: 15000             # 网页端等回执的上限（毫秒）
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `relay` | `true` | 关掉之后 **不给 Chrome 加调试端口、不注入脚本** —— 更安全，但也没有划词接力 |
| `relayPrefix` | 见上 | 注入到输入框的前缀。**必须与网页端脚本一致**（两处都改了才不会重复叠加） |
| `relayMaxChars` | `2000` | 单次内容上限，两端都会截断。改大请同步注意卡顿风险 |
| `relayAppendMode` | `replace` | **覆盖**（默认）或**追加**。追加会自动带上限与"读回归一"，但仍比覆盖慢 |
| `draftMaxChars` | `6000` | 追加模式下草稿的总长上限，超出裁掉最老内容 |
| `ackTimeoutMs` | `15000` | 网页端等回执上限。DSH 侧轮询 800ms，留足余量避免误报失败 |

> 已移除的旧配置：`relayButtonText` / `relayBodySelector` / `relayIncludeThread`
> —— v1.4.1 起改为「划词即传」，不再给每条回复挂按钮，也不再抓整段对话。

### B.5 行为细节

- **写入方式由 `relayAppendMode` 决定。** 默认**覆盖**：输入框里永远只有最新这一条；
  设为 `append` 才是"追加在你原有内容后面"（并受 `draftMaxChars` 约束）。
- **前缀只出现一次。** 网页端把前缀贴在正文同一行；宿主侧 `stripRelayPrefixes()`
  会剥掉任意已知前缀后**保证每块恰好一个前缀**（历史上两端文案不一致时会出现"大量空白"，
  已修）。块与块之间只用一个换行 —— Lexical 里换行 = 新段落，插空行会视觉上成片。
- **自动唤起 DSH。** 内容一到，宿主就立刻把 DSH 窗口拉到前台。
  Windows 有「前台锁」，后台进程直接 `SetForegroundWindow` 会被拒（实测返回 `False`），
  所以这里复用了 DSH 自己的原生目录选择器也在用的办法：**先合成一次 Alt 按键**
  再置前（实测 `True`）。窗口靠标题 `DSH - <实例名>` 认。
- **失败的反馈是友好的**：抓不到文字、没有可用输入框、结构变了 —— 都会在 DSH 右下角
  弹一条几秒后自动消失的提示，不会崩、不会静默。

### B.6 已知限制

1. **需要开着会话。** 输入框（以及我们能拿到 `setDraft` 的时机）都要有 session 作用域；
   没开会话时点接力，会提示「先在 DSH 里打开一个会话」。
2. **首次升级后要重开一次 DeepSeek 窗口。** 升级前打开的窗口没有调试端口，
   宿主连不进去；关掉重开即可（登录态不受影响）。宿主也提供了
   `POST /dsh-deepseek-chat/reattach` 尝试自动找回端口（v1.7.0 起界面上没有入口，
   只能自己调这个接口看返回）。
3. **调试端口是本机回环、无鉴权的。** 这是 CDP 的固有性质：本机上的其它程序理论上
   也能连上这个端口操作那个浏览器窗口（而里面是你的 DeepSeek 登录态）。
   端口是每次随机分配的。**介意的话把 `relay` 设为 `false`**，
   插件就不会加调试端口。
4. **Markdown 是「尽力还原」。** 代码块（`<pre>`）、列表、标题、加粗、链接会保住；
   表格、复杂嵌套会退化成纯文本。原文可以在网页端对照。
5. **轮询间隔 800ms。** 接力从"网页端发出"到"写进 DSH 输入框"实测约 **110ms**（本机）；
   网页端等回执的上限是 `ackTimeoutMs`（默认 15 秒），超时才会兜底写剪贴板。
6. **不要同时跑两个实例。** 插件按"该 profile 的 Chrome 进程"识别窗口，
   同一个实例 Home + 同 profile 起两个进程会**互抢同一个 DeepSeek 窗口**，
   表现为"窗口开着却报没有调试端口"。
7. **自检文件是全机器共用的**（`%TEMP%\dsh-deepseek-chat-status.json`），
   多个实例会互相覆盖 —— 不能用它区分实例。

### B.7 我实测验证到哪一步了

> 下面的表是 **v1.4.1 之前**（"每条回复挂按钮"设计）的验证记录，保留作历史。
> **v1.6.0 的验证记录见本节末尾的第二张表。**

| 环节 | 怎么验的 | 结果 |
|---|---|---|
| CDP 连接 + 注入 | 真实 Chrome + 真页面 | ✓ |
| 页面向宿主回传 | `Runtime.addBinding` 回调 | ✓ |
| 按钮注入 + **MutationObserver** | 造了个带 `ds-markdown` 的假页面，含 3 秒后动态追加的第 3 条 | ✓ **3 个按钮都挂上了** |
| 抓的是「那一条」 | 点第 2 个按钮 | ✓ 抓到的正是第 2 条 |
| Markdown 转换 | 假页面里放 `<ul><li>` | ✓ 转成了 `- 甲项 / - 乙项` |
| 写进 DSH 输入框 | 桩件驱动 client.js，断言 `setDraft` 的入参 | ✓ 前缀正确、**已有草稿不被覆盖** |
| 错误处理 | 喂一条 error 条目 | ✓ 出提示、不误写输入框 |
| 窗口唤起 | 真窗口 + 合成 Alt | ✓ `SetForegroundWindow=True` |
| 接力桥拿到 `inputActions` | 需要真实会话才能验（建工作区要弹系统目录框，自动化不了） | ⚠️ **未实测**，靠 DSH 类型契约；一旦不符会在提示和诊断文件里看得见 |
| 真实 DeepSeek 回复的 DOM | 需要登录态 | ⚠️ **未实测**，见 B.3 的多级策略与诊断 |

#### v1.6.0 的验证记录（当前设计：划词即传）

| 环节 | 怎么验的 | 结果 |
|---|---|---|
| 空值/异常不崩 | 从**已部署文件**里抠出真函数跑断言 | ✓ `null`/`undefined`/`0`/`{}` 均不抛错、返回字符串 |
| 双向前缀去重 | 同上，含 1/2/3 层前缀与历史文案 | ✓ 17/17 通过，正文不误伤 |
| 写入规模恒定（覆盖模式） | 同上，模拟 10 轮接力 | ✓ 每轮长度完全相同（184 字），不再累积 |
| 追加模式上限 | 同上，模拟 30 轮 | ✓ 184 → 5549，受 6000 上限约束 |
| 截断 | 同上，4000/9999 字输入 | ✓ 硬截断到 2000 字，保留前 2000 |
| 真实页面 24 项矩阵 | 经 `/inject` → CDP → 真实 `chat.deepseek.com` → 读回断言 | ✓ 24/24（NBSP、CRLF、裸 CR、空白行、Emoji、代码块、表格） |
| B→A 真通道 | 页面造选区 → 点气泡 → 从宿主队列读回 | ✓ 内容干净、连续空行 ≤1 |
| 连点 5 次 | 真实点击 | ✓ 只发出 1 条（按钮禁用生效） |
| 崩溃检查 | CDP 监听 uncaught + Log.error 全程 | ✓ 0 条；Crashpad 0 报告 |
| 回执被丢弃（误报失败） | 真机实测 | ✓ 已定位并修复（宿主回执推迟 250ms） |
| CDP 通道僵死 | 真机实测 + 对照实验 | ✓ 已定位并修复（超时→重连→重试一次） |
| 「超时→重连」分支本身 | 造不出真实僵尸 socket | ⚠️ **未直接复现**；失败时降级干净（1ms 返回"CDP 未连接"） |

---

## 附录 C：试验品实例上的安全改动与回滚方案

这份附录是给「在 `D:\dshl` 试验品实例上试新版本」这个场景写的。

### C.1 为什么最坏也不会「整个实例起不来」

| 部位 | 出错会怎样 | 会不会导致 DSH 起不来 |
|---|---|---|
| `index.js`（宿主半边） | 整个 `apply()` 包在 try/catch 里，异常只记日志 | **不会**。最坏是插件静默失效，DSH 本体照常 |
| `cordis.patch.yml` | 格式必须是顶层 YAML 数组，写错会在启动时**直接报错** | **会**（这是启动期解析）。但改错了删掉这行就恢复 |
| `client.js`（浏览器半边） | 它被编进启动 combo bundle。**如果有语法错误，整段 bundle 会中断**，首页可能显示 `Failed to load plugins` | UI 会坏，但**进程仍然启动**；换回文件 + 硬刷新即可恢复 |
| `page-script.js` | 只注入到 Chrome 窗口，与 DSH 无关 | 完全不影响 |

所以**唯一会让你看到白屏的是 `client.js`**。改完先做一次语法检查再部署：

```powershell
node --check D:\dshl-plugins\dsh-deepseek-chat\client.js
node --check D:\dshl-plugins\dsh-deepseek-chat\index.js
node --check D:\dshl-plugins\dsh-deepseek-chat\page-script.js
```

（我这边每次改完都会先跑这三条再验证。）

### C.2 回滚锚点在哪

每次动手前我都会整包备份一份。现在有两个锚点：

| 锚点 | 内容 | 用途 |
|---|---|---|
| `D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-truncate-20260927-184959\` | 更早的回滚锚点（v1.5.1 + 截断修复） | 最大的回退步：连「接力」功能一起退掉 |
| `D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-ackfix-20260927-193020\` | 本轮修复前的完整快照（v1.5.1 基线 + 截断修复） | 以后改动出问题时，退回到「已知良好」的当前状态 |

另外桌面上的发布包 `dsh-deepseek-chat-v1.0.0-20260929.zip` 永远是最新发布包。

> ⚠️ **如实说明**：v1.2.0 这一版我没有单独留快照（当时直接在其上继续改了），
> 所以「只退到 v1.2.0」这个粒度做不到，可用的最近锚点是 v1.1.0。
> 从 v1.3.0 起我每版都单独留 GOOD 快照。

### C.2b 「只回退本次 UI 改动」怎么做

**v1.2.0 → v1.3.0 这一轮只改了 `client.js` 一个文件**（`index.js` 一个字节都没动）。
所以如果你只想撤销这一轮的 UI 调整，替换这一个文件即可，而且**不用重启实例**：

本轮 `client.js` 里改的是这四处（想手动撤回可以照这个清单逐条还原）：

| # | 位置 | 改了什么 |
|---|---|---|
| 1 | CSS `.dsw-item-desc` | `white-space:nowrap` + `ellipsis` → **`white-space:normal` + `overflow-wrap:anywhere`**（让长描述换行，不再被截成 `…`） |
| 2 | CSS `.dsw-item-mark` / 新增 `.dsw-logo` | 图标尺寸收到 CSS 一处定义：`.dsw-item-mark .dsw-logo{width:18px;height:18px}` |
| 3 | 新增 `tightViewBox()` | 用 `getBBox()` 现算路径的紧致包围盒当 viewBox，让两个鲸鱼**画出来一样大**（原来 DSH 是 7.41×5.45、DeepSeek 是 11.8×8.73） |
| 4 | `toggle()` 里的定位 + 菜单内联样式 | 尺寸/坐标改成**对齐侧边栏**（`left = 侧边栏.left+8`，`width = 侧边栏.width-16`），并加 `maxHeight` |

对应的验证命令（不依赖肉眼看）：

```powershell
# 1) 语法
node --check D:\dshl-plugins\dsh-deepseek-chat\client.js

# 2) 装回 GOOD 快照（如果要退）
Copy-Item 'D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-ackfix-20260927-193020\client.js' `
          'D:\dshl-plugins\dsh-deepseek-chat\client.js' -Force
# 然后 Ctrl+Shift+R 硬刷新即可（客户端半边热加载）
```

### C.3 按症状选恢复方式

#### 情况 A：DSH 界面白屏 / 提示 "Failed to load plugins"

**起因一定是 `client.js`。** 只换回这一个文件就够（客户端半边是热加载的，**不用重启实例**）：

```powershell
Copy-Item 'D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-truncate-20260927-184959\client.js' `
          'D:\dshl-plugins\dsh-deepseek-chat\client.js' -Force
```

然后在 DSH 窗口按 **Ctrl+Shift+R** 硬刷新。

> 如果刷新后还是白屏，说明浏览器缓存了旧 bundle：把窗口彻底关掉（在启动器里停止实例）
> 再启动一次即可。

#### 情况 B：界面正常，但功能报错 / 窗口打不开

**起因是 `index.js`。** 换回它并**重启实例**（宿主半边不热更新）：

```powershell
Copy-Item 'D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-truncate-20260927-184959\index.js' `
          'D:\dshl-plugins\dsh-deepseek-chat\index.js' -Force
```

#### 情况 C：连实例都启动不了

**起因是 `cordis.patch.yml` 被改坏。** 直接把插件行注释掉（这样就完全不加载本插件）：

```yaml
# - insert:
#     - id: dsh-deepseek-chat
#       name: dsh-deepseek-chat
```

重启实例。想恢复就把 `#` 去掉。

> 这是**最快、最不依赖其它东西**的开关，建议出任何说不清的问题时先用它，
> 把插件摘出去确认「问题是不是本插件引起的」。

#### 情况 D：想一键完全撤销安装

```powershell
powershell -ExecutionPolicy Bypass -File D:\dshl-plugins\dsh-deepseek-chat\uninstall.ps1 -DshHome D:\dshl
```

它会**先**从 `dsh.profile.bundles` 摘掉包名、**再**删掉 node_modules 联接（顺序很重要）。重启即彻底不加载。

#### 情况 E：想整包回到 v1.1.0

```powershell
$bak = 'D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-truncate-20260927-184959'
Copy-Item "$bak\*" 'D:\dshl-plugins\dsh-deepseek-chat\' -Recurse -Force
```

然后重启实例（因为 `index.js` 也回退了）。

### C.4 怎么验证改动是否生效

#### 1）最直接：看界面

启动 → **Ctrl+Shift+R** → 看左侧边栏的面板列表（「扩展管理 / 定时任务 / IM」那一列）：

| 要看的 | 期望 |
|---|---|
| 菜单项 | 这一列里多出 **DeepSeek chat** 一行 |
| 文案 | **DeepSeek chat**（没有空格） |
| 图标 | 自绘的「对话气泡 + 折线」轮廓，颜色跟随主题 |
| 点一下 | 右下角弹 `正在打开…` → `窗口已就绪` 提示；窗口被打开或切到前台 |

#### 2）看诊断文件（不依赖肉眼）

```powershell
Get-Content "$env:TEMP\dsh-deepseek-chat-status.json"
```

关注 `registered` 与 `diag`。**每次插件加载都会重写这个文件**，所以它一定是本次的结果。

#### 3）重复点击验证「不再新开」（改动 #3）

1. 点左侧边栏的 **DeepSeek chat** → 应该开出一个窗口
2. **把这个窗口拖到别的窗口后面**（或用别的窗口挡住它）
3. 再点左侧边栏的 **DeepSeek chat**
4. **期望**：窗口被**切到前台**（不是又冒出一个新的）；任务栏里应该只有一个 DeepSeek 窗口

也可以直接问宿主：

```powershell
# 期望看到 via 有值、open=true；连点几次 pids 不应该增长
Invoke-RestMethod 'http://127.0.0.1:3080/dsh-deepseek-chat/state'
```

`via` 的含义：`cdp-port` = 靠调试端口认定存在（最快）；`process-scan` = 靠查进程认定；
`none` = 判定为没有窗口。

### C.5 出错时请给我这些

1. **F12 控制台**的完整报错（红字那段，含 `at ...` 堆栈）
2. `%TEMP%\dsh-deepseek-chat-status.json` 的内容
3. 启动器日志尾部：
   ```powershell
   Get-Content "$env:APPDATA\io.github.baihejiangnan.dsh-launcher\logs\desktop.log" -Tail 40
   ```
4. 如果是白屏，告诉我**首页显示的是空白还是 `Failed to load plugins`** —— 这两个指向不同的原因

---

## 附录 D：第一阶段 —— A→B 划词互传（🐋 传给Chat）

在 DSH 里选中一段文字，选区上方冒出一个小气泡「🐋 传给Chat」，
点它就把文字（带前缀 `【来自 DSH 上下文】`）注入到 **DeepSeek chat 网页端的输入框**，
并把网页端窗口切到前台。

### D.1 先说 Tauri IPC：这里同样用不了

需求写的是「通过 Tauri 的 IPC (emit) 发送给主进程」。**这条链路不存在**，理由和附录 B.1 一模一样：

1. DSH 插件体系里**没有 Tauri 层**（DSH 0.1.5-rc.3 全部代码搜不到 `tauri`）；
2. 那个网页端窗口是**独立 Chrome 进程**，不是 Tauri webview，`emit` 出去没人收。

所以复用了附录 B 已经建好的**同一套 CDP 通道**，只是方向反过来：

```
DSH 划词气泡（client.js）
   │ POST /dsh-deepseek-chat/inject { text }
   ▼
宿主半边（index.js）→ CDP Runtime.evaluate
   ▼
网页端 page-script.js 的 window.__dshInjectText(text)
   │ 写进底部输入框（textarea / contenteditable）
   ▼
宿主再把网页端窗口切到前台（合成 Alt 解前台锁）
   │
   └─ 失败则兜底：把内容写进系统剪贴板 + 提示「请手动粘贴」
```

### D.2 改了哪几个文件

| 文件 | 改了什么 |
|---|---|
| `client.js` | ① 新增**划词气泡**（挂在 root 的 `shell.overlay`）② `readSelection()` / `sendSelectionToChat()` ③ 新增 CSS `.dsw-bubble` ④ 新增配置 `transferPrefix` |
| `index.js` | ① 新增路由 `POST /dsh-deepseek-chat/inject` ② 新增 `cdpEvaluate()`（把 CDP `send` 暴露出来）③ 新增 `copyToClipboard()` 兜底 ④ 新增配置 `transferPrefix` |
| `page-script.js` | 新增 `window.__dshInjectText(text)` —— 找输入框、写值、派发 input 事件 |

**没动**：`package.json` 的运行时契约、`cordis.patch.yml` 的结构、任何 DSH 原有代码。

### D.3 两个关键实现细节

#### ① 气泡挂在 **root** 而不是 session 作用域

你现在的试验品实例**一个工作区都没有**（`storages/workspace.json` 里 `workspaces: {}`）。
如果气泡挂在 session 作用域（像 B→A 的接力桥那样），没会话时**整个组件都不会渲染**，
气泡自然也不会出现。而气泡其实不需要 DSH 的输入框 —— 它只往宿主发请求。

所以气泡挂在 **`shell.overlay`**（`kind:"list"` + `scope:"root"`，框架级浮层），
没会话也能用。实测就是在「无工作区」的实例上验过的。

#### ② ⚠️ list 类 slot 注册**必须带 `id`**（重要，之前踩过）

SlotCore 源码里 list 分支是硬校验：

```js
case "list": {
  if (t.id === undefined) throw new Error(`list slot "${t.name}" requires options.id`);
  ...
}
```

**这个坑之前一直存在**：B→A 的接力桥注册在 `conversation.session.header.utilities`（也是 list slot），
没有带 `id` → 每次都抛 `requires options.id`，而异常被回调外的 try/catch 吞掉，
看起来却「注册成功」了。**换句话说，接力桥之前从来没真正挂上过。**
现在两个 list slot 都补了 `id`，而且注册成功与否**只在回调里记**，不再把失败当成功：

```js
ctx.slots.register({ name: 'shell.overlay', id: 'dsh-deepseek-chat-overlay' }, DshOverlay)
ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-deepseek-chat-bridge' }, RelayBridge)
```

顺手也加了挂载自检：浮层渲染时会写 `划词浮层已渲染（root / shell.overlay）` 到诊断文件，
DOM 里也留了一个 `[data-dsh-overlay]` 标记节点，一眼就能查它到底有没有挂上。

### D.4 注入的两种输入框，以及「不覆盖草稿」

`__dshInjectText` 按顺序找：

1. **`textarea`**（DeepSeek 底部输入框就是它）；
2. 兜底：可见的 **`contenteditable`**（用 `execCommand('insertText')`，让 Lexical 这类编辑器收到正规输入）。

写 `textarea` 时**必须走原生 value setter 再派发 `input` 事件** ——
直接 `el.value = x` 会被 React 的下一次渲染覆盖回去。

**写入方式由 `relayAppendMode` 决定**（v1.6.0 起默认 `replace` = 覆盖）：
- `replace`：`setDraft(本次内容)`，输入框里只留最新这一条；
- `append`：`原内容 + "\n" + 新内容`，并受 `draftMaxChars`（默认 6000）约束。
返回值里带 `appended: true/false`（仅 append 模式可能为 true）。

### D.5 配置项

```yaml
- insert:
    - id: dsh-deepseek-chat
      name: dsh-deepseek-chat
      config:
        transferPrefix: '【来自 DSH 上下文】\n\n'   # A→B 注入时加的前缀；填 '' 就不要
```

### D.6 怎么验证第一阶段是否成功

**前提**：网页端窗口得先开着（点左侧边栏的 **DeepSeek chat**）。没开的话气泡会明确提示你去开，
**不会**在后台偷偷给你开一个（这条专门测过）。

| 步骤 | 期望 |
|---|---|
| 1 | 在 DSH 里**拖选一段文字**（正文、侧边栏、随便哪里，只要不是输入框） | 选区上方冒出 **🐋 传给Chat** |
| 2 | 在输入框里划词 | **不冒**气泡（那是你自己的草稿） |
| 3 | 点气泡 | 网页端窗口跳到前台，**底部输入框里出现** `【来自 DSH 上下文】` + 你选的字 |
| 4 | 输入框里已经有字时再传一次 | 默认**覆盖**为最新一条（`relayAppendMode=replace`）；设为 `append` 才是追加 |
| 5 | 想看失败兜底 | 先把网页端窗口关掉，再点气泡 → 提示「窗口没开着」，**不会新开窗口** |

不想靠肉眼的话，两条命令就够：

```powershell
# ① 插件诊断：能看到 phase=a2b-inject 及其结果
Get-Content "$env:TEMP\dsh-deepseek-chat-status.json"

# ② 直接问宿主（text 换成你要测的内容）
Invoke-RestMethod 'http://127.0.0.1:3080/dsh-deepseek-chat/inject' -Method Post `
  -ContentType 'application/json' -Body '{"text":"【来自 DSH 上下文】\n\n测试"}'
```

第 ② 条的返回值含义：

| 返回 | 含义 |
|---|---|
| `{"ok":true,"how":"textarea"}` | 成功写进网页端输入框 |
| `{"ok":true,"how":"contenteditable"}` | 成功写进编辑器型输入框 |
| `{"ok":false,"reason":"no-window"}` | 网页端窗口没开着（**没有新建窗口**） |
| `{"ok":false,"reason":"inject-failed","copied":true}` | 没找到输入框 → 已兜底复制到剪贴板 |
| `{"ok":false,"reason":"empty"}` | 内容是空的 |

### D.7 我实测到什么程度

| 环节 | 结果 |
|---|---|
| `__dshInjectText` 注入到页面 | ✓ |
| **textarea 路径** | ✓ 内容+前缀确实写进了 textarea |
| **写入语义** | ✓ 默认覆盖、长度恒定；`append` 时受上限约束 |
| contenteditable 路径 | ✓ |
| **剪贴板兜底** | ✓ 注入失败后 `Get-Clipboard` 读回来正是那段文字 |
| 空文本 | ✓ 返回 `reason:"empty"` |
| **窗口关着时不新开窗口** | ✓ 返回 `no-window`，`/state` 确认没有后台新建 |
| 唤起网页端窗口 | ✓ 每次都 `FOCUS True` |
| **气泡出现/文案/尺寸** | ✓ 真实 DSH + 无工作区实例，`🐋 传给Chat` 96×28 浮在选区上方 |
| **输入框内划词不误触发** | ✓ |
| 点气泡 → 链路走通 | ✓ 出现 `no-window` 提示，气泡自动收起 |
| 真实 DeepSeek 输入框的 DOM | ⚠️ **未实测**（需要登录态）。但 textarea 是通用选择器，且注入失败会兜底剪贴板，不会静默 |

### D.8 回滚

本轮改了 **3 个文件**（`client.js`、`index.js`、`page-script.js`）。

- **只退本轮** → 用 `_backups` 里的快照覆盖这三个文件（`index.js` 和 `page-script.js` 也退回去），然后**重启实例 + 硬刷新**
- **白屏** → 只换 `client.js`，硬刷新即可恢复（不用重启）
- **彻底关掉** → 注释掉 `cordis.patch.yml` 里的 `insert:` 行，重启

```powershell
$bak = 'D:\dshl-plugins\_backups\dsh-deepseek-chat-BEFORE-ackfix-20260927-193020'
Copy-Item "$bak\*" 'D:\dshl-plugins\dsh-deepseek-chat\' -Recurse -Force
```

### D.9 第二阶段预告（等你确认第一阶段 OK 再做）

B→A 方向（网页端划词 → 注入 DSH 当前活跃会话）**基础其实已经具备**：

- 网页端 → 宿主的回传通道（CDP binding）已经在跑（接力用的就是它）；
- 宿主 → DSH 前端的推送通道（`/relay` 轮询）也在跑；
- DSH 输入框的官方写入接口 `inputActions.setDraft` 已经有桥在拿（本轮修好了它的 `id` bug）。

第二阶段主要要解决的是「**当前活跃会话**」的判定：需要确定用哪一个 session 的
`inputActions`（比如记录最近一次获得焦点的会话、或用 `document.activeElement` 推断），
避免写到别的会话里。这部分我会在拿到你第一阶段的反馈后再动手。
