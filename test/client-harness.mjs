/**
 * Browser-half regression suite.
 *
 * client.js runs in a vm with mocked browser globals. The guest scripts for
 * read/click/type/scroll/wait are executed against a fake DOM guest context
 * behind a mocked native `<webview>`, so their real behaviour is exercised;
 * the bridge transport is mocked in memory.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

check('client version matches package', source.includes(`PLUGIN_VERSION = '${packageJson.version}'`), packageJson.version)

// ---------------------------------------------------------------------------
// Fake guest DOM
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tag, { attrs = {}, rect = { x: 0, y: 0, width: 100, height: 20 }, text = '' } = {}) {
    this.tagName = tag.toUpperCase()
    this.attributes = { ...attrs }
    this.rect = rect
    this.innerText = text
    this.textContent = text
    this.children = []
    this.parentElement = null
    this.isContentEditable = this.attributes.contenteditable === 'true'
    this.disabled = this.attributes.disabled === 'true'
    this.events = []
    this.scrolledInto = false
    this.focused = false
  }

  get id() {
    return this.attributes.id ?? ''
  }

  get value() {
    return this.attributes.value ?? ''
  }

  set value(next) {
    this.attributes.value = String(next)
  }

  get href() {
    return this.attributes.href ?? ''
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  getBoundingClientRect() {
    const { x, y, width, height } = this.rect
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }
  }

  scrollIntoView() {
    this.scrolledInto = true
  }

  focus() {
    this.focused = true
    guest.activeElement = this
  }

  dispatchEvent(event) {
    this.events.push(event.type)
    return true
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
  }
}

class FakeInputElement extends FakeElement {
  get value() {
    return this.attributes.value ?? ''
  }

  set value(next) {
    this.attributes.value = String(next)
  }
}

class FakeTextAreaElement extends FakeInputElement {}

class FakeAnchorElement extends FakeElement {
  get href() {
    return this.attributes.href ?? ''
  }
}

const guest = { activeElement: null, scrollX: 0, scrollY: 0, scrollHeight: 2400 }

const body = new FakeElement('body', { rect: { x: 0, y: 0, width: 1280, height: 800 } })
body.innerText = 'Welcome to Test Page\nThis page demonstrates the native sidebar browser agent.\nSubmit answer\nMore information'

const heading = new FakeElement('h1', { rect: { x: 24, y: 24, width: 400, height: 40 }, text: 'Welcome to Test Page' })
const button = new FakeElement('button', { attrs: { type: 'button' }, rect: { x: 100, y: 200, width: 160, height: 40 }, text: 'Submit answer' })
const link = new FakeAnchorElement('a', { attrs: { href: 'https://example.org/more' }, rect: { x: 300, y: 100, width: 180, height: 24 }, text: 'More information' })
const input = new FakeInputElement('input', { attrs: { id: 'q', type: 'text', placeholder: 'Search' }, rect: { x: 24, y: 300, width: 320, height: 32 } })
const card = new FakeElement('div', { attrs: { onclick: 'return false' }, rect: { x: 24, y: 400, width: 420, height: 120 }, text: 'Card with click handler' })

for (const child of [heading, button, link, input, card]) body.append(child)

const documentElement = new FakeElement('html', { rect: { x: 0, y: 0, width: 1280, height: 2400 } })
documentElement.outerHTML = '<html><body><h1>Welcome to Test Page</h1><button>Submit answer</button><a href="https://example.org/more">More information</a><input id="q" placeholder="Search"><div onclick="return false">Card with click handler</div></body></html>'
documentElement.scrollHeight = 2400
documentElement.append(body)

/** Parse the small selector vocabulary the guest scripts use. */
function matches(el, compound) {
  const match = /^([a-z0-9]*)(?:#([A-Za-z0-9_-]+))?((?:\[[^\]]*\])*)$/.exec(compound.trim())
  if (match === null) return false
  const [, tag, id, attributePart] = match
  if (tag !== '' && el.tagName !== tag.toUpperCase()) return false
  if (id !== undefined && el.id !== id) return false
  for (const attrMatch of attributePart.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    const name = attrMatch[1]
    const expected = attrMatch[2]
    const actual = el.getAttribute(name)
    if (actual === null) return false
    if (expected !== undefined && actual !== expected) return false
  }
  return true
}

function queryAll(root, selector) {
  const results = []
  const parts = selector.split(',').map((part) => part.trim())
  const visit = (element) => {
    for (const child of element.children) {
      visit(child)
      for (const compound of parts) {
        if (matches(child, compound)) {
          results.push(child)
          break
        }
      }
    }
  }
  visit(root)
  return results
}

const guestContext = {
  document: {
    title: 'Test Page',
    readyState: 'complete',
    body,
    documentElement,
    activeElement: null,
    querySelector(selector) {
      if (selector === 'body') return body
      const found = queryAll({ children: [documentElement] }, selector)
      return found.length > 0 ? found[0] : null
    },
    querySelectorAll(selector) {
      if (selector === 'body') return [body]
      const found = queryAll({ children: [documentElement] }, selector)
      return found.length > 0 ? found : queryAll(body, selector)
    },
    createRange() {
      return { selectNodeContents() {} }
    },
    execCommand(command, _showUi, value) {
      guest.commands = guest.commands ?? []
      guest.commands.push({ command, value })
      return true
    },
    elementFromPoint(x, y) {
      for (const child of body.children) {
        const rect = child.getBoundingClientRect()
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return child
      }
      return null
    },
  },
  location: { href: 'https://example.test/page' },
  innerWidth: 1280,
  innerHeight: 800,
  get scrollX() {
    return guest.scrollX
  },
  get scrollY() {
    return guest.scrollY
  },
  scrollBy(options) {
    guest.scrollX += Number(options.left ?? 0)
    guest.scrollY += Number(options.top ?? 0)
  },
  getComputedStyle() {
    return { display: 'block', visibility: 'visible', opacity: '1' }
  },
  getSelection() {
    return { removeAllRanges() {}, addRange() {} }
  },
  performance: { now: () => Date.now() },
  CSS: { escape: (value) => String(value) },
  Event: class FakeEvent {
    constructor(type, init) {
      this.type = type
      this.bubbles = Boolean(init?.bubbles)
    }
  },
  HTMLInputElement: FakeInputElement,
  HTMLTextAreaElement: FakeTextAreaElement,
  Element: FakeElement,
  setTimeout,
  clearTimeout,
  console,
  Math,
  Number,
  String,
  JSON,
  Object,
  Array,
  Promise,
}
const guestVm = vm.createContext(guestContext)

/** Execute a guest script in the fake DOM context and await async results. */
async function guestEval(sourceText) {
  const result = vm.runInContext(sourceText, guestVm, { filename: 'guest-script.js' })
  return await result
}

// ---------------------------------------------------------------------------
// Fake native webview + screenshots
// ---------------------------------------------------------------------------

const inputEvents = []

function makeImage(width, height, dataUrl = 'data:image/png;base64,QUJD') {
  return {
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth }) => makeImage(nextWidth, Math.max(1, Math.round((height * nextWidth) / width)), dataUrl),
    toDataURL: () => dataUrl,
  }
}

const webview = {
  dataset: { sidebarBrowserFrame: 'webview' },
  focused: false,
  loadUrlCalls: [],
  reloadCalls: 0,
  zoomFactor: 1,
  captureCalls: [],
  async executeJavaScript(sourceText) {
    return await guestEval(sourceText)
  },
  sendInputEvent(event) {
    inputEvents.push(event)
  },
  async capturePage(rect) {
    this.captureCalls.push(rect === undefined ? null : rect)
    return makeImage(1024, 768)
  },
  getZoomFactor() {
    return this.zoomFactor
  },
  setZoomFactor(next) {
    this.zoomFactor = next
  },
  getBoundingClientRect() {
    return { x: 0, y: 0, width: 1024, height: 768, left: 0, top: 0, right: 1024, bottom: 768 }
  },
  getURL() {
    return 'https://example.test/page'
  },
  getTitle() {
    return 'Test Page'
  },
  isLoading() {
    return false
  },
  focus() {
    this.focused = true
  },
  async loadURL(url) {
    this.loadUrlCalls.push(url)
  },
  reload() {
    this.reloadCalls += 1
  },
}

const titleWrapper = { querySelector: () => null }
const bodyWrapper = { querySelector: (selector) => (selector.startsWith('webview') ? webview : null) }
const sessionRoot = {
  dataset: { sidebarRightSession: 'session-1' },
  querySelectorAll: (selector) => (selector.includes('data-sidebar-right-tab') ? [titleWrapper, bodyWrapper] : []),
}
const documentMock = {
  baseURI: 'http://127.0.0.1:58087/',
  querySelectorAll(selector) {
    if (selector === '[data-sidebar-right-session]') return [sessionRoot]
    if (selector === 'webview') return [webview]
    if (selector === '[data-sidebar-right-tab]') return [titleWrapper, bodyWrapper]
    return []
  },
  querySelector() {
    return null
  },
}

// ---------------------------------------------------------------------------
// Mocked transport + sidebar service
// ---------------------------------------------------------------------------

const reports = []
const results = []
const polls = []
let pendingPoll = null
const queue = []

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload }
}

async function mockFetch(url, init = {}) {
  const parsed = new URL(String(url))
  if (parsed.pathname.endsWith('/report')) {
    reports.push(JSON.parse(init.body))
    return jsonResponse({ ok: true })
  }
  if (parsed.pathname.endsWith('/result')) {
    results.push(JSON.parse(init.body))
    return jsonResponse({ ok: true })
  }
  if (parsed.pathname.endsWith('/poll')) {
    polls.push({ session: parsed.searchParams.get('session') })
    if (queue.length > 0) return jsonResponse({ commands: [queue.shift()] })
    return await new Promise((resolve) => {
      pendingPoll = resolve
    })
  }
  throw new Error(`unexpected fetch ${parsed.pathname}`)
}

function deliver(command) {
  if (pendingPoll !== null) {
    const resolve = pendingPoll
    pendingPoll = null
    resolve(jsonResponse({ commands: [command] }))
    return
  }
  queue.push(command)
}

function createSidebarMock() {
  const sessions = new Map()
  let mounted = 'session-1'
  let sequence = 0
  let activeId
  return {
    mounted: { getSnapshot: () => mounted },
    openTabs: { getSnapshot: () => [...sessions.values()].flat().map((tab) => ({ ...tab })) },
    openTab(kind, options = {}) {
      if (kind !== 'browser') throw new Error(`no tab type registered for kind ${kind}`)
      const sessionId = mounted
      const current = sessions.get(sessionId) ?? []
      const kept = options.replaceTab === undefined ? current : current.filter((tab) => tab.tabId !== options.replaceTab)
      sequence += 1
      const tab = { sessionId, tabId: `tab-${sequence}`, kind, contentId: `content-${sequence}`, url: options.params?.url }
      sessions.set(sessionId, [...kept, tab])
      activeId = tab.tabId
    },
    focus(tabId) {
      activeId = tabId
    },
    close(tabId) {
      for (const [sessionId, tabs] of sessions) sessions.set(sessionId, tabs.filter((tab) => tab.tabId !== tabId))
    },
    active() {
      const tabs = sessions.get(mounted) ?? []
      const tab = tabs.find((candidate) => candidate.tabId === activeId)
      return tab === undefined ? undefined : { id: tab.tabId, kind: tab.kind }
    },
    expanded: false,
    isExpanded() {
      return this.expanded
    },
    toggleExpanded() {
      this.expanded = !this.expanded
    },
    setMounted(next) {
      mounted = next
    },
    seedBrowserTab(sessionId = 'session-1') {
      sequence += 1
      const tab = { sessionId, tabId: `tab-${sequence}`, kind: 'browser', contentId: `content-${sequence}`, url: 'https://example.test/page' }
      sessions.set(sessionId, [...(sessions.get(sessionId) ?? []), tab])
      activeId = tab.tabId
      return tab
    },
  }
}

// ---------------------------------------------------------------------------
// Load client.js
// ---------------------------------------------------------------------------

const sidebar = createSidebarMock()
const tab = sidebar.seedBrowserTab()

let captured
const sandbox = {
  window: { __ModuleLoader__: { load(payload) { captured = payload } } },
  document: documentMock,
  location: { href: 'http://127.0.0.1:58087/' },
  crypto: globalThis.crypto,
  fetch: mockFetch,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  console,
  Math,
  Date,
  Error,
  String,
  Set,
  Map,
  Promise,
  queueMicrotask,
  encodeURIComponent,
  CSS: { escape: (value) => String(value) },
  dshDesktop: { browser: {} },
  __DSH_BOOT__: { release: { version: '0.2.2-rc.1', commit: 'c59d10a' } },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('module registered', captured !== undefined && captured.id === 'dsh-sidebar-browser-agent')

/** Minimal React stand-in: enough to render the configuration page once. */
const mockReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
}

const moduleExports = captured.factory((name) => {
  if (name === 'react') return mockReact
  throw new Error(`unexpected require(${name})`)
})

const waitFor = async (predicate, timeout = 3000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return true
}

async function send(command) {
  const before = results.length
  deliver(command)
  if (!(await waitFor(() => results.length > before))) throw new Error(`no result for ${command.action}`)
  return results[results.length - 1]
}

async function main() {
  const disposers = []
  const slotRegistrations = []
  const localeRegistrations = []
  const fakeConfigForms = {
    get: () => ({
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        revision: 1,
        value: { enabled: true, allowEval: true, allowNativeInput: true, allowedHosts: ['example.test'] },
      }),
    }),
  }
  moduleExports.apply({
    sidebarRight: sidebar,
    get: (name) => (name === 'configForms' ? fakeConfigForms : undefined),
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options, component) {
        slotRegistrations.push({ options, component })
        return () => {}
      },
    },
    locale: {
      register(ns, dicts) {
        localeRegistrations.push({ ns, dicts })
        return () => {}
      },
    },
  })
  const stopBridge = disposers[0]

  check('bridge started', typeof stopBridge === 'function' && disposers.length === 3, disposers.length)
  await waitFor(() => reports.length > 0)
  check('started report carries carrier', reports[0]?.status === 'started' && reports[0]?.carrier === 'electron-webview', reports[0])
  await waitFor(() => pendingPoll !== null)

  // --- status diagnostics ---
  const status = await send({ id: 's1', action: 'status', sessionId: 'session-1' })
  const note = status.value?.note ?? ''
  const match = note.match(/checks=(\{.*\})\.$/)
  let checks = null
  try {
    checks = match === null ? null : JSON.parse(match[1])
  } catch {
    checks = null
  }
  check('status carries checks JSON', checks !== null, note)
  check('status checks plugin version', checks?.plugin === packageJson.version, checks)
  check('status checks harness release', checks?.harness === '0.2.2-rc.1' && checks?.commit === 'c59d10a', checks)
  check('status checks carrier + surface', checks?.carrier === 'electron-webview' && checks?.native === true && checks?.surface === true && checks?.webview === true, checks)
  check('status checks native API', Array.isArray(checks?.api)
    && ['executeJavaScript', 'capturePage', 'sendInputEvent', 'loadURL', 'reload', 'getURL', 'getTitle'].every((name) => checks.api.includes(name)), checks?.api)
  check('status checks guest URL', checks?.guestUrl === 'https://example.test/page' && checks?.guestLoading === false, checks)
  check('status checks config form', checks?.configForm === 'ready', checks?.configForm)

  // --- configuration page: locale, slot registration and rendering ---
  const localeEntry = localeRegistrations.find((entry) => entry.ns === 'sidebarBrowserAgent')
  check('config locale registered', localeEntry !== undefined && localeEntry.dicts.en !== undefined && localeEntry.dicts.zh !== undefined, localeRegistrations.map((entry) => entry.ns))
  check('config locale carries the hero copy',
    localeEntry.dicts.en['config.heroTitle'] !== undefined && localeEntry.dicts.zh['config.heroTitle'] !== undefined
    && localeEntry.dicts.en['config.heroSubtitle'] !== undefined && localeEntry.dicts.zh['config.heroSubtitle'] !== undefined,
    Object.keys(localeEntry.dicts.en).filter((key) => key.startsWith('config.hero')))
  const slotEntry = slotRegistrations.find((entry) => entry.options?.name === 'plugins.row.config')
  check('row config slot registered', slotEntry !== undefined
    && slotEntry.options.key === 'dsh-sidebar-browser-agent#sidebar-browser-agent'
    && slotEntry.options.locale === 'sidebarBrowserAgent', slotEntry?.options)
  const configPage = slotEntry?.component
  check('config summary renders', configPage({ view: 'summary', t: (key) => key }) === 'config.summary', configPage?.name)

  const testHook = moduleExports.__test
  check('config helpers exported', testHook !== undefined && typeof testHook.configOps === 'function', Object.keys(moduleExports))
  check('hosts text round-trip', testHook.hostsToText(['example.com', 'localhost:8765']) === 'example.com\nlocalhost:8765'
    && JSON.stringify(testHook.textToHosts('example.com, LocalHost:8765\n\nexample.com')) === JSON.stringify(['example.com', 'localhost:8765']), testHook.textToHosts('example.com, LocalHost:8765\n\nexample.com'))
  const ops = testHook.configOps(
    { enabled: false, allowEval: true, allowNativeInput: true, hostsText: 'example.com\nlocalhost:8765' },
    { enabled: true, allowEval: true, allowNativeInput: true, allowedHosts: ['example.com'] },
  )
  check('config ops describe changes', JSON.stringify(ops) === JSON.stringify([
    { op: 'set', path: ['enabled'], value: false },
    { op: 'set', path: ['allowedHosts'], value: ['example.com', 'localhost:8765'] },
  ]), JSON.stringify(ops))
  const pageTree = configPage({ view: 'page', t: (key) => key, form: { state: fakeConfigForms.get().getSnapshot(), mutate: async () => true } })
  const flatten = (input, found = []) => {
    if (input === null || input === undefined || typeof input !== 'object') return found
    if (typeof input.type === 'function') {
      flatten(input.type(input.props ?? {}), found)
      return found
    }
    found.push(input)
    for (const child of input.children ?? []) flatten(child, found)
    return found
  }
  const pageNodes = flatten(pageTree)
  check('config page renders heading and switches',
    pageNodes.some((node) => node.type === 'h3' && node.children?.[0] === 'config.heading')
    && pageNodes.filter((node) => node.type === 'input' && node.props.type === 'checkbox').length === 3
    && pageNodes.some((node) => node.type === 'textarea'), pageNodes.map((node) => node.type).join(','))

  // --- official settings-form projection ---
  check('official form flag is reported', testHook.usesOfficialForm === false, testHook.usesOfficialForm)
  const readyModel = testHook.settingsFormState({ status: 'ready', writable: true, value: {} }, true, false, false)
  check('settings form state projects a dirty editable form',
    readyModel.available === true && readyModel.writable === true && readyModel.dirty === true
    && readyModel.invalid === false && readyModel.saving === false && readyModel.failed === false, JSON.stringify(readyModel))
  const cleanModel = testHook.settingsFormState({ status: 'ready', writable: true, value: {} }, false, true, true)
  check('settings form state projects saving and failure',
    cleanModel.dirty === false && cleanModel.saving === true && cleanModel.failed === true, JSON.stringify(cleanModel))
  const readOnlyModel = testHook.settingsFormState({ status: 'ready', writable: false, value: {} }, false, false, false)
  check('settings form state projects read-only', readOnlyModel.writable === false && readOnlyModel.available === true, JSON.stringify(readOnlyModel))
  const unavailableModel = testHook.settingsFormState({ status: 'loading' }, false, false, false)
  check('settings form state projects unavailable', unavailableModel.available === false && unavailableModel.dirty === false && unavailableModel.writable === false, JSON.stringify(unavailableModel))

  // --- tab management ---
  const open = await send({ id: 'o1', action: 'open', sessionId: 'session-1', url: 'https://example.test/new' })
  check('open result', open.ok === true && open.value.tabId === 'tab-2' && open.value.url === 'https://example.test/new', open.value)

  const listed = await send({ id: 'l1', action: 'list', sessionId: 'session-1' })
  check('list carries native facts', listed.ok === true && listed.value.tabs.length === 2 && listed.value.tabs.every((entry) => entry.url === 'https://example.test/page'), JSON.stringify(listed.value))

  const navigate = await send({ id: 'n1', action: 'navigate', sessionId: 'session-1', tabId: tab.tabId, url: 'https://example.org/next' })
  check('navigate native', navigate.ok === true && webview.loadUrlCalls.includes('https://example.org/next'), navigate.value)
  const loaded = await send({ id: 'r1', action: 'reload', sessionId: 'session-1', tabId: tab.tabId })
  check('reload native', loaded.ok === true && webview.reloadCalls === 1, loaded.value)

  // --- page actions ---
  const text = await send({ id: 'p1', action: 'read', sessionId: 'session-1', tabId: tab.tabId, mode: 'text' })
  check('read text', text.ok === true && text.value.text.includes('Welcome to Test Page') && text.value.title === 'Test Page', text.value)

  const interactive = await send({ id: 'p2', action: 'read', sessionId: 'session-1', tabId: tab.tabId, mode: 'interactive' })
  const labels = (interactive.value?.elements ?? []).map((element) => element.label)
  check('read interactive', interactive.ok === true && labels.includes('Submit answer') && labels.includes('More information'), labels)

  inputEvents.length = 0
  const click = await send({ id: 'p3', action: 'click', sessionId: 'session-1', tabId: tab.tabId, contains: 'Submit answer' })
  check('click native input', click.ok === true && click.value.target.tag === 'button'
    && inputEvents.some((event) => event.type === 'mouseDown' && event.x === 180 && event.y === 220), JSON.stringify(inputEvents))

  inputEvents.length = 0
  const type = await send({ id: 'p4', action: 'type', sessionId: 'session-1', tabId: tab.tabId, selector: '#q', text: 'hello world', clear: true, submit: true })
  check('type writes value', type.ok === true && type.value.typed === 11 && input.value === 'hello world'
    && input.events.includes('input') && input.events.includes('change'), `${input.value} ${JSON.stringify(input.events)}`)
  check('type submits with Enter', inputEvents.some((event) => event.keyCode === 'Enter'), JSON.stringify(inputEvents))

  inputEvents.length = 0
  const press = await send({ id: 'p5', action: 'press', sessionId: 'session-1', tabId: tab.tabId, key: 'Tab' })
  check('press native key', press.ok === true && press.value.key === 'Tab' && inputEvents.some((event) => event.keyCode === 'Tab'), JSON.stringify(inputEvents))

  const beforeScroll = guest.scrollY
  const scroll = await send({ id: 'p6', action: 'scroll', sessionId: 'session-1', tabId: tab.tabId, dy: 400 })
  check('scroll', scroll.ok === true && scroll.value.scrollY === beforeScroll + 400 && scroll.value.scrollHeight === 2400, scroll.value)

  const waited = await send({ id: 'p7', action: 'wait', sessionId: 'session-1', tabId: tab.tabId, selector: 'button' })
  check('wait matched', waited.ok === true && waited.value.matched === true, waited.value)

  const evaluated = await send({ id: 'p8', action: 'eval', sessionId: 'session-1', tabId: tab.tabId, code: 'document.querySelector("#q").value' })
  check('eval returns JSON text', evaluated.ok === true && evaluated.value.result === '"hello world"', evaluated.value)

  const shot = await send({ id: 'p9', action: 'screenshot', sessionId: 'session-1', tabId: tab.tabId })
  check('screenshot payload', shot.ok === true && shot.value.mediaType === 'image/png' && shot.value.width === 1024
    && typeof shot.value.base64 === 'string' && shot.value.base64.length > 0, JSON.stringify({ ...shot.value, base64: '…' }))

  // --- snapshot / refs / extended page actions ---
  const snap = await send({ id: 's1', action: 'snapshot', sessionId: 'session-1', tabId: tab.tabId })
  const snapText = String(snap.value.text ?? '')
  const buttonRefMatch = /\[(e\d+)\] button "Submit answer"/.exec(snapText)
  check('snapshot returns semantic refs', snap.ok === true && snap.value.generation === 1 && snapText.includes('heading') && snapText.includes('link') && buttonRefMatch !== null, snapText.slice(0, 500))
  const helpTurn = await send({ id: 's2', action: 'help', sessionId: 'session-1' })
  check('help returns the workflow', helpTurn.ok === true && String(helpTurn.value.help).includes('snapshot'), JSON.stringify(helpTurn.value).slice(0, 200))
  const beforeClick = inputEvents.length
  const refClick = await send({ id: 's3', action: 'click', sessionId: 'session-1', tabId: tab.tabId, ref: buttonRefMatch[1] })
  check('ref click uses native mouse', refClick.ok === true && inputEvents.length > beforeClick && refClick.value.target.tag === 'button' && refClick.value.observed !== undefined, JSON.stringify(refClick.value).slice(0, 400))
  const staleRef = await send({ id: 's4', action: 'click', sessionId: 'session-1', tabId: tab.tabId, ref: 'e999' })
  check('stale ref reports recovery', staleRef.ok === false && staleRef.error.includes('[stale-ref]'), staleRef.error)
  const noRef = await send({ id: 's4b', action: 'click', sessionId: 'session-1', tabId: tab.tabId, ref: 'nope' })
  check('bad ref format rejected', noRef.ok === false && noRef.error.includes('[bad-ref]'), noRef.error)

  const secondButton = new FakeElement('button', { attrs: { id: 'other' }, rect: { x: 20, y: 520, width: 120, height: 30 }, text: 'Other action' })
  body.append(secondButton)
  const ambiguous = await send({ id: 's5', action: 'click', sessionId: 'session-1', tabId: tab.tabId, selector: 'button' })
  check('ambiguous selector refuses silently picking', ambiguous.ok === false && ambiguous.error.includes('[ambiguous]') && ambiguous.error.includes('candidates'), ambiguous.error)
  const indexedClick = await send({ id: 's6', action: 'click', sessionId: 'session-1', tabId: tab.tabId, selector: 'button', index: 1 })
  check('explicit index resolves ambiguity', indexedClick.ok === true && indexedClick.value.target.tag === 'button', JSON.stringify(indexedClick.value).slice(0, 200))

  const beforeHover = inputEvents.length
  const hoverTurn = await send({ id: 's7', action: 'hover', sessionId: 'session-1', tabId: tab.tabId, contains: 'Submit answer' })
  const hoverEvents = inputEvents.slice(beforeHover)
  check('hover moves without pressing', hoverTurn.ok === true && hoverEvents.some((event) => event.type === 'mouseMove') && !hoverEvents.some((event) => event.type === 'mouseDown'), JSON.stringify(hoverEvents))
  const doubleTurn = await send({ id: 's7b', action: 'dblclick', sessionId: 'session-1', tabId: tab.tabId, contains: 'Submit answer' })
  check('dblclick sends clickCount 2', doubleTurn.ok === true && inputEvents.some((event) => event.type === 'mouseDown' && event.clickCount === 2), JSON.stringify(inputEvents.slice(-6)))
  const rightTurn = await send({ id: 's7c', action: 'rightClick', sessionId: 'session-1', tabId: tab.tabId, contains: 'More information' })
  check('rightClick uses the right button', rightTurn.ok === true && inputEvents.some((event) => event.type === 'mouseDown' && event.button === 'right'), JSON.stringify(inputEvents.slice(-6)))

  const comboPress = await send({ id: 's8', action: 'press', sessionId: 'session-1', tabId: tab.tabId, keys: ['Meta+A', 'Backspace'] })
  const comboEvents = inputEvents.slice(-8)
  check('key combos carry modifiers', comboPress.ok === true && comboEvents.some((event) => event.type === 'keyDown' && Array.isArray(event.modifiers) && event.modifiers.includes('meta')), JSON.stringify(comboEvents))
  const keyboardType = await send({ id: 's9', action: 'type', sessionId: 'session-1', tabId: tab.tabId, selector: '#q', text: 'ab', inputMode: 'keyboard', clear: false })
  check('keyboard typing emits key events', keyboardType.ok === true && keyboardType.value.inputMode === 'keyboard' && inputEvents.some((event) => event.type === 'char' && event.keyCode === 'a'), JSON.stringify(inputEvents.slice(-10)))

  const stateRead = await send({ id: 's10', action: 'read', sessionId: 'session-1', tabId: tab.tabId, selector: '#q', mode: 'state' })
  check('element state read', stateRead.ok === true && stateRead.value.mode === 'state' && stateRead.value.enabled === true && stateRead.value.box.width === 320, JSON.stringify(stateRead.value).slice(0, 300))
  const attrsRead = await send({ id: 's11', action: 'read', sessionId: 'session-1', tabId: tab.tabId, selector: '#q', mode: 'attrs' })
  check('element attrs read', attrsRead.ok === true && attrsRead.value.attrs.id === 'q', JSON.stringify(attrsRead.value).slice(0, 200))
  const boxRead = await send({ id: 's12', action: 'read', sessionId: 'session-1', tabId: tab.tabId, selector: '#q', mode: 'box' })
  check('element box read', boxRead.ok === true && boxRead.value.box.width === 320 && boxRead.value.inViewport === true, JSON.stringify(boxRead.value).slice(0, 200))
  const scopedText = await send({ id: 's13', action: 'read', sessionId: 'session-1', tabId: tab.tabId, selector: 'body', mode: 'text' })
  check('scoped text read', scopedText.ok === true && String(scopedText.value.text).includes('Welcome'), JSON.stringify(scopedText.value).slice(0, 200))

  const fakeSelect = new FakeElement('select', { attrs: { id: 'sel' }, rect: { x: 10, y: 600, width: 200, height: 30 }, text: '' })
  fakeSelect.options = [
    { value: 'a', textContent: 'Alpha' },
    { value: 'b', textContent: 'Beta' },
  ]
  fakeSelect.selectedIndex = 0
  fakeSelect.value = 'a'
  body.append(fakeSelect)
  const selected = await send({ id: 's14', action: 'selectOption', sessionId: 'session-1', tabId: tab.tabId, selector: '#sel', value: 'b' })
  check('selectOption chooses a value', selected.ok === true && selected.value.value === 'b', JSON.stringify(selected.value).slice(0, 200))
  const fakeCheckbox = new FakeElement('input', { attrs: { id: 'agree', type: 'checkbox' }, rect: { x: 10, y: 640, width: 20, height: 20 }, text: '' })
  fakeCheckbox.checked = false
  fakeCheckbox.click = function click() { this.checked = !this.checked }
  body.append(fakeCheckbox)
  const checked = await send({ id: 's15', action: 'check', sessionId: 'session-1', tabId: tab.tabId, selector: '#agree' })
  check('check toggles a checkbox', checked.ok === true && checked.value.checked === true, JSON.stringify(checked.value).slice(0, 200))
  const cleared = await send({ id: 's16', action: 'clear', sessionId: 'session-1', tabId: tab.tabId, selector: '#q' })
  check('clear empties a field', cleared.ok === true && guest.activeElement === input && input.value === '', JSON.stringify(cleared.value).slice(0, 200))
  const focused = await send({ id: 's17', action: 'focus', sessionId: 'session-1', tabId: tab.tabId, selector: '#q' })
  check('focus targets a field', focused.ok === true && guest.activeElement === input, JSON.stringify(focused.value).slice(0, 200))
  const intoView = await send({ id: 's18', action: 'scrollIntoView', sessionId: 'session-1', tabId: tab.tabId, contains: 'More information' })
  check('scrollIntoView resolves a target', intoView.ok === true && intoView.value.target.tag === 'a', JSON.stringify(intoView.value).slice(0, 200))
  const dragTurn = await send({ id: 's19', action: 'drag', sessionId: 'session-1', tabId: tab.tabId, contains: 'Submit answer', toSelector: 'a[href]' })
  check('drag sends a mouse sequence', dragTurn.ok === true && inputEvents.some((event) => event.type === 'mouseDown') && inputEvents.some((event) => event.type === 'mouseUp'), JSON.stringify(dragTurn.value).slice(0, 200))

  const waitVisible = await send({ id: 'w1', action: 'waitForSelector', sessionId: 'session-1', tabId: tab.tabId, selector: '#q', state: 'visible' })
  check('waitForSelector visible', waitVisible.ok === true && waitVisible.value.matched === true, JSON.stringify(waitVisible.value).slice(0, 200))
  const waitHidden = await send({ id: 'w2', action: 'waitForSelector', sessionId: 'session-1', tabId: tab.tabId, selector: '#missing', state: 'hidden', timeoutMs: 150 })
  check('waitForSelector hidden resolves', waitHidden.ok === true && waitHidden.value.matched === true, JSON.stringify(waitHidden.value).slice(0, 200))
  const waitLoad = await send({ id: 'w3', action: 'waitForLoadState', sessionId: 'session-1', tabId: tab.tabId, loadState: 'load' })
  check('waitForLoadState matches', waitLoad.ok === true && waitLoad.value.matched === true, JSON.stringify(waitLoad.value).slice(0, 200))
  const waitUrl = await send({ id: 'w4', action: 'waitForURL', sessionId: 'session-1', tabId: tab.tabId, url: 'example.test', match: 'contains' })
  check('waitForURL matches', waitUrl.ok === true && waitUrl.value.matched === true, JSON.stringify(waitUrl.value).slice(0, 200))
  const waitNav = await send({ id: 'w5', action: 'waitForNavigation', sessionId: 'session-1', tabId: tab.tabId, timeoutMs: 150 })
  check('waitForNavigation times out cleanly', waitNav.ok === true && waitNav.value.matched === false, JSON.stringify(waitNav.value).slice(0, 200))

  const batchTurn = await send({ id: 'b1', action: 'batch', sessionId: 'session-1', tabId: tab.tabId, steps: [{ action: 'click', contains: 'Submit answer' }, { action: 'snapshot', maxElements: 50 }] })
  check('batch runs steps in one call', batchTurn.ok === true && batchTurn.value.steps.length === 2 && batchTurn.value.allOk === true && typeof batchTurn.value.steps[1].value.text === 'string', JSON.stringify(batchTurn.value).slice(0, 500))
  const batchFail = await send({ id: 'b2', action: 'batch', sessionId: 'session-1', tabId: tab.tabId, steps: [{ action: 'click', selector: '#nope' }, { action: 'help' }] })
  check('batch stops on error', batchFail.ok === true && batchFail.value.allOk === false && batchFail.value.steps.length === 1, JSON.stringify(batchFail.value).slice(0, 300))

  const clipShot = await send({ id: 'sc1', action: 'screenshot', sessionId: 'session-1', tabId: tab.tabId, clip: { x: 10, y: 20, width: 300, height: 200 } })
  check('screenshot clip forwarded', clipShot.ok === true && webview.captureCalls.at(-1).width === 300 && clipShot.value.clip.width === 300, JSON.stringify(webview.captureCalls.at(-1)))

  // --- browser lifecycle actions ---
  const zoomSet = await send({ id: 'z1', action: 'zoom', sessionId: 'session-1', tabId: tab.tabId, zoomFactor: 1.5 })
  check('zoom sets and reports factor', zoomSet.ok === true && zoomSet.value.zoom === 1.5, JSON.stringify(zoomSet.value))
  const viewportTurn = await send({ id: 'v1', action: 'viewport', sessionId: 'session-1', tabId: tab.tabId })
  check('viewport reports size', viewportTurn.ok === true && viewportTurn.value.viewport.width === 1024, JSON.stringify(viewportTurn.value))
  const shown = await send({ id: 'sh1', action: 'show', sessionId: 'session-1' })
  check('show expands the sidebar', shown.ok === true && shown.value.expanded === true, JSON.stringify(shown.value))
  const hidden = await send({ id: 'sh2', action: 'hide', sessionId: 'session-1' })
  check('hide collapses the sidebar', hidden.ok === true && hidden.value.expanded === false, JSON.stringify(hidden.value))
  const finalized = await send({ id: 'f1', action: 'finalize', sessionId: 'session-1', tabId: tab.tabId, mark: 'deliverable' })
  check('finalize marks a tab', finalized.ok === true && finalized.value.marks[tab.tabId] === 'deliverable', JSON.stringify(finalized.value))
  const markedList = await send({ id: 'l9', action: 'list', sessionId: 'session-1' })
  check('list carries mark, viewport and zoom', markedList.ok === true && markedList.value.tabs.some((entry) => entry.mark === 'deliverable' && entry.viewport !== undefined && entry.zoom !== undefined), JSON.stringify(markedList.value.tabs))
  const reused = await send({ id: 'o9', action: 'open', sessionId: 'session-1', url: 'https://example.test/other', reuse: true })
  check('open reuses a same-site tab', reused.ok === true && reused.value.reused === true && reused.value.tabId === tab.tabId, JSON.stringify(reused.value))
  const statusCaps = await send({ id: 'st2', action: 'status', sessionId: 'session-1' })
  check('status reports capabilities', statusCaps.ok === true && statusCaps.value.capabilities !== undefined && statusCaps.value.capabilities.snapshot === true, JSON.stringify(statusCaps.value).slice(0, 300))

  // --- timeout helpers and hung-page resilience ---
  const timeoutError = await moduleExports.__test.withTimeout(new Promise(() => {}), 80, 'Probe')
    .then(() => null, (error) => error.message)
  check('withTimeout rejects hung operations', typeof timeoutError === 'string' && timeoutError.includes('did not finish within'), timeoutError)

  const originalExecute = webview.executeJavaScript
  const originalGuestTimeout = moduleExports.__test.TIMEOUTS.guest
  const originalLoadURL = webview.loadURL
  const originalNavigationTimeout = moduleExports.__test.TIMEOUTS.navigation
  try {
    moduleExports.__test.TIMEOUTS.guest = 150
    webview.executeJavaScript = () => new Promise(() => {})
    const hungRead = await send({ id: 'h1', action: 'read', sessionId: 'session-1', tabId: tab.tabId })
    check('hung page becomes a command error', hungRead.ok === false && String(hungRead.error).includes('did not finish within'), hungRead.error)
    webview.executeJavaScript = originalExecute
    moduleExports.__test.TIMEOUTS.guest = originalGuestTimeout
    const recoveredList = await send({ id: 'h2', action: 'list', sessionId: 'session-1' })
    check('bridge keeps polling after a hung command', recoveredList.ok === true && Array.isArray(recoveredList.value.tabs), JSON.stringify(recoveredList).slice(0, 160))

    moduleExports.__test.TIMEOUTS.navigation = 150
    webview.loadURL = () => new Promise(() => {})
    const hungNavigation = await send({ id: 'h3', action: 'navigate', sessionId: 'session-1', tabId: tab.tabId, url: 'https://example.test/hang' })
    check('hung navigation becomes a command error', hungNavigation.ok === false && String(hungNavigation.error).includes('did not finish within'), hungNavigation.error)
    webview.loadURL = originalLoadURL
    moduleExports.__test.TIMEOUTS.navigation = originalNavigationTimeout
    const recoveredAfterNavigation = await send({ id: 'h4', action: 'list', sessionId: 'session-1' })
    check('bridge keeps polling after a hung navigation', recoveredAfterNavigation.ok === true, JSON.stringify(recoveredAfterNavigation).slice(0, 160))
  } finally {
    webview.executeJavaScript = originalExecute
    webview.loadURL = originalLoadURL
    moduleExports.__test.TIMEOUTS.guest = originalGuestTimeout
    moduleExports.__test.TIMEOUTS.navigation = originalNavigationTimeout
  }

  // --- off-screen support ---
  sidebar.setMounted('session-2')
  const backgroundRead = await send({ id: 'b1', action: 'read', sessionId: 'session-1', tabId: tab.tabId })
  check('background read works with note', backgroundRead.ok === true && typeof backgroundRead.value.note === 'string'
    && backgroundRead.value.note.includes('not visible right now'), backgroundRead.value?.note)
  const backgroundOpen = await send({ id: 'b2', action: 'open', sessionId: 'session-1', url: 'https://example.test/x' })
  check('background open refuses', backgroundOpen.ok === false && backgroundOpen.error.includes('showing conversation session-2'), backgroundOpen.error)
  sidebar.setMounted('session-1')

  // --- session mismatch on page actions is refused ---
  const mismatchRead = await send({ id: 'm1', action: 'read', sessionId: 'session-9', tabId: tab.tabId })
  check('unknown session surface refuses', mismatchRead.ok === false
    && mismatchRead.error.includes('no right-sidebar surface'), mismatchRead.error)

  // --- teardown stops polling ---
  stopBridge()
  const pollCount = polls.length
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('bridge stops after dispose', polls.length === pollCount, `${polls.length} vs ${pollCount}`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('harness crashed:', error)
  process.exitCode = 1
})
