/**
 * Browser half of `dsh-sidebar-browser-agent`.
 *
 * Two jobs:
 *  1. Run the long-poll bridge to the Host tool half.
 *  2. Drive the native right-sidebar browser. Tab management uses the public
 *     `ctx.sidebarRight` controller; page content, clicking, typing and
 *     screenshots use the **native Electron guest** the sidebar browser mounts:
 *     the `<webview data-sidebar-browser-frame="webview">` belonging to a tab
 *     body. Its Chromium guest API (`executeJavaScript`, `capturePage`,
 *     `sendInputEvent`, `loadURL`, `reload`) gives full access to the real
 *     page without any proxy or browser automation dependency.
 *
 * DOM mapping: the sidebar renders both a title wrapper and a body wrapper
 * carrying `data-sidebar-right-tab="<tabId>"` inside one
 * `[data-sidebar-right-session]` root; the body wrapper contains the webview.
 *
 * In a Web (non-Electron) build the sidebar browser renders a sandboxed
 * cross-origin iframe instead. Tab management still works there; page actions
 * fail with a clear explanation and the agent can fall back to `web_fetch`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-browser-agent',
  factory(require) {
    const React = require('react')
    const PLUGIN_ROOT = 'plugin/sidebar-browser-agent'
    const MAX_BACKOFF_MS = 5_000
    const BASE_BACKOFF_MS = 400
    const MAX_EVAL_CHARS = 100_000
    /** Plugin version reported by diagnostics; keep in sync with package.json. */
    const PLUGIN_VERSION = '0.2.4'
    const MAX_SCREENSHOT_WIDTH = 1_400
    const MAX_SCREENSHOT_BASE64 = 12_000_000

    /**
     * Resolve a host route against this page's own base.
     *
     * A relative path keeps a reverse-proxy directory prefix, and the Electron
     * desktop shell forwards every non-static `dsh-app://app/...` path to the
     * Harness host, so the same expression reaches the bridge in both carriers.
     * @param path - route relative to the application root.
     * @returns absolute request URL.
     */
    function hostUrl(path) {
      const raw = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
        ? document.baseURI
        : 'http://dsh.internal/'
      const base = new URL(raw)
      base.search = ''
      base.hash = ''
      if (!base.pathname.endsWith('/')) base.pathname += '/'
      return new URL(path.replace(/^\/+/, ''), base.href).toString()
    }

    /** @returns a fresh opaque page-instance id. */
    function newClientId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch {
        /* fall through */
      }
      return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    /**
     * @param error - thrown value.
     * @returns a printable message.
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    /**
     * @param ms - milliseconds to wait.
     * @returns a promise resolving after the delay.
     */
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // ---------------------------------------------------------------------
    // Native carrier detection and DOM mapping
    // ---------------------------------------------------------------------

    /**
     * Describe the carrier this page can use for page content.
     * @returns `{ kind, native }` where kind is desktop-webview, web-iframe or none.
     */
    function detectCarrier() {
      const desktop = globalThis.dshDesktop
      if (desktop !== null && typeof desktop === 'object' && desktop.browser !== undefined) {
        return { kind: 'electron-webview', native: true }
      }
      if (typeof document !== 'undefined' && document.querySelector('iframe[data-sidebar-browser-frame]') !== null) {
        return { kind: 'web-iframe', native: false }
      }
      return { kind: 'none', native: false }
    }

    /**
     * Locate the sidebar surface root for one session.
     * @param sessionId - owning conversation.
     * @returns the session root element, or undefined when no surface is mounted.
     */
    function sessionRootOf(sessionId) {
      const roots = document.querySelectorAll('[data-sidebar-right-session]')
      for (const element of roots) {
        if (element.dataset.sidebarRightSession === sessionId) return element
      }
      return undefined
    }

    /**
     * Locate the native guest of one sidebar browser tab.
     * The title wrapper and the body wrapper share the tab marker; only the
     * body wrapper contains the webview, so every candidate is searched.
     * @param sessionId - owning conversation.
     * @param tabId - sidebar tab id.
     * @returns the live `<webview>` element.
     */
    function findWebview(sessionId, tabId) {
      const root = sessionRootOf(sessionId)
      if (root === undefined) {
        throw new Error(`The right sidebar has no surface for conversation ${sessionId}; open that conversation and focus its browser tab.`)
      }
      const marker = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(tabId) : tabId
      const wrappers = root.querySelectorAll(`[data-sidebar-right-tab="${marker}"]`)
      for (const wrapper of wrappers) {
        const webview = wrapper.querySelector('webview[data-sidebar-browser-frame]')
        if (webview !== null) return webview
      }
      throw new Error(`Browser tab ${tabId} has no native guest mounted yet. Focus that tab in the sidebar, wait for it to finish loading, or reload it with sidebar_browser action "reload".`)
    }

    /**
     * Find the guest without throwing; used for best-effort URL/title reporting.
     * @param sessionId - owning conversation.
     * @param tabId - sidebar tab id.
     * @returns the webview element or undefined.
     */
    function tryFindWebview(sessionId, tabId) {
      try {
        return findWebview(sessionId, tabId)
      } catch {
        return undefined
      }
    }

    /**
     * Run one self-contained function inside the guest page and await its result.
     * The function is serialized, so it must not close over page-module values.
     * @param webview - native guest element.
     * @param fn - self-contained function, optionally async.
     * @param arg - JSON-serializable single argument.
     * @param userGesture - whether Chromium should treat the call as user activation.
     * @returns the guest result.
     */
    async function runInGuest(webview, fn, arg, userGesture = false) {
      const source = `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`
      try {
        return await webview.executeJavaScript(source, userGesture)
      } catch (error) {
        throw new Error(`The page context rejected the script: ${messageOf(error)}`)
      }
    }

    /**
     * Wait for the guest document to be interactive.
     * @param webview - native guest element.
     */
    async function ensureGuestReady(webview) {
      // `isLoading()` reflects every outstanding asset, so a slow image or a
      // long-poll can keep it true long after the document is usable (GitHub's
      // login and 2FA screens do this). Readiness therefore follows the
      // document's own `readyState`, bounded so a genuinely stuck parse fails.
      let state
      try {
        state = await runInGuest(webview, function guestDocumentReady() {
          return new Promise((resolve) => {
            const report = () => resolve({ readyState: document.readyState, url: location.href })
            if (document.readyState !== 'loading') {
              report()
              return
            }
            const timer = setTimeout(report, 5000)
            document.addEventListener('DOMContentLoaded', () => {
              clearTimeout(timer)
              report()
            }, { once: true })
          })
        })
      } catch (error) {
        throw new Error(`The native page guest is not ready: ${messageOf(error)}`)
      }
      if (state === null || typeof state !== 'object' || state.readyState === 'loading') {
        throw new Error('The page is still parsing its document; retry in a moment.')
      }
    }

    // ---------------------------------------------------------------------
    // Guest scripts (each self-contained: serialized with fn.toString())
    // ---------------------------------------------------------------------

    /** @returns page identity, viewport and scroll facts. */
    function guestPageInfo() {
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
      }
    }

    /**
     * Read visible text of the body or one element.
     * @param arg - `{ selector?, maxChars? }`.
     */
    function guestReadText(arg) {
      const options = arg || {}
      const target = options.selector ? document.querySelector(options.selector) : document.body
      if (target === null) return { ok: false, error: `selector not found: ${options.selector}` }
      const text = String(target.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      const max = typeof options.maxChars === 'number' ? options.maxChars : 12000
      return {
        ok: true,
        url: location.href,
        title: document.title,
        text: text.slice(0, max),
        totalChars: text.length,
        truncated: text.length > max,
      }
    }

    /**
     * Read outer HTML of the document or one element.
     * @param arg - `{ selector?, maxChars? }`.
     */
    function guestReadHtml(arg) {
      const options = arg || {}
      const target = options.selector ? document.querySelector(options.selector) : document.documentElement
      if (target === null) return { ok: false, error: `selector not found: ${options.selector}` }
      const html = String(target.outerHTML ?? '')
      const max = typeof options.maxChars === 'number' ? options.maxChars : 30000
      return {
        ok: true,
        url: location.href,
        title: document.title,
        html: html.slice(0, max),
        totalChars: html.length,
        truncated: html.length > max,
      }
    }

    /**
     * List visible interactive elements with stable selectors and viewport centres.
     * @param arg - `{ maxElements? }`.
     */
    function guestInteractive(arg) {
      const options = arg || {}
      const max = typeof options.maxElements === 'number' ? options.maxElements : 200
      const selector = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[contenteditable="true"],[onclick]'
      function visible(el) {
        const rect = el.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        if (Number(style.opacity) === 0) return false
        return true
      }
      function labelOf(el) {
        const raw = el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.getAttribute('placeholder')
          || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? el.value : '')
          || el.innerText
          || ''
        return String(raw).trim().replace(/\s+/g, ' ').slice(0, 120)
      }
      function cssPath(el) {
        if (el.id !== '') {
          const byId = '#' + CSS.escape(el.id)
          try {
            if (document.querySelectorAll(byId).length === 1) return byId
          } catch (error) {
            void error
          }
        }
        const parts = []
        let node = el
        while (node !== null && node !== document.documentElement && parts.length < 8) {
          let part = node.tagName.toLowerCase()
          const parent = node.parentElement
          if (parent !== null) {
            const sameTag = []
            for (const child of parent.children) if (child.tagName === node.tagName) sameTag.push(child)
            const index = sameTag.indexOf(node)
            if (sameTag.length > 1 && index >= 0) part += `:nth-of-type(${index + 1})`
          }
          parts.unshift(part)
          if (parent === null) break
          const candidate = parts.join(' > ')
          try {
            if (document.querySelectorAll(candidate).length === 1) return candidate
          } catch (error) {
            void error
          }
          node = parent
        }
        return parts.join(' > ')
      }
      const elements = []
      const seen = new Set()
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue
        seen.add(el)
        if (!visible(el)) continue
        const rect = el.getBoundingClientRect()
        const tag = el.tagName.toLowerCase()
        const type = el.getAttribute('type') || ''
        const label = labelOf(el)
        const selectorText = cssPath(el)
        const entry = {
          index: elements.length,
          tag,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        }
        if (type !== '') entry.type = type
        if (label !== '') entry.label = label
        if (selectorText !== '') entry.selector = selectorText
        if (tag === 'a' && typeof el.href === 'string' && el.href !== '') entry.href = el.href.slice(0, 300)
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') entry.disabled = true
        elements.push(entry)
        if (elements.length >= max) break
      }
      return {
        ok: true,
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
        elements,
      }
    }

    /**
     * Resolve a click target to viewport coordinates.
     * @param arg - `{ selector?, contains?, x?, y? }`.
     */
    function guestResolveClickable(arg) {
      const options = arg || {}
      function visible(el) {
        const rect = el.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const style = getComputedStyle(el)
        return style.visibility !== 'hidden' && style.display !== 'none'
      }
      function labelOf(el) {
        const raw = el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.getAttribute('placeholder')
          || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : '')
          || el.innerText
          || ''
        return String(raw).trim().replace(/\s+/g, ' ')
      }
      if (typeof options.x === 'number' && typeof options.y === 'number') {
        const hit = document.elementFromPoint(options.x, options.y)
        if (hit === null) return { ok: false, error: 'nothing is rendered at those coordinates' }
        return {
          ok: true,
          x: Math.round(options.x),
          y: Math.round(options.y),
          tag: hit.tagName.toLowerCase(),
          label: labelOf(hit).slice(0, 120),
        }
      }
      const clickable = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[contenteditable="true"],[onclick]'
      let target = null
      if (typeof options.selector === 'string' && options.selector !== '') {
        target = document.querySelector(options.selector)
        if (target === null) return { ok: false, error: `selector not found: ${options.selector}` }
      } else if (typeof options.contains === 'string' && options.contains !== '') {
        const needle = options.contains.toLowerCase()
        for (const el of document.querySelectorAll(clickable)) {
          if (!visible(el)) continue
          if (labelOf(el).toLowerCase().includes(needle)) {
            target = el
            break
          }
        }
        if (target === null) return { ok: false, error: `no visible clickable element contains "${options.contains}"` }
      } else {
        return { ok: false, error: 'click needs a selector, a contains text, or x/y coordinates' }
      }
      target.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = target.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return { ok: false, error: 'the target has no visible box' }
      return {
        ok: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        tag: target.tagName.toLowerCase(),
        label: labelOf(target).slice(0, 120),
      }
    }

    /**
     * Focus a form field and write text into it, dispatching real input events.
     * @param arg - `{ selector?, text, clear? }`.
     */
    function guestFocusAndType(arg) {
      const options = arg || {}
      let el = null
      if (typeof options.selector === 'string' && options.selector !== '') {
        el = document.querySelector(options.selector)
        if (el === null) return { ok: false, error: `selector not found: ${options.selector}` }
      } else {
        el = document.activeElement
        if (el === null || el === document.body || el === document.documentElement) {
          return { ok: false, error: 'no field is focused; pass a selector' }
        }
      }
      el.scrollIntoView({ block: 'center' })
      if (typeof el.focus === 'function') el.focus()
      const text = String(options.text === undefined ? '' : options.text)
      const clear = options.clear !== false
      if (el.isContentEditable === true) {
        const selection = window.getSelection()
        if (selection !== null) {
          const range = document.createRange()
          range.selectNodeContents(el)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        if (clear) document.execCommand('delete', false)
        document.execCommand('insertText', false, text)
      } else {
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
        const next = (clear ? '' : String(el.value ?? '')) + text
        if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(el, next)
        else el.value = next
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        valueLength: String(el.value === undefined ? el.textContent ?? '' : el.value).length,
        url: location.href,
        title: document.title,
      }
    }

    /**
     * Scroll the page or bring one element into view.
     * @param arg - `{ dx?, dy?, selector? }`.
     */
    function guestScroll(arg) {
      const options = arg || {}
      if (typeof options.selector === 'string' && options.selector !== '') {
        const el = document.querySelector(options.selector)
        if (el === null) return { ok: false, error: `selector not found: ${options.selector}` }
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
      } else {
        scrollBy({ left: Number(options.dx) || 0, top: Number(options.dy) || 0, behavior: 'auto' })
      }
      return {
        ok: true,
        url: location.href,
        title: document.title,
        scrollX: Math.round(scrollX),
        scrollY: Math.round(scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight,
      }
    }

    /**
     * Poll the page for a selector or visible text.
     * @param arg - `{ selector?, contains?, timeoutMs? }`.
     */
    function guestWait(arg) {
      const options = arg || {}
      const timeout = typeof options.timeoutMs === 'number' ? Math.min(Math.max(options.timeoutMs, 100), 15000) : 5000
      const started = performance.now()
      const selector = typeof options.selector === 'string' ? options.selector : ''
      const contains = typeof options.contains === 'string' ? options.contains.toLowerCase() : ''
      return new Promise((resolve) => {
        function check() {
          const elapsed = Math.round(performance.now() - started)
          if (selector !== '') {
            let found = null
            try {
              found = document.querySelector(selector)
            } catch (error) {
              resolve({ ok: false, error: `invalid selector: ${String(error && error.message ? error.message : error)}` })
              return
            }
            if (found !== null) {
              found.scrollIntoView({ block: 'center' })
              resolve({ ok: true, matched: true, waitedMs: elapsed, selector, url: location.href, title: document.title })
              return
            }
          } else if (contains !== '') {
            const body = document.body
            const text = body === null ? '' : String(body.innerText ?? '').toLowerCase()
            if (text.includes(contains)) {
              resolve({ ok: true, matched: true, waitedMs: elapsed, url: location.href, title: document.title })
              return
            }
          } else {
            resolve({ ok: false, error: 'wait needs a selector or contains text' })
            return
          }
          if (performance.now() - started >= timeout) {
            resolve({ ok: true, matched: false, waitedMs: elapsed, url: location.href, title: document.title })
            return
          }
          setTimeout(check, 120)
        }
        check()
      })
    }

    // ---------------------------------------------------------------------
    // Native input helpers (Electron guest)
    // ---------------------------------------------------------------------

    /**
     * Dispatch one trusted native mouse click at guest viewport coordinates.
     * @param webview - native guest element.
     * @param point - `{ x, y }` CSS-pixel centre.
     */
    async function nativeClick(webview, point) {
      const x = Math.max(0, Math.round(point.x))
      const y = Math.max(0, Math.round(point.y))
      if (typeof webview.focus === 'function') webview.focus()
      webview.sendInputEvent({ type: 'mouseMove', x, y })
      await sleep(30)
      webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      await sleep(20)
      webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await sleep(60)
    }

    /** Keys `press` accepts, mapped to Chromium's key codes. */
    const KEY_CODES = {
      enter: 'Enter',
      return: 'Enter',
      tab: 'Tab',
      escape: 'Escape',
      esc: 'Escape',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      pagedown: 'PageDown',
      pageup: 'PageUp',
      home: 'Home',
      end: 'End',
      space: 'Space',
    }

    /**
     * Dispatch one trusted native key press to the focused guest element.
     * @param webview - native guest element.
     * @param key - user-facing key name.
     * @returns the Chromium key code used.
     */
    async function nativeKey(webview, key) {
      const raw = String(key).trim().toLowerCase()
      const code = KEY_CODES[raw] ?? (raw.length === 1 ? raw : undefined)
      if (code === undefined) throw new Error(`unsupported key "${key}"; use one of: ${Object.keys(KEY_CODES).join(', ')}`)
      if (typeof webview.focus === 'function') webview.focus()
      webview.sendInputEvent({ type: 'keyDown', keyCode: code })
      if (code === 'Enter') webview.sendInputEvent({ type: 'char', keyCode: '\r' })
      webview.sendInputEvent({ type: 'keyUp', keyCode: code })
      await sleep(80)
      return code
    }

    // ---------------------------------------------------------------------
    // Screenshot
    // ---------------------------------------------------------------------

    /**
     * Capture the guest viewport as a bounded PNG.
     * @param webview - native guest element.
     * @returns `{ base64, width, height, originalWidth, originalHeight }`.
     */
    async function captureScreenshot(webview) {
      if (typeof webview.capturePage !== 'function') throw new Error('the native guest exposes no capturePage API')
      let image
      try {
        image = await webview.capturePage()
      } catch (error) {
        throw new Error(`The native page could not be captured (${messageOf(error)}). Chromium cannot capture a guest whose conversation is hidden; switch back to the calling conversation or focus its browser tab, then retry the screenshot.`)
      }
      const size = image.getSize()
      let output = image
      let width = size.width
      const widths = [MAX_SCREENSHOT_WIDTH, 1200, 1000, 800]
      for (const candidate of widths) {
        if (width <= candidate) break
        output = image.resize({ width: candidate, quality: 'good' })
        width = output.getSize().width
        const probe = output.toDataURL()
        if (probe.length - probe.indexOf(',') - 1 <= MAX_SCREENSHOT_BASE64) break
      }
      const dataUrl = output.toDataURL()
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      if (base64.length === 0) throw new Error('the native guest returned an empty screenshot')
      if (base64.length > MAX_SCREENSHOT_BASE64) throw new Error('the screenshot is too large to transfer; scroll or zoom out and retry')
      const finalSize = output.getSize()
      return {
        base64,
        width: finalSize.width,
        height: finalSize.height,
        originalWidth: size.width,
        originalHeight: size.height,
      }
    }

    // ---------------------------------------------------------------------
    // Sidebar state helpers
    // ---------------------------------------------------------------------

    /**
     * @param ctx - client plugin context.
     * @returns the session the right sidebar currently shows, if any.
     */
    function mountedSession(ctx) {
      try {
        const value = ctx.sidebarRight?.mounted?.getSnapshot?.()
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch {
        return undefined
      }
    }

    /**
     * @param ctx - client plugin context.
     * @returns every known open tab record (all sessions).
     */
    function allOpenTabs(ctx) {
      try {
        const value = ctx.sidebarRight?.openTabs?.getSnapshot?.()
        return Array.isArray(value) ? value : []
      } catch {
        return []
      }
    }

    /**
     * @param ctx - client plugin context.
     * @param sessionId - session to filter by.
     * @returns that session's native browser tabs.
     */
    function browserTabs(ctx, sessionId) {
      return allOpenTabs(ctx).filter((tab) => tab !== null && typeof tab === 'object' && tab.kind === 'browser' && tab.sessionId === sessionId)
    }

    /**
     * Require the calling session to be the one on screen.
     * @param ctx - client plugin context.
     * @param sessionId - calling conversation.
     * @returns the on-screen session.
     */
    function requireMounted(ctx, sessionId) {
      const mounted = mountedSession(ctx)
      if (mounted === undefined) {
        throw new Error('The right sidebar has no conversation on screen; open the calling conversation and retry.')
      }
      if (mounted !== sessionId) {
        throw new Error(`The right sidebar is showing conversation ${mounted}, not the calling conversation ${sessionId}; switch to the calling conversation and retry.`)
      }
      return mounted
    }

    /**
     * Require the calling conversation's sidebar surface to exist in this page.
     * The surface stays mounted (hidden) while another conversation is on
     * screen, so page work continues in the background.
     * @param sessionId - calling conversation.
     */
    function assertPageSurface(sessionId) {
      if (sessionRootOf(sessionId) === undefined) {
        throw new Error(`The calling conversation ${sessionId} has no right-sidebar surface in this page yet; switch to that conversation once so its sidebar initializes, then retry.`)
      }
    }

    /**
     * Resolve a tab the tool named and prove it belongs to the calling session.
     * @param ctx - client plugin context.
     * @param sessionId - calling conversation.
     * @param tabId - model-supplied tab id, or empty for the active tab.
     * @returns the matching open-tab record.
     */
    function resolveTab(ctx, sessionId, tabId) {
      const tabs = browserTabs(ctx, sessionId)
      if (tabs.length === 0) {
        throw new Error('No native browser tab is open in this conversation; open one with sidebar_browser action "open" first.')
      }
      if (typeof tabId === 'string' && tabId !== '') {
        const tab = tabs.find((candidate) => candidate.tabId === tabId)
        if (tab === undefined) {
          throw new Error(`No native browser tab "${tabId}" is open for this conversation; call sidebar_browser action "list" to see the open tabs.`)
        }
        return tab
      }
      if (mountedSession(ctx) === sessionId) {
        const active = activeTabId(ctx)
        const activeTab = tabs.find((candidate) => candidate.tabId === active)
        if (activeTab !== undefined) return activeTab
      }
      if (tabs.length === 1) return tabs[0]
      throw new Error(`multiple browser tabs are open; pass tabId (${tabs.map((tab) => tab.tabId).join(', ')})`)
    }

    /**
     * @param ctx - client plugin context.
     * @returns the active tab id for the on-screen session, if any.
     */
    function activeTabId(ctx) {
      try {
        const record = ctx.sidebarRight?.active?.()
        return typeof record?.id === 'string' ? record.id : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Best-effort native facts for one tab.
     * @param sessionId - owning conversation.
     * @param tabId - sidebar tab id.
     * @returns `{ url?, title? }`.
     */
    function nativeFacts(sessionId, tabId) {
      const facts = {}
      const webview = tryFindWebview(sessionId, tabId)
      if (webview === undefined) return facts
      try {
        const url = typeof webview.getURL === 'function' ? webview.getURL() : ''
        if (typeof url === 'string' && url !== '' && url !== 'about:blank') facts.url = url
      } catch (error) {
        void error
      }
      try {
        const title = typeof webview.getTitle === 'function' ? webview.getTitle() : ''
        if (typeof title === 'string' && title !== '') facts.title = title
      } catch (error) {
        void error
      }
      return facts
    }

    // ---------------------------------------------------------------------
    // Transport relay helpers
    // ---------------------------------------------------------------------

    /**
     * Viewport CSS-pixel point for one click request.
     * @param webview - native guest.
     * @param command - bridge command.
     * @returns `{ x, y }` in guest viewport coordinates.
     */
    async function resolveClickPoint(webview, command) {
      const arg = {
        ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
        ...(typeof command.contains === 'string' && command.contains !== '' ? { contains: command.contains } : {}),
        ...(typeof command.x === 'number' && typeof command.y === 'number' ? { x: command.x, y: command.y } : {}),
      }
      const resolved = await runInGuest(webview, guestResolveClickable, arg)
      if (resolved === null || typeof resolved !== 'object' || resolved.ok !== true) {
        throw new Error(resolved?.error ?? 'click target was not found')
      }
      return resolved
    }

    /**
     * Execute one page-content command inside the native guest.
     * @param ctx - client plugin context.
     * @param command - bridge command.
     * @returns bridge result `{ ok, value? , error? }`.
     */
    async function runPageCommand(ctx, command) {
      const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
      if (sessionId === '') throw new Error('the host did not name a calling session')
      assertPageSurface(sessionId)
      const carrier = detectCarrier()
      if (carrier.native !== true) {
        throw new Error(`Page content control needs the Desktop native browser carrier (Electron webview); this build uses ${carrier.kind === 'web-iframe' ? 'a sandboxed cross-origin iframe' : 'an unknown carrier'} that page script cannot inspect. Tab management still works; use web_fetch to read page text.`)
      }
      const tab = resolveTab(ctx, sessionId, command.tabId)
      const webview = findWebview(sessionId, tab.tabId)
      await ensureGuestReady(webview)
      const base = { sessionId, tabId: tab.tabId }

      if (command.action === 'screenshot') {
        const shot = await captureScreenshot(webview)
        const info = await runInGuest(webview, guestPageInfo).catch(() => ({}))
        return {
          ok: true,
          value: {
            action: 'screenshot',
            ...base,
            url: typeof info.url === 'string' ? info.url : '',
            title: typeof info.title === 'string' ? info.title : '',
            width: shot.width,
            height: shot.height,
            mediaType: 'image/png',
            base64: shot.base64,
          },
        }
      }

      if (command.action === 'read') {
        const mode = typeof command.mode === 'string' ? command.mode : 'text'
        if (mode === 'interactive') {
          const info = await runInGuest(webview, guestInteractive, {
            ...(typeof command.maxElements === 'number' ? { maxElements: command.maxElements } : {}),
          })
          const { ok: _interactiveOk, ...facts } = info
          void _interactiveOk
          return { ok: true, value: { action: 'read', ...base, mode, ...facts } }
        }
        if (mode === 'html') {
          const info = await runInGuest(webview, guestReadHtml, {
            ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
            ...(typeof command.maxChars === 'number' ? { maxChars: command.maxChars } : {}),
          })
          if (info.ok !== true) throw new Error(info.error ?? 'could not read page HTML')
          const { ok: _interactiveOk, ...facts } = info
          void _interactiveOk
          return { ok: true, value: { action: 'read', ...base, mode, ...facts } }
        }
        const info = await runInGuest(webview, guestReadText, {
          ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
          ...(typeof command.maxChars === 'number' ? { maxChars: command.maxChars } : {}),
        })
        if (info.ok !== true) throw new Error(info.error ?? 'could not read page text')
        const { ok: _textOk, ...facts } = info
        void _textOk
        return { ok: true, value: { action: 'read', ...base, mode: 'text', ...facts } }
      }

      if (command.action === 'click') {
        const resolved = await resolveClickPoint(webview, command)
        await nativeClick(webview, resolved)
        const info = await runInGuest(webview, guestPageInfo).catch(() => ({}))
        return {
          ok: true,
          value: {
            action: 'click',
            ...base,
            url: typeof info.url === 'string' ? info.url : '',
            title: typeof info.title === 'string' ? info.title : '',
            target: {
              tag: resolved.tag,
              ...(typeof resolved.label === 'string' && resolved.label !== '' ? { label: resolved.label } : {}),
              ...(typeof resolved.selector === 'string' && resolved.selector !== '' ? { selector: resolved.selector } : {}),
              x: resolved.x,
              y: resolved.y,
            },
          },
        }
      }

      if (command.action === 'type') {
        const info = await runInGuest(webview, guestFocusAndType, {
          ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
          text: String(command.text === undefined ? '' : command.text),
          clear: command.clear !== false,
        })
        if (info.ok !== true) throw new Error(info.error ?? 'could not type into the page')
        let submitted = false
        if (command.submit === true) {
          await nativeKey(webview, 'Enter')
          submitted = true
        }
        const page = await runInGuest(webview, guestPageInfo).catch(() => ({}))
        return {
          ok: true,
          value: {
            action: 'type',
            ...base,
            url: typeof page.url === 'string' ? page.url : '',
            title: typeof page.title === 'string' ? page.title : '',
            target: { tag: info.tag, ...(typeof info.selector === 'string' && info.selector !== '' ? { selector: info.selector } : {}) },
            typed: String(command.text === undefined ? '' : command.text).length,
            submitted,
          },
        }
      }

      if (command.action === 'press') {
        const code = await nativeKey(webview, command.key)
        const info = await runInGuest(webview, guestPageInfo).catch(() => ({}))
        return {
          ok: true,
          value: {
            action: 'press',
            ...base,
            url: typeof info.url === 'string' ? info.url : '',
            title: typeof info.title === 'string' ? info.title : '',
            key: code,
          },
        }
      }

      if (command.action === 'scroll') {
        const info = await runInGuest(webview, guestScroll, {
          ...(typeof command.dx === 'number' ? { dx: command.dx } : {}),
          ...(typeof command.dy === 'number' ? { dy: command.dy } : {}),
          ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
        })
        if (info.ok !== true) throw new Error(info.error ?? 'could not scroll the page')
        const { ok: _scrollOk, ...facts } = info
        void _scrollOk
        return { ok: true, value: { action: 'scroll', ...base, ...facts } }
      }

      if (command.action === 'wait') {
        const info = await runInGuest(webview, guestWait, {
          ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
          ...(typeof command.contains === 'string' && command.contains !== '' ? { contains: command.contains } : {}),
          ...(typeof command.timeoutMs === 'number' ? { timeoutMs: command.timeoutMs } : {}),
        })
        if (info.ok !== true) throw new Error(info.error ?? 'wait failed')
        const page = await runInGuest(webview, guestPageInfo).catch(() => ({}))
        return {
          ok: true,
          value: {
            action: 'wait',
            ...base,
            url: typeof page.url === 'string' ? page.url : '',
            title: typeof page.title === 'string' ? page.title : '',
            matched: info.matched === true,
            waitedMs: typeof info.waitedMs === 'number' ? info.waitedMs : 0,
            ...(typeof command.selector === 'string' && command.selector !== '' ? { selector: command.selector } : {}),
            ...(typeof command.contains === 'string' && command.contains !== '' ? { contains: command.contains } : {}),
          },
        }
      }

      if (command.action === 'eval') {
        const code = typeof command.code === 'string' ? command.code : ''
        if (code.trim() === '') throw new Error('eval needs a non-empty JavaScript code string')
        let raw
        try {
          raw = await webview.executeJavaScript(code, true)
        } catch (error) {
          throw new Error(`guest JavaScript failed: ${messageOf(error)}`)
        }
        let text
        try {
          const serialized = JSON.stringify(raw)
          text = serialized === undefined ? String(raw) : serialized
        } catch (error) {
          text = String(raw)
          void error
        }
        const truncated = text.length > MAX_EVAL_CHARS
        const info = await runInGuest(webview, guestPageInfo).catch(() => ({}))
        return {
          ok: true,
          value: {
            action: 'eval',
            ...base,
            url: typeof info.url === 'string' ? info.url : '',
            title: typeof info.title === 'string' ? info.title : '',
            result: truncated ? `${text.slice(0, MAX_EVAL_CHARS)} … (truncated)` : text,
            truncated,
          },
        }
      }

      throw new Error(`unknown page action "${String(command.action)}"`)
    }

    /**
     * Collect carrier and contract diagnostics for the `status` action.
     * @param ctx - client plugin context.
     * @param sessionId - calling conversation ('' when unknown).
     * @returns JSON-safe diagnostic facts.
     */
    function carrierChecks(ctx, sessionId) {
      const carrier = detectCarrier()
      const checks = {
        plugin: PLUGIN_VERSION,
        carrier: carrier.kind,
        native: carrier.native === true,
        webviews: document.querySelectorAll('webview').length,
        tabWrappers: document.querySelectorAll('[data-sidebar-right-tab]').length,
      }
      try {
        const configForms = ctx.get?.('configForms')
        const form = configForms?.get?.(CONFIG_ENTRY_ID)
        const snapshot = form?.getSnapshot?.()
        if (snapshot !== undefined) checks.configForm = snapshot.status
      } catch (error) {
        void error
      }
      const boot = globalThis.__DSH_BOOT__
      if (boot !== null && typeof boot === 'object' && boot.release !== null && typeof boot.release === 'object') {
        checks.harness = typeof boot.release.version === 'string' ? boot.release.version : 'unknown'
        if (typeof boot.release.commit === 'string') checks.commit = boot.release.commit
      }
      const mounted = mountedSession(ctx)
      const target = sessionId !== '' ? sessionId : (mounted ?? '')
      const surface = target === '' ? undefined : sessionRootOf(target)
      checks.surface = surface !== undefined
      if (surface !== undefined) {
        const wrappers = surface.querySelectorAll('[data-sidebar-right-tab]')
        checks.tabWrappers = wrappers.length
        let webview = null
        for (const wrapper of wrappers) {
          const found = wrapper.querySelector('webview[data-sidebar-browser-frame]')
          if (found !== null) {
            webview = found
            break
          }
        }
        checks.webview = webview !== null
        if (webview !== null) {
          const api = ['executeJavaScript', 'capturePage', 'sendInputEvent', 'loadURL', 'reload', 'getURL', 'getTitle']
          checks.api = api.filter((name) => typeof webview[name] === 'function')
          const missing = api.filter((name) => typeof webview[name] !== 'function')
          if (missing.length > 0) checks.apiMissing = missing
          try {
            const url = typeof webview.getURL === 'function' ? webview.getURL() : ''
            if (typeof url === 'string' && url !== '') checks.guestUrl = url
          } catch (error) {
            void error
          }
          try {
            checks.guestLoading = typeof webview.isLoading === 'function' ? webview.isLoading() === true : false
          } catch (error) {
            void error
          }
        }
      }
      return checks
    }

    // ---------------------------------------------------------------------
    // Plugin row configuration page (Plugin Manager -> bundle -> row)
    // ---------------------------------------------------------------------

    /** Locale namespace for this plugin's configuration page copy. */
    const UI_NS = 'sidebarBrowserAgent'
    /** Row this plugin's Host row is declared under (used as the settings namespace). */
    const CONFIG_ENTRY_ID = 'sidebar-browser-agent'
    /** Config page slot key: `<bundle package>#<row id>`. */
    const CONFIG_ROW_KEY = 'dsh-sidebar-browser-agent#sidebar-browser-agent'

    /** English copy for the configuration page. */
    const CONFIG_EN = {
      'config.summary': 'Configure the sidebar browser tools: enabled switches, allowed hosts and permissions.',
      'config.heading': 'Sidebar browser agent',
      'config.intro': 'Applies immediately to this profile. Page content work needs the DSH Desktop native browser carrier.',
      'config.enabled': 'Enable agent tools',
      'config.enabledHint': 'Register sidebar_browser and sidebar_page for agents in this profile.',
      'config.hosts': 'Allowed hosts',
      'config.hostsHint': 'One host per line; empty allows every HTTP(S) host. An entry also allows its subdomains; localhost:8765 matches that exact host and port.',
      'config.hostsPlaceholder': 'example.com\nlocalhost:8765',
      'config.allowEval': 'Allow eval',
      'config.allowEvalHint': 'Run arbitrary JavaScript in the page (sidebar_page action "eval").',
      'config.allowNativeInput': 'Allow native input',
      'config.allowNativeInputHint': 'Native click, type and press actions (sidebar_page click/type/press).',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saved': 'Saved.',
      'config.failed': 'The host rejected this change; the form was reloaded.',
      'config.reset': 'Reset',
      'config.loading': 'Loading configuration…',
      'config.unavailable': 'Configuration is not editable in this profile (the settings service is unavailable).',
      'config.readOnly': 'This profile is read-only.',
      'config.readOnlyHint': 'The host does not accept configuration writes here.',
    }

    /** Chinese copy for the configuration page. */
    const CONFIG_ZH = {
      'config.summary': '配置侧栏浏览器工具：启用开关、域名白名单与权限。',
      'config.heading': '侧栏浏览器 Agent 控制',
      'config.intro': '修改立即对本 profile 生效。页面内容操作需要 DSH Desktop 原生浏览器载体。',
      'config.enabled': '启用 Agent 工具',
      'config.enabledHint': '为本 profile 中的 Agent 注册 sidebar_browser 与 sidebar_page。',
      'config.hosts': '允许的域名',
      'config.hostsHint': '每行一个；留空允许所有 HTTP(S) 域名。写 example.com 同时允许其子域；localhost:8765 精确匹配该主机与端口。',
      'config.hostsPlaceholder': 'example.com\nlocalhost:8765',
      'config.allowEval': '允许 eval',
      'config.allowEvalHint': '允许在页面中执行任意 JavaScript（sidebar_page 的 eval 动作）。',
      'config.allowNativeInput': '允许原生输入',
      'config.allowNativeInputHint': '允许原生点击、输入与按键（sidebar_page 的 click/type/press）。',
      'config.save': '保存',
      'config.saving': '正在保存…',
      'config.saved': '已保存。',
      'config.failed': 'Host 拒绝了这次修改，表单已重新加载。',
      'config.reset': '重置',
      'config.loading': '正在加载配置…',
      'config.unavailable': '此 profile 无法编辑配置（settings 服务不可用）。',
      'config.readOnly': '此 profile 为只读。',
      'config.readOnlyHint': 'Host 不接受在此写入配置。',
    }

    const configStyles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '620px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: '20px' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', margin: 0, fontSize: '12px', lineHeight: '18px' },
      notice: { color: 'var(--dsw-alias-label-secondary)', margin: 0, fontSize: '12px', lineHeight: '18px' },
      error: { color: 'var(--dsw-alias-state-error-primary)', margin: 0, fontSize: '12px', lineHeight: '18px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      checkRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer' },
      checkText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      checkLabel: { fontWeight: 500 },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '88px',
        padding: '8px 10px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        font: 'inherit',
        resize: 'vertical',
        outline: 'none',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px' },
      button: {
        height: '30px',
        padding: '0 14px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: '8px',
        cursor: 'pointer',
        font: 'inherit',
      },
      primary: {
        height: '30px',
        padding: '0 14px',
        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
        background: 'var(--dsw-alias-state-business-primary, #1f6feb)',
        border: '0.5px solid transparent',
        borderRadius: '8px',
        cursor: 'pointer',
        font: 'inherit',
      },
    }

    /**
     * Render the allowlist as one host per line.
     * @param hosts - configured host entries.
     * @returns the textarea text.
     */
    function hostsToText(hosts) {
      return Array.isArray(hosts) ? hosts.join('\n') : ''
    }

    /**
     * Parse the allowlist textarea.
     * @param text - comma or newline separated host entries.
     * @returns normalized, de-duplicated host entries.
     */
    function textToHosts(text) {
      const entries = String(text === undefined || text === null ? '' : text)
        .split(/[\n,]+/)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== '')
      return [...new Set(entries)]
    }

    /**
     * Build the Host mutation operations for one staged draft.
     * @param draft - local form draft.
     * @param value - current Host values for the row.
     * @returns ordered `{ op: 'set', path, value }` operations (empty when unchanged).
     */
    function configOps(draft, value) {
      const current = value ?? {}
      const ops = []
      for (const field of ['enabled', 'allowEval', 'allowNativeInput']) {
        const next = draft[field] !== false
        const before = current[field] !== false
        if (next !== before) ops.push({ op: 'set', path: [field], value: next })
      }
      const nextHosts = textToHosts(draft.hostsText)
      const beforeHosts = hostsToText(current.allowedHosts).split('\n').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')
      if (JSON.stringify(nextHosts) !== JSON.stringify(beforeHosts)) ops.push({ op: 'set', path: ['allowedHosts'], value: nextHosts })
      return ops
    }

    /**
     * Build the local draft from one Host value snapshot.
     * @param value - projected volatile config.
     * @returns the draft.
     */
    function draftOf(value) {
      const current = value ?? {}
      return {
        enabled: current.enabled !== false,
        allowEval: current.allowEval !== false,
        allowNativeInput: current.allowNativeInput !== false,
        hostsText: hostsToText(current.allowedHosts),
      }
    }

    /**
     * One switch row.
     * @param t - locale translate function.
     * @param options - label, hint, checked, disabled, onChange.
     * @returns the row element.
     */
    function switchRow(t, options) {
      return React.createElement('label', { style: configStyles.checkRow },
        React.createElement('input', {
          type: 'checkbox',
          checked: options.checked,
          disabled: options.disabled,
          onChange: (event) => options.onChange(event.target.checked),
        }),
        React.createElement('span', { style: configStyles.checkText },
          React.createElement('span', { style: configStyles.checkLabel }, t(options.label)),
          React.createElement('span', { style: configStyles.hint }, t(options.hint)),
        ),
      )
    }

    /** The staged form for one row's volatile configuration. */
    function ConfigEditor(props) {
      const t = props.t
      const state = props.form.state
      const value = state.value ?? {}
      const [draft, setDraft] = React.useState(() => draftOf(value))
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      React.useEffect(() => {
        setDraft(draftOf(value))
        setNotice('')
      }, [state.revision, state.status])
      if (state.status === 'loading') return React.createElement('p', { style: configStyles.notice }, t('config.loading'))
      if (state.status !== 'ready' || value === undefined) return React.createElement('p', { style: configStyles.notice }, t('config.unavailable'))
      const readOnly = state.writable === false
      const ops = configOps(draft, value)
      const save = async () => {
        if (ops.length === 0 || busy) return
        setBusy(true)
        setNotice(t('config.saving'))
        try {
          const accepted = await props.form.mutate(ops, state.revision)
          setNotice(accepted === true ? t('config.saved') : t('config.failed'))
        } catch (error) {
          setNotice(`${t('config.failed')} (${error instanceof Error ? error.message : String(error)})`)
        } finally {
          setBusy(false)
        }
      }
      return React.createElement('div', { style: configStyles.root },
        React.createElement('h3', { style: configStyles.heading }, t('config.heading')),
        React.createElement('p', { style: configStyles.hint }, t('config.intro')),
        readOnly ? React.createElement('p', { style: configStyles.hint }, `${t('config.readOnly')} ${t('config.readOnlyHint')}`) : null,
        switchRow(t, { label: 'config.enabled', hint: 'config.enabledHint', checked: draft.enabled, disabled: readOnly, onChange: (next) => setDraft({ ...draft, enabled: next }) }),
        React.createElement('div', { style: configStyles.field },
          React.createElement('span', { style: configStyles.checkLabel }, t('config.hosts')),
          React.createElement('span', { style: configStyles.hint }, t('config.hostsHint')),
          React.createElement('textarea', {
            style: configStyles.textarea,
            rows: 4,
            spellCheck: false,
            disabled: readOnly,
            placeholder: t('config.hostsPlaceholder'),
            value: draft.hostsText,
            onChange: (event) => setDraft({ ...draft, hostsText: event.target.value }),
          }),
        ),
        switchRow(t, { label: 'config.allowEval', hint: 'config.allowEvalHint', checked: draft.allowEval, disabled: readOnly, onChange: (next) => setDraft({ ...draft, allowEval: next }) }),
        switchRow(t, { label: 'config.allowNativeInput', hint: 'config.allowNativeInputHint', checked: draft.allowNativeInput, disabled: readOnly, onChange: (next) => setDraft({ ...draft, allowNativeInput: next }) }),
        React.createElement('div', { style: configStyles.actions },
          React.createElement('button', {
            type: 'button',
            style: configStyles.primary,
            disabled: readOnly || busy || ops.length === 0,
            onClick: save,
          }, busy ? t('config.saving') : t('config.save')),
          React.createElement('button', {
            type: 'button',
            style: configStyles.button,
            disabled: readOnly || busy || ops.length === 0,
            onClick: () => { setDraft(draftOf(value)); setNotice('') },
          }, t('config.reset')),
          React.createElement('span', { style: notice.startsWith(t('config.failed')) ? configStyles.error : configStyles.notice }, notice),
        ),
      )
    }

    /**
     * The `plugins.row.config` page: a summary line and the staged form.
     * @param props - `{ view, form, t }` from the Plugins page.
     * @returns text for the summary, the form for the page.
     */
    function ConfigPage(props) {
      if (props.view === 'summary') return props.t('config.summary')
      if (props.form === undefined) return React.createElement('p', { style: configStyles.hint }, props.t('config.unavailable'))
      return React.createElement(ConfigEditor, { form: props.form, t: props.t })
    }

    // ---------------------------------------------------------------------
    // Command dispatch (tab management + page content)
    // ---------------------------------------------------------------------

    const PAGE_ACTIONS = new Set(['read', 'click', 'type', 'press', 'scroll', 'eval', 'wait', 'screenshot'])
    /** Appended to results whose operation ran while another conversation was on screen. */
    const OFFSCREEN_NOTE = 'The calling conversation is not the one on screen; the operation ran on its hidden sidebar tab and is not visible right now.'

    /**
     * Execute one bridge command through the sidebar controller.
     * @param ctx - client plugin context.
     * @param command - command frame from the host.
     * @param state - per-page memory (url of tabs this plugin opened).
     * @returns `{ ok, value? , error? }`; never throws.
     */
    async function executeCommand(ctx, command, state) {
      try {
        const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
        const action = command.action

        if (PAGE_ACTIONS.has(action)) {
          const result = await runPageCommand(ctx, command)
          if (result.ok === true && result.value !== null && typeof result.value === 'object' && mountedSession(ctx) !== command.sessionId) {
            result.value = { ...result.value, note: OFFSCREEN_NOTE }
          }
          return result
        }

        if (action === 'status') {
          const mounted = mountedSession(ctx)
          const tabs = sessionId === '' ? allOpenTabs(ctx).filter((tab) => tab.kind === 'browser') : browserTabs(ctx, sessionId)
          const carrier = detectCarrier()
          const surface = ctx.get?.('sidebarRightTabs')
          const browserKind = surface?.get?.('browser') === undefined ? 'unknown' : 'registered'
          const checks = carrierChecks(ctx, sessionId)
          return {
            ok: true,
            value: {
              action: 'status',
              ...(sessionId === '' ? {} : { sessionId }),
              pageConnected: true,
              note: `right sidebar mounted=${mounted ?? 'none'}; carrier=${carrier.kind}; native page control=${carrier.native ? 'available' : 'unavailable'}; native browser tab type=${browserKind}; browser tabs=${tabs.length}; checks=${JSON.stringify(checks)}.`,
            },
          }
        }

        if (sessionId === '') throw new Error('the host did not name a calling session')

        if (action === 'list') {
          const tabs = browserTabs(ctx, sessionId)
          const mounted = mountedSession(ctx)
          const active = mounted === sessionId ? activeTabId(ctx) : undefined
          return {
            ok: true,
            value: {
              action: 'list',
              sessionId,
              tabs: tabs.map((tab) => {
                const facts = nativeFacts(sessionId, tab.tabId)
                const url = facts.url ?? (state.urls.has(tab.tabId) ? state.urls.get(tab.tabId) : undefined)
                return {
                  tabId: tab.tabId,
                  kind: tab.kind,
                  ...(url === undefined ? {} : { url }),
                  ...(facts.title === undefined ? {} : { title: facts.title }),
                  ...(tab.tabId === active ? { active: true } : {}),
                }
              }),
            },
          }
        }

        if (action === 'open') {
          requireMounted(ctx, sessionId)
          const before = new Set(browserTabs(ctx, sessionId).map((tab) => tab.tabId))
          ctx.sidebarRight.openTab('browser', { params: { url: command.url } })
          const created = browserTabs(ctx, sessionId).find((tab) => !before.has(tab.tabId))
          if (created === undefined) throw new Error('the sidebar opened no new browser tab')
          state.urls.set(created.tabId, command.url)
          return {
            ok: true,
            value: { action: 'open', sessionId, tabId: created.tabId, url: command.url },
          }
        }

        if (action === 'navigate') {
          const target = resolveTab(ctx, sessionId, command.tabId)
          const webview = tryFindWebview(sessionId, target.tabId)
          if (webview !== undefined && typeof webview.loadURL === 'function') {
            await webview.loadURL(command.url)
            state.urls.set(target.tabId, command.url)
            const note = mountedSession(ctx) === sessionId ? {} : { note: OFFSCREEN_NOTE }
            return { ok: true, value: { action: 'navigate', sessionId, tabId: target.tabId, url: command.url, ...note } }
          }
          requireMounted(ctx, sessionId)
          const before = new Set(browserTabs(ctx, sessionId).map((tab) => tab.tabId))
          ctx.sidebarRight.openTab('browser', { params: { url: command.url }, replaceTab: target.tabId })
          const created = browserTabs(ctx, sessionId).find((tab) => !before.has(tab.tabId))
          const nextTabId = created === undefined ? target.tabId : created.tabId
          state.urls.delete(target.tabId)
          state.urls.set(nextTabId, command.url)
          return { ok: true, value: { action: 'navigate', sessionId, tabId: nextTabId, url: command.url } }
        }

        if (action === 'reload') {
          const target = resolveTab(ctx, sessionId, command.tabId)
          const webview = tryFindWebview(sessionId, target.tabId)
          if (webview !== undefined && typeof webview.reload === 'function') {
            webview.reload()
            const facts = nativeFacts(sessionId, target.tabId)
            const note = mountedSession(ctx) === sessionId ? {} : { note: OFFSCREEN_NOTE }
            return {
              ok: true,
              value: { action: 'reload', sessionId, tabId: target.tabId, ...(facts.url === undefined ? {} : { url: facts.url }), ...note },
            }
          }
          requireMounted(ctx, sessionId)
          const url = state.urls.get(target.tabId)
          if (url === undefined) {
            throw new Error('This tab was not opened by the agent and has no native guest, so its current address is unknown; use action "navigate" with the target url instead.')
          }
          const before = new Set(browserTabs(ctx, sessionId).map((tab) => tab.tabId))
          ctx.sidebarRight.openTab('browser', { params: { url }, replaceTab: target.tabId })
          const created = browserTabs(ctx, sessionId).find((tab) => !before.has(tab.tabId))
          const nextTabId = created === undefined ? target.tabId : created.tabId
          state.urls.set(nextTabId, url)
          return { ok: true, value: { action: 'reload', sessionId, tabId: nextTabId, url } }
        }

        if (action === 'focus') {
          requireMounted(ctx, sessionId)
          const target = resolveTab(ctx, sessionId, command.tabId)
          ctx.sidebarRight.focus(target.tabId)
          return { ok: true, value: { action, sessionId, tabId: target.tabId } }
        }

        if (action === 'close') {
          requireMounted(ctx, sessionId)
          const target = resolveTab(ctx, sessionId, command.tabId)
          ctx.sidebarRight.close(target.tabId)
          state.urls.delete(target.tabId)
          return { ok: true, value: { action, sessionId, tabId: target.tabId } }
        }

        return { ok: false, error: `unknown sidebar action "${String(action)}"` }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    }

    // ---------------------------------------------------------------------
    // Bridge
    // ---------------------------------------------------------------------

    /**
     * Abortable pause.
     * @param ms - milliseconds.
     * @param signal - bridge cancellation.
     * @returns a promise that resolves after the delay.
     */
    function pause(ms, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }

    /**
     * Start the long-poll bridge.
     * @param ctx - client plugin context.
     * @returns a disposer stopping the loop.
     */
    function startBridge(ctx) {
      const controller = new AbortController()
      const state = { urls: new Map() }
      const clientId = newClientId()
      let stopped = false

      const report = (payload) => {
        if (stopped) return
        fetch(hostUrl(`${PLUGIN_ROOT}/report`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId, ...payload }),
          signal: controller.signal,
        }).catch(() => {})
      }

      const sendResult = async (id, result) => {
        const body = JSON.stringify({
          id,
          ok: result !== null && typeof result === 'object' && result.ok === true,
          ...(result !== null && typeof result === 'object' && result.value !== undefined ? { value: result.value } : {}),
          ...(result !== null && typeof result === 'object' && typeof result.error === 'string' ? { error: result.error } : {}),
        })
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = await fetch(hostUrl(`${PLUGIN_ROOT}/result`), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              signal: controller.signal,
            })
            if (response.ok) return
          } catch {
            /* retry once */
          }
        }
      }

      const pollOnce = async () => {
        const mounted = mountedSession(ctx)
        const query = `?clientId=${encodeURIComponent(clientId)}&session=${encodeURIComponent(mounted ?? '')}`
        const response = await fetch(hostUrl(`${PLUGIN_ROOT}/poll`) + query, { signal: controller.signal })
        if (!response.ok) throw new Error(`bridge poll failed with HTTP ${response.status}`)
        const payload = await response.json()
        const commands = Array.isArray(payload?.commands) ? payload.commands : []
        for (const command of commands) {
          if (stopped) return
          if (command === null || typeof command !== 'object' || typeof command.id !== 'string') continue
          await sendResult(command.id, await executeCommand(ctx, command, state))
        }
      }

      const loop = async () => {
        let failures = 0
        while (!stopped) {
          try {
            await pollOnce()
            failures = 0
          } catch (error) {
            if (stopped) return
            failures += 1
            if (failures === 1) report({ status: 'poll-failed', error: messageOf(error) })
            await pause(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * failures), controller.signal)
          }
        }
      }

      report({
        status: 'started',
        mounted: mountedSession(ctx) ?? '',
        carrier: detectCarrier().kind,
        href: typeof location === 'undefined' ? '' : location.href,
      })
      loop().catch((error) => {
        if (!stopped) report({ status: 'loop-failed', error: messageOf(error) })
      })

      return () => {
        stopped = true
        controller.abort()
      }
    }

    return {
      inject: ['sidebarRight', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => startBridge(ctx), 'sidebar-browser-agent: bridge')
        ctx.effect(() => ctx.locale.register(UI_NS, { en: CONFIG_EN, zh: CONFIG_ZH }), 'sidebar-browser-agent: config locale')
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: CONFIG_ROW_KEY,
          locale: UI_NS,
        }, ConfigPage)), 'sidebar-browser-agent: config page')
      },
      __test: { hostsToText, textToHosts, configOps, draftOf, CONFIG_ROW_KEY, CONFIG_ENTRY_ID },
    }
  },
})
