/**
 * dsh-deepseek-chat —— 客户端半边（Client Half）
 *
 * v1.7.0 起，UI 是**左侧边栏的原生菜单项**（「扩展管理 / 定时任务 / IM」那一列）：
 *
 *   ┌──────────────────────────────┐
 *   │  🧩 扩展管理                  │
 *   │  ⏰ 定时任务                  │
 *   │  💬 DeepSeek chat          ← 注册在 sidebar.panellist
 *   └──────────────────────────────┘
 *            ↓ 点一下
 *   用 Chrome/Edge 以 --app= 打开独立窗口（登录态落盘），已开着就切回前台
 *
 * 本文件提供三处 UI：
 *   1. `sidebar.panellist`（kind:"list"）—— 左侧菜单项「DeepSeek chat」，点它打开网页端窗口；
 *   2. `shell.overlay`（root 作用域）—— 划词气泡「🐋 传给Chat」（A→B）；
 *   3. `conversation.session.header.utilities` —— 接力桥（B→A）。
 *
 * ⚠️ 旧版挂在 `sidebar.brand.name`（single slot，靠 priority 抢位）上的
 * 「顶部品牌行下拉切换器」已**整个删除**：那个 slot 位于官方「新建会话」按钮的子树里，
 * 桌面壳会把这一支隐藏（实测元素在 DOM 里、尺寸 0×0、display:none，内联样式 +
 * !important 都压不过），属结构性不可用。详见 CHANGELOG 的 v1.7.0 一节。
 *
 * 零构建：DSH 的 client module loader 提供 require 种子表，
 * react / @deepseek-ai/dsh-client-ui-primitives 直接 require 即可。
 *
 * 防污染：本文件里每一处外部依赖与注册都单独 try/catch。任何一处失败都只让
 * 「这一处」失效，不会抛到 combo bundle 上（那会导致排在后面的插件全部加载不了）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-chat',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    /**
     * UI 原语（FishLogo / BrandWordmark）。可选加载：缺了也不能让插件挂掉，
     * 退回纯文本品牌名即可。
     */
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (err) {
      primitives = null
    }

    const BASE = '/dsh-deepseek-chat'
    const STORAGE_KEY = 'dsh-deepseek-chat.mode'

    /** 两种模式。'dsh' = 正常用 DSH；'deepseek' = 独立窗口开网页端。 */
    const MODE_DSH = 'dsh'
    const MODE_WEB = 'deepseek'

    /**
     * 修复标记：事件隔离补丁（v1.4.1）。
     * 每次切换模式都会随诊断一起上报，落在 %TEMP%\dsh-deepseek-chat-status.json。
     * 有了它就能一眼确认"浏览器里跑的是不是修复版"，不用开 DevTools
     * （桌面壳 WebView2 默认没有 F12）。
     */
    const GUARD_ID = 'event-isolation-v1.4.1'

    // ─────────────────────────── 自诊断上报 ───────────────────────────
    // 桌面壳（WebView2）默认不开 F12，浏览器 devtools 用不了；而 slot 注册发生在
    // 浏览器侧，服务端日志看不见。所以把「加载了没有 / 注册结果」回传给宿主落盘。
    // 上报失败**绝不允许**影响插件本身。
    const DIAG = []

    function diag(msg) {
      try {
        DIAG.push(String(msg))
        if (DIAG.length > 60) DIAG.shift()
      } catch (err) {
        /* 忽略 */
      }
    }

    function reportStatus(extra) {
      try {
        const payload = {
          client: 'dsh-deepseek-chat',
          loaded: true,
          href: String(window.location.href || '').replace(/token=[^&]*/, 'token=***'),
          diag: DIAG.slice(),
        }
        if (extra) for (const k in extra) payload[k] = extra[k]
        // 同步 POST：必须在页面卸载/异常前送达
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${BASE}/status`, false)
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.send(JSON.stringify(payload))
      } catch (err) {
        /* 上报失败绝不影响插件 */
      }
    }

    /** 同步 GET 一个小 JSON；失败返回 null（不抛）。 */
    function getJson(path) {
      try {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', path, false)
        xhr.send(null)
        if (xhr.status >= 200 && xhr.status < 300) return JSON.parse(xhr.responseText)
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /** 异步 POST JSON；返回 Promise<object|null>，永不 reject。 */
    function postJson(path, payload) {
      return new Promise((resolve) => {
        try {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', path, true)
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.onload = () => {
            try {
              resolve(JSON.parse(xhr.responseText || '{}'))
            } catch (err) {
              resolve({ ok: xhr.status >= 200 && xhr.status < 300, detail: '响应无法解析' })
            }
          }
          xhr.onerror = () => resolve({ ok: false, detail: '请求失败（宿主路由不可达）' })
          xhr.send(JSON.stringify(payload || {}))
        } catch (err) {
          resolve({ ok: false, detail: String((err && err.message) || err) })
        }
      })
    }

    // ─────────────────────────── 配置快照 ───────────────────────────
    let config = {
      url: 'https://chat.deepseek.com',
      placement: 'over-dsh',
      sidebarInset: 268,
      gap: 10,
      minWidth: 520,
      minHeight: 460,
      browser: null,
      profileDir: '',
      // 上下文接力（宿主 config.json 会覆盖这几个默认值）
      relay: true,
      // ⚠️ 必须与宿主 index.js 的 DEFAULTS.relayPrefix **完全一致**：
      //    两边文案不同时，去重判断（"开头是不是我这条前缀"）永远不成立，
      //    结果每次接力都多贴一整块「前缀 + 空行」—— 现场就是「大量空白」。
      relayPrefix: '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】',
      // A→B（DSH 划词传给 Chat）用的前缀
      transferPrefix: '【来自 DSH 上下文】\n\n',
      relayButtonText: '↪ 转到 DSH 继续',
      relayBodySelector: '',
      relayIncludeThread: false,
      relayMaxChars: 2000,
      // 网页端脚本读的是这个名字（page-script.js 的 CFG.maxChars）。
      // 以前这里只有 relayMaxChars，导致网页端拿不到值、退回到 20000 的内置默认值 ——
      // 长文本一路灌进 DSH 输入框，就是「卡顿 + 大面积空白」的来源之一。
      maxChars: 2000,
    }
    const remote = getJson(`${BASE}/config.json`)
    if (remote && typeof remote === 'object') config = Object.assign(config, remote)
    diag('config.browser = ' + String(config.browser))
    diag('config.profileDir = ' + String(config.profileDir))

    // ─────────────────────────── 模式持久化 ───────────────────────────
    function readMode() {
      try {
        const v = window.localStorage.getItem(STORAGE_KEY)
        if (v === MODE_WEB || v === MODE_DSH) return v
      } catch (err) {
        /* 隐私模式等场景下 localStorage 可能不可用 */
      }
      return MODE_DSH
    }

    function writeMode(mode) {
      try {
        window.localStorage.setItem(STORAGE_KEY, mode)
      } catch (err) {
        /* 忽略 */
      }
    }

    // ─────────────────── 计算 DSH 窗口内容区矩形 ───────────────────
    /**
     * 给宿主用来把 DeepSeek 窗口摆到「DSH 窗口的内容区」上，
     * 视觉上就像嵌在 DSH 里。
     *
     * 坐标系与单位：CSS px。Chromium 的 --window-position / --window-size 用的
     * 也是 DIP，两者一致，不需要 DPR 换算。
     *
     * @returns {{x:number,y:number,w:number,h:number}|null} 内容区矩形。
     */
    function contentRect() {
      try {
        const ow = Number(window.outerWidth) || 0
        const oh = Number(window.outerHeight) || 0
        const iw = Number(window.innerWidth) || 0
        const ih = Number(window.innerHeight) || 0
        if (!iw || !ih) return null
        // 原生标题栏/边框占掉的量
        const chromeW = Math.max(0, ow - iw)
        const chromeH = Math.max(0, oh - ih)
        return {
          x: (Number(window.screenX) || 0) + chromeW / 2,
          y: (Number(window.screenY) || 0) + chromeH,
          w: iw,
          h: ih,
        }
      } catch (err) {
        return null
      }
    }

    // ─────────────────── 打开网页端：Tauri 快路径 + 兜底 ───────────────────
    /**
     * 如果启动器把 Tauri 的全局 JS API 暴露给了页面（withGlobalTauri），
     * 就用原生 WebviewWindow —— 集成度最高。
     *
     * 但请注意：DSH 本体并不依赖 Tauri（它要能跑在普通浏览器里），所以这条路
     * 大概率不存在。这里只是「有就用，没有就换路」，不影响功能。
     *
     * @returns {{ok:boolean, detail:string}|null} null 表示这条路不可用。
     */
    function tryTauriOpen() {
      try {
        const t = window.__TAURI__
        const api = t && t.webviewWindow
        const WW = api && api.WebviewWindow
        if (typeof WW !== 'function') return null
        const existing = typeof api.getByLabel === 'function' ? api.getByLabel('deepseek-chat') : null
        if (existing) {
          if (typeof existing.setFocus === 'function') existing.setFocus()
          return { ok: true, detail: '已聚焦既有的 Tauri 窗口' }
        }
        // eslint-disable-next-line no-new
        new WW('deepseek-chat', {
          url: config.url,
          title: 'DeepSeek',
          width: 1000,
          height: 760,
        })
        return { ok: true, detail: '已创建 Tauri WebviewWindow' }
      } catch (err) {
        return { ok: false, detail: 'Tauri 路径失败: ' + String((err && err.message) || err) }
      }
    }

    /**
     * 打开 DeepSeek 窗口。优先 Tauri，其次交给宿主半端起独立浏览器窗口。
     * @returns {Promise<{ok:boolean, detail:string, mode?:string}>} 结果。
     */
    async function openWeb() {
      const tauri = tryTauriOpen()
      if (tauri && tauri.ok) {
        diag('open: tauri 路径成功')
        return tauri
      }
      if (tauri) diag('open: ' + tauri.detail + ' → 回退到独立浏览器窗口')

      const rect = contentRect()
      const result = await postJson(`${BASE}/open`, { rect })
      diag('open -> ' + JSON.stringify(result))
      return result || { ok: false, detail: '宿主无响应' }
    }

    /** 关闭网页端窗口（切回 DSH 默认模式时调用）。 */
    function closeWeb() {
      return postJson(`${BASE}/close`, {})
    }

    // ─────────────────────────── 样式 ───────────────────────────
    const CSS = `
.dsw-brand{display:flex;align-items:center;gap:2px;min-width:0;flex:1}
/* ⚠️ 不能给 .dsw-brand-identity 加 flex:1 / overflow:hidden：开关按钮现在放在它内部，
   overflow:hidden 会把按钮裁掉。让它按内容取自然宽度。 */
.dsw-brand-identity{display:flex;align-items:center;gap:6px;min-width:0}
/* 旧的顶部开关按钮样式：v1.7 起已不再渲染（改由左侧边栏原生菜单项承担切换）。
   保留这几条只为兼容可能残留的旧节点，新代码不产生 .dsw-brand-toggle。 */
.dsw-brand-toggle{flex:none;display:flex!important;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#6b7280);transition:background .12s ease}
.dsw-brand-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07))}
.dsw-brand-toggle svg{transition:transform .15s ease}
.dsw-brand-toggle[data-open="1"] svg{transform:rotate(180deg)}
/* 左侧菜单项的图标：DSH 会把它放进自己的行按钮里，这里只保证可点、颜色跟随主题 */
.dsw-panel-glyph{display:inline-flex;align-items:center;justify-content:center;
  width:100%;height:100%;cursor:pointer;color:inherit}

/* 菜单：固定定位、贴着按钮正下方展开；宽度由 JS 按侧边栏宽度和视口宽度算好后内联给出，
   所以这里只兜底一个最小/最大值，并加上 max-height 防止在小窗口里竖向也溢出。 */
.dsw-menu{position:fixed;z-index:2147483000;min-width:200px;max-width:340px;
  max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;
  box-sizing:border-box;
  padding:5px;border-radius:10px;display:flex;flex-direction:column;gap:1px;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1b1f24);
  border:1px solid var(--dsw-alias-border-l2,#d7dbe0);
  box-shadow:0 12px 32px rgba(0,0,0,.18);
  font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}
.dsw-menu-label{padding:6px 10px 3px;font-size:11px;letter-spacing:.02em;
  color:var(--dsw-alias-label-tertiary,#8b95a5)}
.dsw-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;
  border:0;border-radius:7px;background:transparent;cursor:pointer;text-align:left;
  color:inherit;font:inherit}
.dsw-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsw-item[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsw-item-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsw-item-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 描述允许换行 —— 之前是 nowrap + ellipsis，长描述会被截成「登录态持久…」，
   看起来像被窗口切掉，其实是这里截的。 */
.dsw-item-desc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b95a5);
  white-space:normal;overflow-wrap:anywhere;line-height:1.45}
.dsw-item-check{flex:none;width:16px;display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-primary,#1b1f24)}
/* 图标槽固定 18×18；里面两个 logo 用同一个类，尺寸只在这一处定义，
   保证「完全一样大」，不会因为组件传参不同而不一致。 */
.dsw-item-mark{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center}
.dsw-logo{display:block;flex:none}
.dsw-item-mark .dsw-logo{width:18px;height:18px}

/* ── 划词气泡「🐋 传给Chat」：浮在选区正上方 ── */
.dsw-bubble{position:fixed;z-index:2147483002;transform:translate(-50%,-100%);
  padding:4px 11px;border-radius:999px;cursor:pointer;white-space:nowrap;user-select:none;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1b1f24);
  border:1px solid var(--dsw-alias-border-l2,#d7dbe0);
  box-shadow:0 6px 18px rgba(0,0,0,.16);
  font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif}
.dsw-bubble:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}

/* ── 上下文接力的小提示（浮动在右下角，几秒后自动消失）── */
.dsw-toast{position:fixed;right:20px;bottom:20px;z-index:2147483001;max-width:420px;
  padding:10px 14px;border-radius:10px;pointer-events:none;
  font:12.5px/1.6 system-ui,"Microsoft YaHei",sans-serif;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1b1f24);
  border:1px solid var(--dsw-alias-border-l2,#d7dbe0);
  box-shadow:0 10px 28px rgba(0,0,0,.18);word-break:break-word}
.dsw-toast[data-err="1"]{border-color:#e2a03f;color:#a05a00}
`

    let styleInjected = false
    function ensureStyle() {
      if (styleInjected) return
      styleInjected = true
      try {
        const el = document.createElement('style')
        el.setAttribute('data-dsh-deepseek-chat', '')
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (err) {
        /* 样式注入失败不影响功能，只是难看一点 */
      }
    }

    /** 勾选标记。 */
    function CheckIcon() {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M20 6L9 17l-5-5' }),
      )
    }

    /** 下拉箭头。 */
    function ChevronDown() {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M6 9l6 6 6-6' }),
      )
    }

    // ─────────────────── 官方品牌图标（均为真实 Logo 矢量） ───────────────────
    //
    // 两个图标都不是手画的，来源都可靠：
    //
    // 1) DSH 鲸鱼（黑）
    //    运行时从 DSH 自己的种子模块 @deepseek-ai/dsh-client-ui-primitives 读
    //    FISH_LOGO_PATH / FISH_LOGO_VIEWBOX —— 这与侧边栏品牌行 fallback 用的
    //    FishLogo 是**同一份官方路径**。取不到时回退到 DSH 自己的 favicon.svg
    //    （dsh-web-frontend/dist/favicon.svg，viewBox "0 0 50 50"）。
    //    填充用 currentColor：浅色主题下即黑色，深色主题下自动变白 —— 这正是
    //    DSH favicon 自身的做法，避免深色主题里黑鲸鱼看不见。
    //
    // 2) DeepSeek 鲸鱼（蓝）
    //    官方 DeepSeek 图标，品牌蓝 #4D6BFE。固定品牌色，不跟随主题。
    //    矢量来源：Wikimedia Commons "Deepseek-logo-icon.svg"（CC0 公有领域，
    //    https://commons.wikimedia.org/wiki/File:Deepseek-logo-icon.svg ）。
    //    这里只取鲸鱼本体那一条 path，去掉了原图的白底圆角方块，
    //    这样在深色主题下也不会出现一块白底。
    const DSH_WHALE_FALLBACK_PATH =
      'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'
    const DSH_WHALE_FALLBACK_VIEWBOX = '0 0 50 50'

    const DEEPSEEK_WHALE_PATH =
      'M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z'
    const DEEPSEEK_WHALE_VIEWBOX = '0 0 512 509.64'
    const DEEPSEEK_BRAND_BLUE = '#4D6BFE'

    // ── 把图标放大到「填满自己的框」──
    //
    // 实测过的问题：两个图标给的都是 width/height=16 的正方框，但**画出来的实际大小差 1.6 倍**：
    //   DSH 鲸鱼   viewBox "0 0 50 50"，而路径包围盒只有 23.16×17.04，还画在左上角
    //              → 换算到屏幕上只有 7.41×5.45 px
    //   DeepSeek   viewBox "0 0 512 509.64"，路径包围盒 377.72×277.97
    //              → 屏幕上是 11.8×8.73 px
    //
    // 解法：不用别人给的 viewBox，而是**把 viewBox 设成路径自己的紧致包围盒**。
    // 这样两条鲸鱼都会填满同一个正方框；而且巧的是它俩本来就是同一条鲸鱼，
    // 长宽比几乎一致（1.359 vs 1.359），所以缩放后**大小完全相同**。
    //
    // 包围盒用 SVG 自己的 getBBox() 现算一次（结果缓存），不写死数字 ——
    // 将来 DSH 换了路径也不用改这里。
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const tightBoxCache = new Map()

    /**
     * 求一条 SVG path 的紧致包围盒，返回可直接当 viewBox 用的字符串。
     * @param {string} d 路径数据。
     * @param {string} fallback 算不出来时的兜底 viewBox。
     * @returns {string} "x y w h"。
     */
    function tightViewBox(d, fallback) {
      if (tightBoxCache.has(d)) return tightBoxCache.get(d)
      let vb = fallback
      try {
        const svg = document.createElementNS(SVG_NS, 'svg')
        svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none')
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
        document.body.appendChild(svg)
        const bb = path.getBBox()
        document.body.removeChild(svg)
        if (bb && bb.width > 0 && bb.height > 0) {
          vb = bb.x + ' ' + bb.y + ' ' + bb.width + ' ' + bb.height
        }
      } catch (err) {
        /* 算不出来就用兜底 viewBox（至少不会崩） */
      }
      tightBoxCache.set(d, vb)
      return vb
    }

    /** 两个图标共用的边长（保证「完全一样大」只有一个来源）。 */
    const LOGO_SIZE = 18

    /** DSH 官方鲸鱼（黑）：优先用运行时种子模块里的官方路径，取不到就用 favicon 兜底。 */
    function DshWhaleLogo(props) {
      const size = (props && props.size) || LOGO_SIZE
      const p =
        (primitives && typeof primitives.FISH_LOGO_PATH === 'string' && primitives.FISH_LOGO_PATH) ||
        DSH_WHALE_FALLBACK_PATH
      return React.createElement(
        'svg',
        {
          className: 'dsw-logo',
          width: size,
          height: size,
          viewBox: tightViewBox(p, DSH_WHALE_FALLBACK_VIEWBOX),
          preserveAspectRatio: 'xMidYMid meet',
          fill: 'currentColor',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: p }),
      )
    }

    /** DeepSeek 官方鲸鱼（品牌蓝 #4D6BFE）：固定品牌色，不跟随主题。 */
    function DeepSeekWhaleLogo(props) {
      const size = (props && props.size) || LOGO_SIZE
      return React.createElement(
        'svg',
        {
          className: 'dsw-logo',
          width: size,
          height: size,
          viewBox: tightViewBox(DEEPSEEK_WHALE_PATH, DEEPSEEK_WHALE_VIEWBOX),
          preserveAspectRatio: 'xMidYMid meet',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: DEEPSEEK_WHALE_PATH, fill: DEEPSEEK_BRAND_BLUE }),
      )
    }

    // ─────────────────── 上下文接力：接收 + 写进输入框 ───────────────────
    //
    // 链路：网页端点按钮 → CDP → 宿主半边入队 → 这里每 1.5 秒取走 → setDraft
    //
    // ⚠️ 为什么不直接改输入框的 DOM：
    // DSH 的输入框是 Lexical 富文本编辑器，直接改 DOM 会被它下一次渲染冲掉。
    // 官方给**每个 session 作用域组件**提供了一个动作面 InputActions，里面的
    // setDraft(text) 就是「程序化写草稿」的正路。
    //
    // 挂载点选 `conversation.session.header.utilities`：它是 kind:"list" 的
    // session 作用域 slot —— list 是「追加」语义，不会顶掉别人的东西
    // （对比：sidebar.brand.name 是 single，必须靠 priority 抢）。

    /** DSH 官方输入动作面（含 setDraft）。由 RelayBridge 在渲染时抓住。 */
    let sessionInput = null
    /** 只上报一次「桥上到底收到了什么 props」，用于确认 DSH 是否真给了 inputActions。 */
    let relayPropsLogged = false

    // 极小的 toast 订阅器：让提示能在任意时刻冒出来，不必把状态挂在组件树上
    let toastValue = null
    const toastSubs = new Set()

    function showToast(text, isError) {
      try {
        const mine = { text: String(text), isError: Boolean(isError) }
        toastValue = mine
        for (const fn of toastSubs) {
          try {
            fn(mine)
          } catch (err) {
            /* 忽略 */
          }
        }
        window.setTimeout(() => {
          if (toastValue === mine) {
            toastValue = null
            for (const fn of toastSubs) {
              try {
                fn(null)
              } catch (err) {
                /* 忽略 */
              }
            }
          }
        }, 4500)
      } catch (err) {
        /* 提示失败不影响主流程 */
      }
    }

    // ─────────────────── A→B：DSH 划词 → 传给 Chat ───────────────────
    //
    // 交互：在 DSH 里选中一段文字、松开鼠标 → 选区上方冒一个小气泡
    //       「🐋 传给Chat」→ 点它 → 带前缀发给宿主 → 宿主经 CDP 注入网页端输入框，
    //       并把网页端窗口切到前台。注入失败则兜底复制到剪贴板。

    // ─────────────────── 文本清洗（与 page-script.js 里那份**必须一致**）───────────────────
    //
    // 现场问题：划词带走的内容混着 不间断空格(U+00A0)、字面量 `&nbsp;`、CRLF、
    // 以及一大串连续换行；注入到对方输入框后变成「特别大且不正常的空格」。
    //
    // ⚠️ 顺序不能换：先把 CRLF/CR 归一成 \n，再压连续换行 ——
    //    否则 `\r\n\r\n\r\n` 匹配不上 /\n{3,}/，压缩会失效。
    // 📌 有意不动行内的多个普通空格（代码缩进 / markdown 对齐）。
    //
    // 🔒 安全约束（上一版把界面改死过，这一版必须守住）：
    //    · 任何文本进函数第一行先做类型判断，绝不出现 null.replace；
    //    · 整个清洗体包在 try/catch 里，出错就原样返回，绝不让异常冒到渲染路径；
    //    · 只用最简单的 /g 全局替换，无回溯、无循环、无状态，不可能死循环；
    //    · 返回的必然是字符串，调用方无需再判类型。
    const CLEAN_VERSION = 'clean-text-v3-trunc2000'
    /**
     * 互传文本的字符上限。**硬截断**：抓取到文本后立刻切掉超出部分。
     * 目的：任何一条互传内容都不会长到把 DSH 输入框 / IPC 拖死。
     */
    const TRANSFER_MAX_CHARS = 2000

    /**
     * DSH 输入框里草稿的**总长上限**。接力是「追加」语义，但没有上限时草稿会一直涨，
     * 而 DSH 输入框是随内容自动长高的 —— 长到一定程度就把窗口顶满、滚不回去，
     * 用户看到的就是「输入框变得很大，恢复不了」。超过这个上限时从头裁掉最老的内容，
     * 永远保住最新一条接力。
     */
    const DSH_DRAFT_MAX = 6000

    /**
     * 安全清洗「互传文本」：把所有会显示成「异常大空格」的字符归一到普通字符。
     * 抓取（划词）后与注入（写输入框）前都必须过一遍；本函数幂等，重复调用无害。
     *
     * @param {string} text 待清洗文本。
     * @returns {string} 清洗后的字符串（已截到 TRANSFER_MAX_CHARS 以内；入参非法返回 ''，绝不抛错）。
     */
    function safeCleanText(text) {
      // 1) 第一行就挡空值：绝不允许 null.replace / undefined.replace 冒到全局
      if (!text || typeof text !== 'string') return text || ''
      // 2) 立刻硬截断到 2000 字（在清洗之前做，后面的活儿永远只处理短文本）
      const cut = text.length > TRANSFER_MAX_CHARS ? text.slice(0, TRANSFER_MAX_CHARS) : text
      try {
        let t = cut
        // 3) 所有换行风格先归一成 LF（必须最先做）
        t = t.replace(/\r\n/g, '\n') // Windows 换行 → LF
        t = t.replace(/\r/g, '\n') // 裸 CR（Mac / 站点自定义换行）→ LF
        // 4) 会显示成「大空格」的各种空白字符
        t = t.replace(/\u00A0/g, ' ') // 不间断空格 NBSP → 普通空格
        t = t.replace(/&nbsp;/g, ' ') // 字面量 HTML 实体 → 普通空格
        t = t.replace(/[\u200B\uFEFF]/g, '') // 零宽空格 / BOM → 删掉（v1 就有，别丢）
        // 5) 行尾空白：行尾的空格/制表符在输入框里就是「看不见的空档」
        t = t.replace(/[ \t]+\n/g, '\n')
        // 6) 连续 3 个以上换行 → 2 个（巨大空白的直接元凶）
        t = t.replace(/\n{3,}/g, '\n\n')
        // 7) 去掉首尾无用空白
        return t.trim()
      } catch (e) {
        // 清洗失败就原样返回（注意返回的是**已截断**的 cut）：
        // 宁可留一点空格，也绝不让页面报错/卡死，更不能把超长文本放回去。
        console.error('清洗失败', e)
        return cut
      }
    }

    /** 兼容旧名：本文件内所有调用点都指向同一份安全清洗。 */
    const cleanTransferText = safeCleanText

    /**
     * 读取当前选中的纯文本，并算出气泡该出现在哪；没有有效选区就返回 null。
     * @returns {{text:string,left:number,top:number}|null} 气泡数据。
     */
    function readSelection() {
      try {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
        // 只认 toString()：绝不碰 innerHTML / cloneContents（那会把标签和实体带出来）
        const text = safeCleanText(sel.toString())
        if (!text) return null

        const anchor = sel.anchorNode
        const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement)
        if (el && el.closest) {
          // 别在自己的菜单/气泡/提示里冒气泡
          if (el.closest('.dsw-menu,.dsw-bubble,.dsw-toast')) return null
          // 也别在输入框里冒 —— 那是用户自己的草稿，不是要传出去的上下文
          if (el.closest('textarea,input,[contenteditable="true"]')) return null
        }

        const rect = sel.getRangeAt(0).getBoundingClientRect()
        if (!rect || (!rect.width && !rect.height)) return null

        const vw = window.innerWidth || 1024
        // 气泡以选区水平中心为锚点，并夹进视口，避免贴边被切
        const left = Math.max(60, Math.min(Math.round(rect.left + rect.width / 2), vw - 60))
        const top = Math.max(30, Math.round(rect.top - 4))
        return { text: text, left: left, top: top }
      } catch (err) {
        return null
      }
    }

    /**
     * 把选中的文字（带前缀）发给宿主，由宿主注入网页端输入框。
     * @param {string} text 选中的纯文本。
     * @returns {Promise<void>} 完成。
     */
    async function sendSelectionToChat(text) {
      // 二次清洗（幂等）：readSelection 已经洗过，这里兜住任何别的调用点
      const body = safeCleanText(text)
      if (!body) return
      const prefix = String(config.transferPrefix || '')
      try {
        showToast('正在发送到 DeepSeek chat…')
        const r = await postJson(BASE + '/inject', { text: prefix + body })
        diag('A→B inject -> ' + JSON.stringify(r))
        reportStatus({ phase: 'a2b-inject', chars: body.length, clean: CLEAN_VERSION, result: r || null })

        if (r && r.ok) {
          showToast(
            '已填入 DeepSeek chat 的输入框' + (r.how ? '（' + r.how + '）' : '') + '，可以改了再发。',
          )
        } else if (r && r.reason === 'no-window') {
          showToast(r.detail, true)
        } else if (r && r.copied) {
          showToast('自动填入失败，内容已复制到剪贴板，请手动前往网页端粘贴。', true)
        } else {
          showToast('自动填入失败：' + ((r && r.detail) || '未知原因'), true)
        }
      } catch (err) {
        showToast('发送失败：' + String((err && err.message) || err), true)
      }
    }

    /**
     * 根作用域的浮层：只画两样东西 —— 划词气泡和偶发提示。
     *
     * 为什么挂在 root（`shell.overlay`）而不是 session 作用域：
     * 气泡只是「选中文字 → 发给宿主」，**不需要 DSH 的输入框**，
     * 所以没开会话时也应该能用（比如选一段欢迎页/侧边栏的文字发过去）。
     * 挂在 session 作用域的话，没有工作区/会话时整个组件都不会渲染，气泡也就没了。
     */
    function DshOverlay() {
      ensureStyle()
      const [toast, setToast] = React.useState(null)
      // A→B 划词气泡：{ text, left, top } 或 null
      const [bubble, setBubble] = React.useState(null)
      const [mounted, setMounted] = React.useState(false)

      React.useEffect(() => {
        // 挂载自检：写进诊断文件，这样「浮层到底渲染了没有」一读便知
        setMounted(true)
        diag('划词浮层已渲染（root / shell.overlay）')
        reportStatus({ phase: 'overlay-rendered' })
      }, [])

      React.useEffect(() => {
        const fn = (v) => setToast(v)
        toastSubs.add(fn)
        if (toastValue) setToast(toastValue)
        return () => {
          toastSubs.delete(fn)
        }
      }, [])

      // ── A→B：监听划词，松开鼠标后在选区上方冒气泡 ──
      React.useEffect(() => {
        function onUp() {
          // 等一拍再读，避免拿到「鼠标刚松开」时的临时选区
          window.setTimeout(() => setBubble(readSelection()), 10)
        }
        function onDown(ev) {
          // 点气泡本身时不要收起它（否则点不到）
          const t = ev.target
          if (t && t.closest && t.closest('.dsw-bubble')) return
          setBubble(null)
        }
        function onKey(ev) {
          if (ev.key === 'Escape') setBubble(null)
        }
        document.addEventListener('mouseup', onUp, true)
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mouseup', onUp, true)
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [])

      const bubbleEl = bubble
        ? React.createElement(
            'button',
            {
              className: 'dsw-bubble',
              type: 'button',
              title: '把选中的文字发到 DeepSeek chat 的输入框',
              style: { left: bubble.left + 'px', top: bubble.top + 'px' },
              // 阻止默认行为，避免点它时把选区清掉
              onMouseDown: (ev) => {
                ev.preventDefault()
                ev.stopPropagation()
              },
              onClick: (ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                sendSelectionToChat(bubble.text)
                setBubble(null)
              },
            },
            '🐋 传给Chat',
          )
        : null

      const toastEl = toast
        ? React.createElement(
            'div',
            { className: 'dsw-toast', 'data-err': toast.isError ? '1' : '0' },
            toast.text,
          )
        : null

      // 永远渲染一个不可见的标记节点：这样「浮层到底挂上了没有」可以直接从 DOM 查出来，
      // 不用靠猜。（shell.overlay 本身是 click-through 的，这个 display:none 的节点
      // 也不会接收任何指针事件。）
      const marker = React.createElement('span', {
        'data-dsh-overlay': '1',
        style: { display: 'none' },
      })
      return React.createElement(React.Fragment, null, marker, bubbleEl, toastEl)
    }

    /**
     * session 作用域的接力桥：**只做一件事** —— 抓住 DSH 给的 inputActions
     * （里面有 setDraft），供 B→A 接力把内容写进输入框。自己不渲染任何东西。
     *
     * 之所以要单独挂在 session 作用域：输入动作面只有 session 作用域组件才拿得到。
     * 界面部分（气泡、提示）已经挪到 root 的 DshOverlay 里了，没会话也能用。
     */
    function RelayBridge(props) {
      // 抓输入动作面。渲染期赋值是幂等的（每次拿到的是同一个对象），可以接受。
      try {
        const hasActions =
          !!(props && props.inputActions && typeof props.inputActions.setDraft === 'function')
        if (hasActions) {
          if (!sessionInput) diag('已取得 inputActions（setDraft 可用）')
          sessionInput = props.inputActions
        }
        // 只报一次：把 DSH 实际传下来的 props 键名记进诊断文件。
        // 万一将来 DSH 改了这块契约，读一眼诊断就知道，不用去猜。
        if (!relayPropsLogged) {
          relayPropsLogged = true
          const keys = props ? Object.keys(props).sort() : []
          diag('接力桥已渲染；有 inputActions=' + hasActions + '；props 键=' + keys.join(','))
          reportStatus({ phase: 'relay-bridge-rendered', hasActions, propKeys: keys })
        }
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /**
     * 读一眼输入框里已有的文字 —— 只用来决定「追加」还是「替换」。
     * 这是纯 DOM 读取，不写入，所以不会被 Lexical 的渲染冲掉。
     *
     * ⚠️ 卡顿修复：读 `innerText` 会**强制一次同步重排**，草稿越长越慢。
     * 所以先用 `textContent.length`（不算布局，几乎零成本）做上限判断：
     * 草稿已经很长时就不再读它，直接按「不追加」处理，避免每 1.5 秒轮询都重排一次。
     */
    /**
     * 我们**上一次写进输入框的完整草稿**。
     *
     * 🐞 2026-09-27 修复的「重复粘贴好几遍 / 草稿越读越短」：
     *   读输入框靠 `innerText`，但输入框有**渲染高度上限** —— 草稿很长时 `innerText`
     *   只会给出"渲染出来的那部分"（实测：写进去 5869 字，读回来只有 4821、4128、3468…），
     *   于是每次「读草稿 → 追加」都在拿一份被截短的草稿，缺的部分被丢掉、内容看起来重复错乱。
     *   修法：以这个镜像为准（我们自己写的，长度准确）。
     */
    let lastDraftWritten = ''

    /**
     * 接力写入模式。
     *
     * 🐞 2026-09-27 的教训：以前**总是追加**，而 DSH 输入框是 Lexical ——
     *    `setDraft` 会**清空并重建整棵内容树**，代价随草稿长度线性增长。
     *    几轮累积到几千字后，每次写入要几百毫秒到数秒，界面直接点不动。
     *
     * 所以默认改成 **'replace'（覆盖）**：输入框里永远只有**这一条**接力内容，
     * 写入规模恒定 → 不可能再撑爆、也不可能重复叠加。
     * 需要"攒上下文"的用户可显式配置 `relayAppendMode: 'append'`。
     *
     * @returns {'replace'|'append'} 当前模式。
     */
    function relayAppendMode() {
      try {
        const m = String(config.relayAppendMode || '').toLowerCase()
        return m === 'append' ? 'append' : 'replace'
      } catch (err) {
        return 'replace'
      }
    }

    /**
     * 计算最终要写进输入框的草稿（**纯函数**，不碰 DOM，便于验证）。
     *
     * @param {'replace'|'append'} mode 写入模式。
     * @param {string} existing 已有草稿（仅 append 模式使用）。
     * @param {string} block 本次要写入的内容块。
     * @param {number} cap 草稿总长上限（仅 append 模式使用）。
     * @returns {{text:string, trimmedOld:number}} 最终文本与被裁掉的字数。
     */
    function composeDraft(mode, existing, block, cap) {
      const b = String(block == null ? '' : block)
      if (mode !== 'append') return { text: b, trimmedOld: 0 }
      const ex = String(existing == null ? '' : existing)
      let text = ex ? ex.replace(/\s+$/, '') + '\n' + b : b
      let trimmedOld = 0
      const limit = Number(cap) > 0 ? Number(cap) : 0
      if (limit > 0 && text.length > limit) {
        const keepFrom = text.length - limit
        const cutAt = text.indexOf('\n', keepFrom)
        const tail = text.slice(cutAt >= 0 ? cutAt + 1 : keepFrom)
        trimmedOld = text.length - tail.length
        text = '……（较早的内容已自动裁剪，避免输入框被撑爆）' + '\n' + tail
      }
      return { text: text, trimmedOld: trimmedOld }
    }

    /**
     * 取"用于追加的已有草稿"。
     *
     * 优先用镜像（准确）；只有在**读回来的内容明显更接近真实**（例如用户自己编辑过、
     * 长度和镜像不一致但读回值更完整）时才采信 DOM。读回来比镜像短 → 说明被渲染截断，
     * 一律以镜像为准。
     *
     * @returns {string} 已有草稿（没有则返回 ''）。
     */
    function readDraftForAppend() {
      const mirror = String(lastDraftWritten || '')
      let fromDom = ''
      try {
        const eds = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(
          (el) => el.offsetParent !== null,
        )
        const el = eds[eds.length - 1]
        if (el) {
          // 读回来后必须归一：Lexical 把段落边界读成 \n，空行会读成两个 \n，
          // 不归一就会在每轮「读→写」中把空行翻倍累积。
          fromDom = normalizeDraftReadback(String(el.innerText || ''))
        }
      } catch (err) {
        fromDom = ''
      }
      // DOM 读回不完整（渲染截断）或空 → 用镜像
      if (!fromDom || fromDom.length < mirror.length) {
        if (mirror) diag('草稿以镜像为准（读回 ' + fromDom.length + ' 字 / 镜像 ' + mirror.length + ' 字）')
        return mirror
      }
      // 用户自己编辑过（读回更长或等长但不同）→ 采信 DOM，并更新镜像
      if (fromDom !== mirror) {
        diag('草稿以编辑器为准（读回 ' + fromDom.length + ' 字 / 镜像 ' + mirror.length + ' 字）')
        lastDraftWritten = fromDom
      }
      return fromDom
    }

    /**
     * 剥掉文本开头**所有已知的接力前缀行**（连同其后的空行）。
     *
     * 为什么需要"所有已知"而不是只比对当前配置那一条：两端默认文案历史上不一致
     * （宿主 / 网页端 / 客户端各写过一句），只比对一条时去重会失效，
     * 每次接力都会再贴一块「前缀 + 空行」—— 现场表现就是「大量空白」。
     *
     * @param {string} text 已清洗的文本。
     * @returns {string} 去掉开头前缀行的文本。
     */
    const KNOWN_RELAY_PREFIXES = [
      '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】',
      '【以下是来自 DeepSeek 网页端的上下文，请基于此继续帮我完成后续任务】',
      '【来自 DeepSeek 网页端上下文】',
    ]

    function stripRelayPrefixes(text) {
      try {
        // 词首空白先清掉，避免后续 startswith 判断被前导空格干扰
        let t = String(text == null ? '' : text).replace(/^[ \t]+/, '')
        // ① 已知文案的前缀：不管后面跟的是换行、空行还是直接接正文，一律切掉
        //    （v1.5 起网页端把前缀**直接贴在正文同一行**，所以不能只按"整行匹配"处理）
        for (let i = 0; i < 5; i++) {
          let matched = false
          for (const p of KNOWN_RELAY_PREFIXES) {
            if (t.startsWith(p)) {
              t = t.slice(p.length).replace(/^[ \t]*\n*/, '')
              matched = true
              break
            }
          }
          // ② 兜底：未知文案的短前缀整行（【…网页端…】）
          if (!matched) {
            const m = t.match(/^\s*([^\n]*)\n/)
            if (m) {
              const l = m[1].trim()
              if (l && l.length <= 60 && l.startsWith('【') && l.endsWith('】') && l.includes('网页端')) {
                t = t.slice(m[0].length).replace(/^[ \t]+/, '')
                matched = true
              }
            }
          }
          if (!matched) break
        }
        // ⚠️ 这里**不做**全文换行压缩：那会把多块草稿压平。空行归一交给
        //    normalizeDraftReadback()，只在「从编辑器读回草稿」时做。
        return t.trim()
      } catch (err) {
        return String(text == null ? '' : text)
      }
    }

    /**
     * 归一「从编辑器读回来的草稿」。
     *
     * 为什么需要：DSH 输入框是 Lexical，段落边界读回来是 `\n`，一个空行会读成两个 `\n`；
     * 不做归一，每轮「读草稿 → 写回」都会让空行翻倍累积（现场就是「大量空白」）。
     * 归一规则与 safeCleanText 一致：行尾空白去掉、3 个以上换行压成 2 个 —— 幂等。
     *
     * @param {string} text 从编辑器读回的草稿。
     * @returns {string} 归一后的草稿。
     */
    function normalizeDraftReadback(text) {
      try {
        return String(text == null ? '' : text)
          .replace(/\s+$/, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
      } catch (err) {
        return String(text == null ? '' : text)
      }
    }

    /** 把一条接力内容写进 DSH 输入框，并把结果回执给网页端（失败时网页端会兜底复制）。 */
    function applyRelay(item) {
      const ackId = item && item.id ? String(item.id) : ''
      /** 回报结果给网页端。网页端气泡在等这个：失败/超时它会写剪贴板并弹窗。 */
      const ack = (ok, detail) => {
        if (!ackId) return
        try {
          postJson(BASE + '/relay-ack', { id: ackId, ok: ok === true, detail: detail || '' })
        } catch (err) {
          /* 回执失败不影响写入本身 */
        }
      }
      try {
        if (!sessionInput || typeof sessionInput.setDraft !== 'function') {
          showToast('接力内容收到了，但当前没有可用的输入框 —— 先在 DSH 里打开一个会话再试。', true)
          reportStatus({ phase: 'relay-no-input' })
          ack(false, 'DSH 当前没有可用的输入框')
          return
        }
        // 网页端已经洗过一遍；这里再做一次幂等清洗（兜住旧版脚本 / 直接调用）。
        // safeCleanText 内部已硬截断到 TRANSFER_MAX_CHARS，所以 body 永远不会超长。
        const rawLen = item && typeof item.text === 'string' ? item.text.length : 0
        const body = safeCleanText(item.text)
        if (!body) {
          showToast('网页端这次没拿到选中的文字。', true)
          ack(false, '内容为空')
          return
        }
        const truncated = rawLen > body.length
        // 网页端（page-script）已经按 config.relayPrefix 加过前缀了；
        // 这里做个去重，免得旧版/直接调用时被加两次。
        //
        // 🐞 2026-09-27 修复的「大量空白」根因（两条一起）：
        //    ① 两端前缀文案曾不一致 → 去重永不成立 → 每接一次多贴「前缀 + 空行」；
        //    ② DSH 输入框是 Lexical，`setDraft` 把每个 `\n` 变成一个**段落**，
        //       空行 = 一个真空段落（带段间距），块间再插空行就会成片空白。
        //    统一契约：**每块恰好一个前缀**，由宿主保证（网页端加了就剥掉再加回，
        //    没加就补上）—— 这样无论对方是新版还是旧版，输入框里都不会缺、也不会重复。
        const relayPrefix = String(config.relayPrefix || '').trim()
        const stripped = stripRelayPrefixes(body)
        // 网页端若已把前缀贴在正文首行（新格式）→ 同段拼回；若是旧格式（前缀独占一行）
        // 或根本没加 → 用换行分隔，保持"前缀 + 正文"两段的结构。
        const hadInlinePrefix = relayPrefix ? body.trimStart().startsWith(relayPrefix) : false
        const block = stripped
          ? relayPrefix
            ? relayPrefix + (hadInlinePrefix ? '' : '\n') + stripped
            : stripped
          : body
        // 写入策略：默认 'replace'（覆盖）——见 composeDraft 的说明。
        const mode = relayAppendMode()
        const cap = Number(config.draftMaxChars) > 0 ? Number(config.draftMaxChars) : DSH_DRAFT_MAX
        const existing = mode === 'append' ? readDraftForAppend() : ''
        const result = composeDraft(mode, existing, block, cap)
        const next = result.text
        const trimmedOld = result.trimmedOld

        sessionInput.setDraft(next)
        // 记下这次写进去的完整内容：下一次（若为追加模式）以它为准，
        // 不再依赖会被渲染截断的 innerText。
        lastDraftWritten = next
        showToast(
          '已接力 ' + body.length + ' 字符到输入框' +
            (mode === 'replace' ? '（已覆盖原草稿）' : '') +
            (truncated ? '（原文 ' + rawLen + ' 字，已按 ' + TRANSFER_MAX_CHARS + ' 字上限截断）' : '') +
            (mode === 'append' && existing ? '（追加在你原有内容后面）' : '') +
            (trimmedOld ? '（输入框总长已限制在 ' + cap + ' 字，裁剪了较早的 ' + trimmedOld + ' 字）' : '') +
            '，可以直接改了再发。',
        )
        diag(
          '接力已写入输入框(' + mode + ')，本条 ' + body.length + ' 字符，草稿总长 ' + next.length + ' 字符' +
            (truncated ? '（原文 ' + rawLen + ' 字，已截断）' : '') +
            (trimmedOld ? '（裁剪较早内容 ' + trimmedOld + ' 字）' : ''),
        )
        reportStatus({
          phase: 'relay-applied',
          chars: body.length,
          draftChars: next.length,
          trimmedOld: trimmedOld,
          rawChars: rawLen,
          truncated: truncated,
          appended: Boolean(existing),
        })
        ack(true, 'written')
      } catch (err) {
        showToast('写入输入框失败：' + String((err && err.message) || err), true)
        reportStatus({ phase: 'relay-write-error', error: String((err && err.message) || err) })
        ack(false, String((err && err.message) || err))
      }
    }

    let relaySince = 0
    let relayTimer = null

    /** 轮询宿主，取走新的接力内容。 */
    async function pollRelay() {
      try {
        const r = await fetch(BASE + '/relay?since=' + relaySince, { cache: 'no-store' })
        if (!r.ok) return
        const data = await r.json()
        for (const it of data.items || []) {
          relaySince = Math.max(relaySince, Number(it.seq) || 0)
          if (it.kind === 'relay') applyRelay(it)
          else if (it.kind === 'error') showToast('网页端提示：' + (it.detail || '未知原因'), true)
        }
        if (typeof data.seq === 'number' && data.seq > relaySince) relaySince = data.seq
      } catch (err) {
        /* 宿主没起来 / 正在重启，下一轮再试 */
      }
    }

    function startRelayPolling() {
      if (relayTimer) return
      if (config.relay === false) {
        diag('relay 已关闭，不启动接力轮询')
        return
      }
      // 轮询间隔 1500ms → 800ms：网页端「等回执」的预算里，这一项占了最大头
      // （最坏要等一整个周期）。800ms 让往返更快，代价只是本地小 HTTP 请求变密一点。
      relayTimer = window.setInterval(pollRelay, 800)
      pollRelay()
      diag('接力轮询已启动（每 1.5s）')
    }

    // ─────────────── 事件隔离：绝不让点击传到 DSH 的品牌按钮 ───────────────
    //
    // 🐞 修复的 bug：切换模式会把「当前正在进行的会话」顶掉，变成一个全新的新对话。
    //
    // 原因不在本插件调了什么 API（本插件从头到尾**没有**调用任何 DSH 的
    // 「新建/切换/重置会话」接口），而在 DOM：
    //
    //   @deepseek-ai/dsh-client-ui-sidebar 的 SidebarRoot 里，品牌行 logoRow 的
    //   第一个子节点是这样一个按钮：
    //
    //     <button class="…brand" aria-label="新建会话"
    //             onClick={() => { startSession(); }}>
    //       <span class="…brandIdentity" aria-hidden="true">
    //         <span class="…brandMark">{slot: sidebar.brand.mark}</span>
    //         <span class="…brandName">{slot: sidebar.brand.name}</span>   ← 我们注册在这
    //       </span>
    //     </button>
    //
    //   也就是说：**本插件的下拉切换器是那个「新建会话」按钮的后代节点**。
    //   展开按钮当初加了 stopPropagation 所以没事；但两个菜单项没加 —— 点
    //   「DeepSeek chat」/「DSH 默认模式」时 click 冒泡到品牌按钮 → startSession()
    //   → 当前会话被换掉，输入框里没发出去的草稿一起丢。
    //
    // 修法：把插件自己 UI 区域内的指针/点击事件在**冒泡阶段**截住。
    //   · 只 stopPropagation，不动 capture 阶段 —— 插件内部按钮的 onClick 照常触发；
    //   · 不使用 nativeEvent.stopImmediatePropagation()，避免误伤 DSH 自己的
    //     全局 document 监听（例如「点空白处关菜单」那类逻辑）。
    function stopAll(ev) {
      if (!ev) return
      try {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation()
      } catch (err) {
        /* 忽略 */
      }
    }



    // ─────────────────────────── apply ───────────────────────────
    // 只依赖 slots：注册 UI 用的。不需要 layout（我们不切换 DSH 的中央面板）。
    const inject = ['slots']

    /**
     * @param {any} ctx 客户端根上下文。
     */
    function apply(ctx) {
      const registered = []
      diag('apply() 进入')
      diag('ctx.slots = ' + typeof (ctx && ctx.slots))

      // 用 slots.inject 而不是直接 register：ui-sidebar / brand-official
      // 可能比我们晚加载，inject 会等到该 slot 被声明为止。
      //
      // ⚠️ 实测踩到的坑（这是「看不到下拉框」的真正原因）：
      //
      // `sidebar.brand.name` 是 **single** slot，而官方插件
      // dsh-client-ui-brand-official 已经以 **priority 0** 占了它。此时直接
      // register 会**抛异常**，而不是自动替换：
      //
      //   single slot "sidebar.brand.name" already has a registration at
      //   priority 0 (registered by …) — register at a different priority to
      //   shadow it (lowest renders)
      //
      // DSH 的规则（见 dsh-cordis-client-runner/lib/types/client/runtime.d.ts）：
      //   「A later registration receives a lower priority」+「lowest renders」
      // 也就是说 single slot 靠 **priority 数字最小者胜出**，必须显式给一个比
      // 官方更小的数（负数）才能把它盖掉。
      //
      // ─────────────── 左侧边栏原生菜单项（v1.7 起）───────────────
      //
      // 旧的「顶部下拉切换按钮」已删除：它是挂到 `sidebar.brand.name` 这个 single slot
      // 上的，而该 slot 位于官方"新建会话"按钮的子树里 —— 桌面壳会把它整支隐藏
      // （实测：元素在 DOM 里、内联样式 + !important 都压不过，display 恒为 none）。
      //
      // 改为注册进 `sidebar.panellist`（kind:"list"）—— 就是「扩展管理 / 定时任务 / IM」
      // 那一列，DSH 自己会渲染行按钮、图标与标题，我们只提供条目。
      //
      // 条目选项契约（读 DSH 侧边栏源码得出）：{ id, order, label }
      //   · id    —— 该条目的 slot id（面板唯一标识）
      //   · order —— 排序，越小的越靠上
      //   · label —— 字符串或 () => 字符串（resolveSlotLabel 直接返回它）
      // 组件会收到 props：{ size, active, selectPanel, toggleSidebar, ... }
      //   · selectPanel(id) 只做一件事：把 panelInfo.activePanelId 设为 id（点亮/激活）。
      //     右侧内容属于第二步（需要 ctx.sidebarRightTabs），本步只保证菜单项出现且可点。
      const PANEL_ID = 'dsh-deepseek-chat-panel'

      // 面板图标：一个极简的"对话气泡 + 折线"轮廓，呼应 DeepSeek chat（不使用任何商标图形）
      function DeepSeekChatIcon(props) {
        const size = props && props.size ? props.size : 18
        return React.createElement(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          React.createElement('path', { d: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12Z' }),
          React.createElement('path', { d: 'M8.5 11h7M8.5 14.5h4.5' }),
        )
      }

      /**
       * 侧边栏菜单项本体。
       *
       * DSH 会把这一行包成自己的按钮（onClick → selectPanel(id)），我们只负责画图标；
       * 但"点击打开 DeepSeek 窗口"这个动作由**本组件自己**处理：
       *   · 在冒泡阶段先于外层按钮拿到点击；
       *   · stopPropagation 阻止再往上冒泡（避免影响侧边栏自身的其他监听）；
       *   · 复用既有的 openWeb()（Tauri 优先 → 宿主 /open 回退），**不新增任何通信逻辑**。
       * 任何异常都只写日志 + 弹提示，绝不抛到渲染树里。
       *
       * @param {{size?:number, active?:boolean}} props slot 注入的 props。
       * @returns {any} React 元素。
       */
      function DeepSeekChatPanelItem(props) {
        try {
          const size = props && props.size ? props.size : 18
          const onActivate = (ev) => {
            try {
              if (ev && ev.stopPropagation) ev.stopPropagation()
            } catch (err) {
              /* 忽略 */
            }
            try {
              showToast('正在打开 DeepSeek chat 窗口…')
              Promise.resolve(openWeb()).then(
                (r) => {
                  try {
                    if (r && r.ok) {
                      showToast('DeepSeek chat 窗口已就绪' + (r.mode ? '（' + r.mode + '）' : ''))
                    } else {
                      showToast('打开失败：' + ((r && r.detail) || '未知原因'), true)
                    }
                  } catch (err) {
                    /* 忽略 */
                  }
                },
                (err) => {
                  try {
                    showToast('打开失败：' + String((err && err.message) || err), true)
                  } catch (e) {
                    /* 忽略 */
                  }
                },
              )
            } catch (err) {
              try {
                showToast('打开失败：' + String((err && err.message) || err), true)
              } catch (e) {
                /* 忽略 */
              }
            }
          }
          /**
           * 🐞 2026-09-27 修复「点了没反应」：
           *   实测（探针）——图标节点确实挂载了（16×16、pointerEvents:auto），
           *   但 React 的 onClick **从未被调用**：DSH 的行按钮自己用 React 委托处理点击，
           *   我们挂在 span 上的合成事件收不到。
           *   最小修法：不用 React 合成事件，改用**原生 DOM 监听器直接绑在图标节点上**
           *   （callback ref 负责绑定与解绑）。原生监听器一定命中，与 React 委托无关。
           *
           * @param {any} node 图标 span 节点（React 传入）。
           * @returns {void}
           */
          /**
           * 把点击监听同时绑到**图标节点**和它所在的**整行按钮**上，并上报诊断。
           *
           * 为什么要两处都绑：图标只有 16×16，用户很可能点在文字区域（那属于外层
           * `<button class="…panelRow">`）；而且外层按钮我们用 closest('button') 现找。
           * 诊断（handlers 数组）会写进自检文件，用来确认"到底有没有一个 handler 被调用"。
           *
           * @param {any} node 图标 span 节点（React ref 传入）。
           * @returns {void}
           */
          const bindGlyph = (node) => {
            try {
              if (!node) return
              if (node.__dswBound) return
              node.__dswBound = true
              node.__dswHandlers = []
              const bound = []
              /** 绑一个节点（找到即绑，天然避开"ref 触发时外层还没生成"的时序问题）。 */
              const attach = (el, where) => {
                if (!el || el.__dswClickBound) return
                el.__dswClickBound = true
                bound.push(where)
                try {
                  el.addEventListener(
                    'click',
                    (ev) => {
                      try {
                        node.__dswHandlers.push(where + '@' + Date.now())
                        reportStatus({
                          phase: 'click-fired',
                          clickFired: {
                            where: where,
                            count: node.__dswHandlers.length,
                            targetCls: String((ev && ev.target && ev.target.className) || '').slice(0, 40),
                          },
                        })
                      } catch (e) {
                        /* 忽略 */
                      }
                      onActivate(ev)
                    },
                    true,
                  )
                } catch (e) {
                  /* 单个节点绑定失败不影响另一个 */
                }
              }
              attach(node, 'glyph')
              const tryRow = () => {
                try {
                  const row = node.closest && node.closest('button')
                  if (row && row !== node) {
                    attach(row, 'row')
                    return true
                  }
                } catch (e) {
                  /* 忽略 */
                }
                return false
              }
              // ref 触发时外层行按钮可能还没生成 → 最多补试 5 次
              if (!tryRow()) {
                let tries = 0
                const t = window.setInterval(() => {
                  tries++
                  if (tryRow() || tries >= 5) window.clearInterval(t)
                }, 300)
              }
              reportStatus({ phase: 'glyph-bound', bound: { targets: bound, glyphSize: size } })
            } catch (err) {
              /* 绑定失败不影响渲染 */
            }
          }
          return React.createElement(
            'span',
            {
              className: 'dsw-panel-glyph',
              ref: bindGlyph,
              title: '打开 DeepSeek chat 窗口',
            },
            React.createElement(DeepSeekChatIcon, { size: size }),
          )
        } catch (err) {
          try {
            console.error('[dsh-deepseek-chat] 菜单项渲染失败', err)
          } catch (e) {
            /* 忽略 */
          }
          return null
        }
      }

      try {
        ctx.slots.inject('sidebar', () => {
          // ⚠️ 实测：inject('sidebar') 回调触发时，子表 sidebar.panellist **可能还没声明**
          // （报错：slot "sidebar.panellist" is not declared）。所以这里带退避重试，
          // 最多试 8 次；只有全部失败才写诊断（顺带把可见 slot 名列出来便于排查）。
          let attempt = 0
          const MAX_ATTEMPTS = 8
          const tryRegister = () => {
            attempt++
            try {
              const disposer = ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 40,
                  label: 'DeepSeek chat',
                },
                DeepSeekChatPanelItem,
              )
              registered.push('sidebar.panellist#' + PANEL_ID)
              diag('已注册左侧菜单项 DeepSeek chat（第 ' + attempt + ' 次尝试成功）')
              reportStatus({ registered: registered, phase: 'panellist-registered' })
              // 注册后做一次 DOM 自检（菜单项是 DSH 自己渲染的，我们只能看结果）
              try {
                window.setTimeout(() => {
                  try {
                    const hit = Array.from(document.querySelectorAll('button')).find((b) =>
                      String(b.textContent || '').includes('DeepSeek chat'),
                    )
                    const r = hit ? hit.getBoundingClientRect() : null
                    diag(
                      '菜单项自检: ' +
                        (hit ? '已出现在侧边栏 ✓' : '未找到（侧边栏可能是收起态，展开后可见）') +
                        (r ? '，尺寸 ' + Math.round(r.width) + 'x' + Math.round(r.height) : ''),
                    )
                    /* 【临时排查 · 2026-09-27】点击链路诊断：
                       ① 组件是否真的挂载（有没有 .dsw-panel-glyph 节点）
                       ② 在 document 捕获阶段监听一次点击，看点击究竟落在谁身上 */
                    let glyphInfo = null
                    try {
                      const g = document.querySelector('.dsw-panel-glyph')
                      const gr = g ? g.getBoundingClientRect() : null
                      const gcs = g ? window.getComputedStyle(g) : null
                      glyphInfo = g
                        ? {
                            w: Math.round(gr.width),
                            h: Math.round(gr.height),
                            x: Math.round(gr.left),
                            y: Math.round(gr.top),
                            pointerEvents: gcs.pointerEvents,
                            display: gcs.display,
                          }
                        : 'NO-NODE（组件没有挂载到 DOM）'
                    } catch (e) {
                      glyphInfo = 'err: ' + String((e && e.message) || e)
                    }
                    let target = null
                    try {
                      const t = hit || document.querySelector('.dsw-panel-glyph')
                      target = t
                        ? { tag: t.tagName, cls: String(t.className || '').slice(0, 50), role: t.getAttribute('role') }
                        : null
                    } catch (e) {
                      /* 忽略 */
                    }
                    reportStatus({
                      registered: registered,
                      phase: 'panellist-dom-check',
                      menuItem: hit
                        ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }
                        : null,
                      glyph: glyphInfo,
                      menuTarget: target,
                    })
                    // 捕获阶段监听一次真实点击，记录命中的元素（点完菜单项就会写进自检）
                    try {
                      if (!window.__dswClickProbe) {
                        window.__dswClickProbe = true
                        document.addEventListener(
                          'click',
                          (ev) => {
                            try {
                              const el = ev.target
                              const inMenu =
                                el &&
                                el.closest &&
                                el.closest('[data-slot="sidebar.panellist"], .dsw-panel-glyph')
                              if (!inMenu) return
                              reportStatus({
                                phase: 'click-hit',
                                clickHit: {
                                  tag: el.tagName,
                                  cls: String(el.className || '').slice(0, 60),
                                  isGlyph: Boolean(el.closest && el.closest('.dsw-panel-glyph')),
                                  defaultPrevented: ev.defaultPrevented,
                                },
                              })
                            } catch (e) {
                              /* 忽略 */
                            }
                          },
                          true,
                        )
                      }
                    } catch (e) {
                      /* 忽略 */
                    }
                  } catch (e) {
                    diag('菜单项自检抛错: ' + String((e && e.message) || e))
                  }
                }, 3000)
              } catch (err) {
                /* 自检失败不影响功能 */
              }
              return disposer
            } catch (err) {
              const msg = String((err && err.message) || err)
              if (attempt < MAX_ATTEMPTS) {
                diag('注册左侧菜单项第 ' + attempt + ' 次未成功（' + msg + '），稍后重试')
                window.setTimeout(tryRegister, 250 * attempt)
                return undefined
              }
              diag('注册左侧菜单项失败（已重试 ' + attempt + ' 次）: ' + msg)
              try {
                const names = (ctx.slots.entries ? ctx.slots.entries() : [])
                  .map((e) => (e && e.options && e.options.name) || (e && e.name) || '?')
                  .filter((n) => String(n).includes('sidebar'))
                diag('当前可见的 sidebar* slot: ' + (names.length ? names.join(', ') : '（读不到）'))
              } catch (e) {
                /* 诊断失败无所谓 */
              }
              reportStatus({ registered: registered, phase: 'panellist-register-failed' })
              return undefined
            }
          }
          return tryRegister()
        })
        diag('左侧菜单项注入已提交（等 sidebar slot 声明）')
      } catch (err) {
        diag('左侧菜单项注入抛错: ' + String((err && err.message) || err))
      }

      // A→B 的界面部分（划词气泡 + 提示）挂在 **root** 的浮层槽上。
      // shell.overlay 是 kind:"list" + scope:"root"，是「整个框架之上的浮动层」，
      // 而且是 click-through 的（条目自己决定要不要接收指针事件）——
      // 正好适合一个只在划词时才出现的小气泡。
      // 挂 root 而不是 session：这样没开会话也能用（气泡不需要 DSH 的输入框）。
      //
      // ⚠️ **list 类 slot 注册必须带 `id`**，否则 SlotCore 直接抛
      //    `list slot "..." requires options.id`（源码里 case "list" 分支硬校验）。
      //    这个坑踩过：注册失败但异常被吞掉，界面就是「什么都不出现」。
      try {
        ctx.slots.inject('shell.overlay', () => {
          diag('shell.overlay 已声明 → 注册划词浮层')
          try {
            ctx.slots.register({ name: 'shell.overlay', id: 'dsh-deepseek-chat-overlay' }, DshOverlay)
            registered.push('shell.overlay#dsh-deepseek-chat-overlay')
            diag('划词浮层注册完成')
          } catch (err) {
            diag('划词浮层注册抛错: ' + String((err && err.message) || err))
          }
          reportStatus({ registered, phase: 'overlay-registered' })
        })
        diag('划词浮层注入已提交（等 slot 声明）')
      } catch (err) {
        diag('划词浮层注入抛错: ' + String((err && err.message) || err))
      }

      // 上下文接力的常驻桥：挂在 session 作用域的 list slot 上。
      // list 是追加语义，不会顶掉别人；拿到的 props.inputActions 里有 setDraft。
      // 同样必须带 `id`（见上）。注册成功与否只在回调里记，免得把失败当成功。
      try {
        ctx.slots.inject('conversation.session.header.utilities', () => {
          diag('conversation.session.header.utilities 已声明 → 注册接力桥')
          try {
            ctx.slots.register(
              { name: 'conversation.session.header.utilities', id: 'dsh-deepseek-chat-bridge' },
              RelayBridge,
            )
            registered.push('conversation.session.header.utilities#dsh-deepseek-chat-bridge')
            diag('接力桥注册完成')
          } catch (err) {
            diag('接力桥注册抛错: ' + String((err && err.message) || err))
          }
          reportStatus({ registered, phase: 'bridge-registered' })
        })
        diag('接力桥注入已提交（等 slot 声明）')
      } catch (err) {
        diag('接力桥注入抛错: ' + String((err && err.message) || err))
      }

      // 开始轮询宿主，接收网页端发来的接力内容
      try {
        startRelayPolling()
      } catch (err) {
        diag('接力轮询启动失败: ' + String((err && err.message) || err))
      }

      reportStatus({ registered: registered, mode: readMode(), phase: 'apply', clean: CLEAN_VERSION })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
