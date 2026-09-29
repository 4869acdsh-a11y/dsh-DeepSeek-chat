/**
 * page-script.js —— 注入到 chat.deepseek.com 页面里的脚本
 *
 * ⚠️ 这个文件**不是** DSH 插件模块，不要用 require / export。
 * 它由宿主半边（index.js）读取文本后，通过 CDP 注入：
 *   - Page.addScriptToEvaluateOnNewDocument()  → 每次页面加载/刷新都自动运行
 *   - Runtime.evaluate()                       → 对当前已打开的页面立即生效
 *
 * 配置由宿主在注入前拼在脚本前面（window.__DSH_RELAY_CONFIG__）。
 *
 * ── 它只做两件事 ─────────────────────────────────────────────
 *   A→B（宿主调用）：window.__dshInjectText(text)
 *       把 DSH 里划词的内容写进网页端底部输入框。
 *
 *   B→A（本脚本自己）：**划词浮现**
 *       鼠标选中任意文字（mouseup）后，在鼠标旁浮出一个小气泡「↪ 传给DSH」；
 *       点它就只抓**选中的那段纯文本**（window.getSelection().toString()），
 *       加上前缀后经 CDP binding `window.__dshRelay(json)` 回传宿主，
 *       由 DSH 客户端写进当前活跃的输入框。
 *
 * ── 与旧版的区别（v1.4.1）────────────────────────────────────
 *   旧版给**每条助手回复**下面挂一个「↪ 转到 DSH 继续」按钮，用
 *   MutationObserver 补按钮，还要猜回复容器的 DOM 选择器（站点一改版就失效），
 *   并且会把**整条回复**转成 Markdown 带走 —— 视觉噪音大、脆弱、还常常带太多。
 *   现在改成划词触发：和 DSH 侧（shell.overlay 划词气泡）交互一致，
 *   不再依赖任何回复容器选择器，带走的也只是用户真正选中的那一段。
 *
 * ── 回执与兜底 ─────────────────────────────────────────────
 *   气泡点击后带一个唯一 id 发出去。DSH 侧写输入框成功/失败后会回执：
 *   宿主用 CDP 调 window.__dshRelayAck({id, ok, detail})。
 *   · ok=true  → 气泡显示「✓ 已传给 DSH」再自动消失
 *   · ok=false / 6 秒内没有回执 → 兜底：内容写进系统剪贴板（同时请宿主再写一次），
 *     并弹窗「内容已复制，请手动前往 DSH 粘贴」
 */

;(() => {
  // ─────────────────── A→B 注入入口（供宿主用 CDP 调用）───────────────────
  //
  // 宿主执行：Runtime.evaluate("window.__dshInjectText('文本')")
  // 返回值必须是 JSON 可序列化的，宿主直接读它判断成功/失败。
  //
  // ⚠️ 这一段放在「防重复安装」守卫**之前**，而且每次加载都重新赋值 ——
  //    这样即使窗口一直开着、插件升级了 page-script.js，重新注入也能拿到新逻辑。
  window.__dshInjectText = function (text) {
    // 注入前的二次清洗：DSH 侧选中的内容也会混进 NBSP / 一大堆空行。
    // cleanTransferText 是纯 LF 的；真正写进编辑器时再按需转 \r\n（见下面 toCrlf）。
    const s = cleanTransferText(text)
    if (!s) return { ok: false, detail: '内容为空' }

    /** 只认「看得见」的输入框，避免写到隐藏的模板节点上。 */
    function visible(el) {
      if (!el) return false
      try {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      } catch (err) {
        return false
      }
    }

    // 已有内容就追加，不覆盖用户正在打的字
    function merge(existing) {
      const cur = String(existing || '')
      return cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + s : s
    }

    try {
      // 1) 优先 textarea —— DeepSeek 底部输入框是 textarea
      const areas = Array.from(document.querySelectorAll('textarea')).filter(visible)
      if (areas.length) {
        const el = areas[areas.length - 1] // 取最靠下的那个
        const appended = Boolean(String(el.value || '').trim())
        const next = merge(el.value)
        // 注入前统一转成 Windows 换行：textarea 的 value setter 会自己归一化，
        // 真正需要 \r\n 的是 contenteditable（见下面），这里保持一致口径。
        const write = toCrlf(next)
        el.focus()
        // React 受控组件：必须走原生 value setter 再派发 input，
        // 直接 el.value = x 会被 React 的下一次渲染覆盖回去。
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
        if (desc && desc.set) desc.set.call(el, write)
        else el.value = write
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        try {
          el.selectionStart = el.selectionEnd = write.length
          el.scrollTop = el.scrollHeight
        } catch (err) {
          /* 忽略 */
        }
        return {
          ok: true,
          how: 'textarea',
          appended: appended,
          detail:
            '已写入网页端输入框（' +
            next.length +
            ' 字' +
            (appended ? '，追加在原有内容后面' : '') +
            '）',
        }
      }

      // 2) 兜底：contenteditable 编辑器
      const eds = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible)
      if (eds.length) {
        const el = eds[eds.length - 1]
        const appended = Boolean(String(el.innerText || '').trim())
        const next = merge(el.innerText)
        // contenteditable 走的是「模拟粘贴 / 写文本」这条路：
        // 必须用 \r\n，否则 Lexical/ProseMirror 里换行会被当成普通空白，
        // 粘出来就是一连串大空格。
        const write = toCrlf(next)
        el.focus()
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false) // 光标移到末尾
        sel.removeAllRanges()
        sel.addRange(range)
        // execCommand 能让 Lexical/ProseMirror 这类编辑器收到「正规输入」
        let okExec = false
        try {
          okExec = document.execCommand('insertText', false, write)
        } catch (err) {
          okExec = false
        }
        if (!okExec) {
          // 编辑器不认 execCommand 就退回写 innerText：
          // ⚠️ 必须用 innerText 而不是 textContent —— textContent 里的 \n 会被
          //    HTML 当成普通空白折叠掉，那正是「大空格」的来源之一。
          el.innerText = write
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }),
          )
        }
        return {
          ok: true,
          how: 'contenteditable',
          appended: appended,
          detail: '已写入网页端输入框（contenteditable）',
        }
      }
    } catch (err) {
      return { ok: false, detail: '注入抛错: ' + String((err && err.message) || err) }
    }

    return { ok: false, detail: '没找到网页端的输入框（textarea / contenteditable 都没有）' }
  }

  // 页面刷新后会重新执行，这里防重复安装（只保护下面的划词气泡部分）。
  //
  // ⚠️ 守卫是**版本感知**的，不是简单的 true/false：
  //    宿主每次重连都会再 Runtime.evaluate 一次本脚本；而旧版的守卫写的是
  //    `__DSH_RELAY_INSTALLED__ = true`，如果写成 `if (flag) return`，
  //    升级后新脚本会被旧脚本留下的标记挡住、划词气泡永远不出现。
  const SCRIPT_VERSION = 'selection-bubble-v1.4-ack15s'
  if (window.__DSH_RELAY_INSTALLED__ === SCRIPT_VERSION) return
  window.__DSH_RELAY_INSTALLED__ = SCRIPT_VERSION

  // ───────────────────────── 文本清洗（A/B 两端各一份，必须保持一致）─────────────────────────
  //
  // 解决的现场问题：划词带走的内容里混着 不间断空格(U+00A0)、字面量 `&nbsp;`、
  // CRLF、以及一大串连续换行；粘到对方输入框里就变成「特别大且不正常的空格」。
  //
  // ⚠️ 顺序不能换：必须**先把 CRLF/CR 归一成 \n**，再压缩连续换行。
  //    否则 `\r\n\r\n\r\n` 匹配不上 /\n{3,}/，压缩会整个失效。
  //
  // 📌 有意保留的东西：行内的多个普通空格（代码缩进、markdown 对齐）不动 ——
  //    压掉会把代码块排版毁掉。要压的话再说，行为可配。
  const CLEAN_VERSION = 'clean-text-v3-trunc2000'

  /**
   * 互传文本的**硬上限**。定义在清洗函数之前（const 有 TDZ，必须先于任何调用点）。
   * 抓取到文本后立刻截断，保证后面所有处理只面对短文本。
   */
  const TRANSFER_MAX_CHARS = 2000

  /**
   * 安全清洗「互传文本」：与 client.js 里那份 `safeCleanText` **逐行一致**。
   *
   * 与 v1 的差别（v1 漏掉的两类输入，「大空格」真正的残余来源）：
   *   · 行尾只剩空格/制表符的空行（网页选区里极常见）—— v1 完全不动它，
   *     注进输入框就是一段「看不见的大空档」；
   *   · 裸 \r（某些站点用 \r 当换行）—— v1 的 /\r\n?/g 处理不到，
   *     而且残留的 \r 会让下游 toCrlf() 的 /\n/g 匹配不上，换行被整段吞掉。
   *
   * 🔒 安全约束（与 client.js 同一套）：第一行挡空值；拿到后立刻 slice(0, 2000)；
   *    整体 try/catch（失败返回**已截断**的原文）；只用最简单 /g 全局替换，无回溯无循环。
   *
   * @param {string} input 待清洗文本。
   * @returns {string} 清洗后的字符串（已截到 TRANSFER_MAX_CHARS 以内；入参非法返回 ''，绝不抛错）。
   */
  function cleanTransferText(input) {
    // 1) 第一行就挡空值：绝不允许 null.replace 冒到页面
    if (!input || typeof input !== 'string') return input || ''
    // 2) 立刻硬截断：超过 2000 字的部分直接切掉，绝不往下传
    const cut = input.length > TRANSFER_MAX_CHARS ? input.slice(0, TRANSFER_MAX_CHARS) : input
    try {
      let t = cut
      // 3) 所有换行风格先归一成 LF（必须最先做）
      t = t.replace(/\r\n/g, '\n')
      t = t.replace(/\r/g, '\n')
      // 4) 会显示成「大空格」的空白字符
      t = t.replace(/\u00A0/g, ' ')
      t = t.replace(/&nbsp;/g, ' ')
      t = t.replace(/[\u200B\uFEFF]/g, '')
      // 5) 行尾空白：行尾的空格/制表符在输入框里就是「看不见的空档」
      t = t.replace(/[ \t]+\n/g, '\n')
      // 6) 连续 3 个以上换行 → 2 个
      t = t.replace(/\n{3,}/g, '\n\n')
      return t.trim()
    } catch (e) {
      console.error('清洗失败', e)
      return cut
    }
  }

  /** 与 client.js 同名同义，便于两边对照。 */
  const safeCleanText = cleanTransferText

  /** 注入前用：把 LF 换成 Windows 换行（只给「模拟粘贴 / 写 innerText」这类路径用）。 */
  function toCrlf(input) {
    // ⚠️ 必须先把 CRLF 与裸 CR 都归一成 LF，否则 \r\n 里的 \n 会被再插一个 \r，
    //    变成 \r\r\n；而残留的裸 \r 会让下面的 /\n/g 完全匹配不上（换行被吞）。
    return String(input == null ? '' : input)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n/g, '\r\n')
  }

  /**
   * 清掉旧版（v1.4.x 及更早）插在每条回复下面的「↪ 转到 DSH 继续」按钮。
   * 升级时当前页面里可能还残留着旧 DOM；旧版的 MutationObserver 还会复活它们，
   * 所以在装机后 60 秒内持续清一下 —— 彻底干净的做法是刷新/重开这个窗口
   * （那时只会注入新脚本）。
   */
  function removeLegacyButtons() {
    try {
      const legacy = document.querySelectorAll('[data-dsh-relay-btn]')
      for (const el of legacy) {
        try {
          el.remove()
        } catch (err) {
          /* 忽略 */
        }
      }
      return legacy.length
    } catch (err) {
      return 0
    }
  }

  const CFG = window.__DSH_RELAY_CONFIG__ || {}
  const BUBBLE_TEXT = CFG.bubbleText || '↪ 传给DSH'
  const MAX_CHARS = Number(CFG.maxChars) || 2000
  /**
   * 发出去后等 DSH 回执的上限；超时就兜底复制。
   *
   * ⚠️ 2026-09-27 从 6000ms 提到 15000ms —— 6000 会把「成功」误判成「失败」：
   * DSH 客户端是**每 1.5 秒轮询一次**接力队列的，一条内容最坏要等 ~1.5s 才被取走，
   * 再叠加写输入框 + 同步 POST 回执 + 渲染，真实往返实测已到 **6.2 秒**，
   * 于是网页端先超时：写系统剪贴板 + 弹「请手动粘贴」，而 DSH 其实**已经写好了**。
   * 15 秒留足余量，仍能在宿主真的没响应时兜底（只是晚一点）。
   */
  const ACK_TIMEOUT_MS = Number(CFG.ackTimeoutMs) > 0 ? Number(CFG.ackTimeoutMs) : 15000
  const LOG = '[dsh-relay]'

  /**
   * 宿主是否支持「回执」（新版宿主才会下发 bubbleText，并且有 /relay-ack 路由）。
   *
   * ⚠️ 必须放在 CFG 之后（const 有 TDZ，放前面会 ReferenceError → 整个脚本挂掉）。
   *
   * 为什么需要这个判断：如果插件升级后**宿主半边还没重启**，回执路由并不存在，
   * 那时每次接力都会在 6 秒后被误判成"注入失败"，弹出"已复制，请手动粘贴"——
   * 明明已经注入成功了。所以旧宿主下退化成"发出去就不管"。
   */
  const HOST_SUPPORTS_ACK = Object.prototype.hasOwnProperty.call(CFG, 'bubbleText')

  /**
   * 内容前缀。宿主 config.relayPrefix 也会带过来；两端保持一致。
   *
   * ⚠️ 前后**都不加换行**：DSH 输入框（Lexical）把每个 `\n` 变成一个**段落**，
   *    前缀若独占一行就会多出一个空段，传几次就"大量空白"。
   *    现在前缀直接贴在正文同一段前面（客户端那边还会再剥一次前缀，双保险）。
   */
  const DEFAULT_PREFIX = '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】'
  const PREFIX = (() => {
    const p = typeof CFG.prefix === 'string' ? CFG.prefix : ''
    const raw = p.trim() ? p : DEFAULT_PREFIX
    return raw.replace(/\s+$/, '')
  })()

  /** 回传给宿主。window.__dshRelay 是宿主用 CDP Runtime.addBinding 注册的。 */
  function send(payload) {    try {
      if (typeof window.__dshRelay !== 'function') return false
      window.__dshRelay(JSON.stringify(payload))
      return true
    } catch (err) {
      return false
    }
  }

  // ───────────────────────── 选区 ─────────────────────────

  /** 当前选中的纯文本（没选中就返回空串）。抓完立刻清洗 + 截断。 */
  function selectionText() {
    try {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return ''
      // 只认 toString()：绝不碰 innerHTML / cloneContents（那会把标签和实体带出来）
      // cleanTransferText 内部：防空值 → 立即截断到 MAX_CHARS → 清洗（失败则原样返回截断后的文本）
      return cleanTransferText(sel.toString())
    } catch (err) {
      return ''
    }
  }

  // ───────────────────────── 气泡 UI ─────────────────────────

  let bubble = null
  let bubbleBtn = null
  let hideTimer = null
  let lastSelection = ''
  let lastPoint = { x: 0, y: 0 }
  /** 已发出、等待回执的那一条：{ id, text, timer } */
  let pending = null

  function ensureBubble() {
    if (bubble && bubble.isConnected) return bubble
    bubble = document.createElement('div')
    bubble.setAttribute('data-dsh-selection-bubble', '1')
    bubble.style.cssText = [
      'position:fixed',
      'z-index:2147483000',
      'display:none',
      'pointer-events:auto',
      'user-select:none',
      '-webkit-user-select:none',
    ].join(';')

    bubbleBtn = document.createElement('button')
    bubbleBtn.type = 'button'
    bubbleBtn.textContent = BUBBLE_TEXT
    bubbleBtn.style.cssText = [
      'font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif',
      'padding:4px 10px',
      'border:1px solid rgba(77,107,254,.5)',
      'border-radius:999px',
      'background:#fff',
      'color:#4D6BFE',
      'box-shadow:0 2px 10px rgba(0,0,0,.16)',
      'cursor:pointer',
      'white-space:nowrap',
    ].join(';')
    // 关键：mousedown 必须阻止默认 —— 否则点气泡的瞬间浏览器会取消选区，
    // 等 click 再读 getSelection() 就什么都拿不到了。
    bubbleBtn.addEventListener(
      'mousedown',
      (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
      },
      true,
    )
    bubbleBtn.addEventListener(
      'click',
      (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        onBubbleClick()
      },
      true,
    )
    bubble.appendChild(bubbleBtn)
    ;(document.body || document.documentElement).appendChild(bubble)
    return bubble
  }

  /** 在鼠标位置旁边浮出气泡。 */
  function showBubble(x, y, text) {
    try {
      ensureBubble()
      bubbleBtn.textContent = BUBBLE_TEXT
      bubbleBtn.disabled = false
      bubble.style.display = 'block'
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      const w = bubble.offsetWidth || 96
      const h = bubble.offsetHeight || 26
      const vw = window.innerWidth || document.documentElement.clientWidth || 1024
      const vh = window.innerHeight || document.documentElement.clientHeight || 768
      bubble.style.left = Math.max(6, Math.min(Math.round(x + 8), vw - w - 6)) + 'px'
      bubble.style.top = Math.max(6, Math.min(Math.round(y + 12), vh - h - 6)) + 'px'
      lastSelection = text || lastSelection
    } catch (err) {
      /* 画不出来也不能影响页面 */
    }
  }

  /** 收起气泡（点别处 / 滚动 / Esc / 选区没了都会走到这）。 */
  function hideBubble() {
    try {
      if (bubble) {
        bubble.style.display = 'none'
        if (bubbleBtn) {
          bubbleBtn.disabled = false
          bubbleBtn.textContent = BUBBLE_TEXT
        }
      }
    } catch (err) {
      /* 忽略 */
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  // ───────────────────────── 兜底：复制到剪贴板 ─────────────────────────

  /**
   * 注入失败时的兜底：把内容写进系统剪贴板 + 弹窗提示。
   *
   * 两条路一起上：
   *   1) 请宿主用 PowerShell Set-Clipboard 写（最可靠，不受浏览器权限限制）；
   *   2) 页面自己再尽力 copy 一次（有用户手势时通常能成）。
   */
  function fallbackCopy(text, why) {
    let localOk = false
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      try {
        ta.setSelectionRange(0, text.length)
      } catch (err) {
        /* 忽略 */
      }
      localOk = document.execCommand('copy')
      ta.remove()
    } catch (err) {
      localOk = false
    }
    if (!localOk) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => {},
            () => {},
          )
          localOk = true
        }
      } catch (err) {
        /* 忽略 */
      }
    }

    // 请宿主用系统剪贴板兜一次，并让 DSH 侧也提示一声
    send({ kind: 'copy', text, detail: why || '' })

    try {
      window.alert('内容已复制，请手动前往 DSH 粘贴')
    } catch (err) {
      /* 忽略 */
    }
    return localOk
  }

  // ───────────────────────── 发送 ─────────────────────────

  /** 把选中的文字加前缀后发给宿主。 */
  function deliver(raw) {
    // 二次清洗（幂等）：上游 selectionText / lastSelection 已经洗过，
    // 这里再洗一遍能兜住任何漏网的 NBSP / 连续空行。
    // cleanTransferText 内部已经先 slice(0, TRANSFER_MAX_CHARS)，所以下面这条分支
    // 只在宿主把 maxChars 配得比 2000 更小时才会命中。
    let body = cleanTransferText(raw)
    if (!body) return
    if (body.length > MAX_CHARS) {
      body = cleanTransferText(body.slice(0, MAX_CHARS)) + '…（已按 ' + MAX_CHARS + ' 字上限截断，避免拖死另一端）'
    }
    // 前缀**直接贴在正文同一段**（不加换行）：Lexical 里换行 = 新段落，
    // 前缀独占一行会多出一个空段，传几次就成"大量空白"。
    const text = PREFIX + body
    const id = 'r' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

    // 通道都没挂上（宿主没连 CDP / relay 关了）→ 直接兜底
    if (typeof window.__dshRelay !== 'function') {
      fallbackCopy(text, '接力通道未连接')
      hideBubble()
      return
    }

    if (pending && pending.timer) clearTimeout(pending.timer)
    pending = HOST_SUPPORTS_ACK
      ? {
          id,
          text,
          timer: setTimeout(() => {
            if (pending && pending.id === id) {
              const t = pending.text
              pending = null
              fallbackCopy(t, '等待 DSH 回执超时')
              hideBubble()
            }
          }, ACK_TIMEOUT_MS),
        }
      : null

    try {
      if (bubbleBtn) {
        // 旧宿主没有回执通道：不要把气泡永远挂在「发送中…」，直接给个已发送 + 自动收起
        bubbleBtn.disabled = true
        bubbleBtn.textContent = HOST_SUPPORTS_ACK ? '发送中…' : '✓ 已发送'
        if (!HOST_SUPPORTS_ACK) hideTimer = setTimeout(hideBubble, 1200)
      }
    } catch (err) {
      /* 忽略 */
    }

    send({
      kind: 'relay',
      id,
      text,
      meta: {
        url: location.href,
        title: (document.title || '').slice(0, 120),
        chars: text.length,
        selected: body.length,
        source: 'selection',
        at: Date.now(),
      },
    })
  }

  function onBubbleClick() {
    // 优先用实时选区；如果点下去的瞬间选区被清了，就用 mouseup 时记下的那份
    const text = selectionText() || lastSelection || ''
    deliver(text)
  }

  /**
   * 宿主回执入口。宿主用 CDP 执行：
   *   window.__dshRelayAck({ id, ok, detail })
   */
  window.__dshRelayAck = function (payload) {
    try {
      const r = typeof payload === 'string' ? JSON.parse(payload) : payload
      if (!r || !pending || String(r.id) !== String(pending.id)) return
      const p = pending
      pending = null
      if (p.timer) clearTimeout(p.timer)
      if (r.ok === true) {
        try {
          if (bubbleBtn) bubbleBtn.textContent = '✓ 已传给 DSH'
        } catch (err) {
          /* 忽略 */
        }
        hideTimer = setTimeout(hideBubble, 1200)
      } else {
        fallbackCopy(p.text, r.detail || 'DSH 侧没有写入输入框')
        hideBubble()
      }
    } catch (err) {
      /* 回执坏了不能影响页面 */
    }
  }

  // ───────────────────────── 事件绑定 ─────────────────────────

  // 划词后浮出气泡（capture 阶段，保证不被站点自己的 mouseup 处理器吞掉）
  document.addEventListener(
    'mouseup',
    (ev) => {
      try {
        // 点的是气泡自己 —— 交给气泡的处理器，不要重算
        if (bubble && bubble.contains(ev.target)) return
        lastPoint = { x: ev.clientX, y: ev.clientY }
        // 等一拍：mouseup 的这一刻选区可能还没定稿
        setTimeout(() => {
          const text = selectionText()
          if (!text) {
            hideBubble()
            return
          }
          lastSelection = text
          showBubble(lastPoint.x, lastPoint.y, text)
        }, 0)
      } catch (err) {
        /* 忽略 */
      }
    },
    true,
  )

  // 点别处 → 收起
  document.addEventListener(
    'mousedown',
    (ev) => {
      try {
        if (bubble && !bubble.contains(ev.target)) hideBubble()
      } catch (err) {
        /* 忽略 */
      }
    },
    true,
  )

  // 滚动 → 收起（capture 才能收到内层滚动容器的 scroll）
  window.addEventListener('scroll', () => hideBubble(), true)

  // Esc → 收起
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) hideBubble()
    },
    true,
  )

  // 选区没了（比如点了空白处把选中取消）→ 收起
  document.addEventListener(
    'selectionchange',
    () => {
      try {
        if (!selectionText()) hideBubble()
      } catch (err) {
        /* 忽略 */
      }
    },
    true,
  )

  send({
    kind: 'ready',
    url: location.href,
    log: LOG,
    mode: 'selection-bubble',
    scriptVersion: SCRIPT_VERSION,
    clean: CLEAN_VERSION,
    bubble: BUBBLE_TEXT,
    prefix: PREFIX.trim(),
    legacyRemoved: removeLegacyButtons(),
  })

  // 升级残留清理：只在刚装上的一分钟内盯着（旧版 observer 会复活按钮）
  let cleanupTicks = 0
  const cleanupTimer = setInterval(() => {
    cleanupTicks++
    const n = removeLegacyButtons()
    if (n > 0) send({ kind: 'ready', url: location.href, note: 'removed-legacy-buttons', n: n })
    if (cleanupTicks >= 30) clearInterval(cleanupTimer)
  }, 2000)
})()
