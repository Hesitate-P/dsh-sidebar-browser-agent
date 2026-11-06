/**
 * Host-half regression suite.
 *
 * Exercises, with no third-party dependencies:
 *  - the native Schemastery Config contract (defaults, validation, markers);
 *  - configuration switches (enabled, allowedHosts, allowEval, allowNativeInput);
 *  - tool registration, output schemas, and the real HTTP bridge handlers;
 *  - screenshot attachment conversion and its rendered image block;
 *  - version consistency between package.json, both halves, and diagnostics.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config, PLUGIN_VERSION } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
const clientSource = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`PASS ${name}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

// --- schema checker: mirrors the supported raw-JSON-Schema subset the registry enforces ---

function assertSupportedJsonSchema(schema) {
  const TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']
  const ALLOWED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description'])
  function walk(node, at) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${at} must be an object`)
    if (node.required === true) throw new Error(`${at}.required is not supported as a property flag`)
    if (node.required !== undefined && !Array.isArray(node.required)) throw new Error(`${at}.required must be an array`)
    for (const key of Object.keys(node)) if (!ALLOWED.has(key)) throw new Error(`${at}.${key} is not supported`)
    if (node.type !== undefined && !TYPES.includes(node.type)) throw new Error(`${at}.type ${node.type} is not supported`)
    if (node.type === 'object') {
      if (typeof node.additionalProperties !== 'boolean') throw new Error(`${at}.additionalProperties must be explicit`)
      for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, `${at}.properties.${name}`)
      for (const name of node.required ?? []) if (node.properties?.[name] === undefined) throw new Error(`${at}.required names unknown ${name}`)
    }
    if (node.type === 'array' && node.items !== undefined) walk(node.items, `${at}.items`)
  }
  walk(schema, 'schema')
}

function validateJsonSchemaValue(schema, value, at) {
  const violations = []
  function walk(node, candidate, where) {
    if (node.type === 'object') {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        violations.push(`${where} must be an object`)
        return
      }
      for (const name of node.required ?? []) if (!(name in candidate)) violations.push(`${where}.${name} is required`)
      for (const [name, child] of Object.entries(candidate)) {
        const childSchema = node.properties?.[name]
        if (childSchema === undefined) {
          if (node.additionalProperties === false) violations.push(`${where}.${name} is not allowed`)
          continue
        }
        walk(childSchema, child, `${where}.${name}`)
      }
      return
    }
    if (node.type === 'array') {
      if (!Array.isArray(candidate)) {
        violations.push(`${where} must be an array`)
        return
      }
      if (node.items !== undefined) candidate.forEach((item, index) => walk(node.items, item, `${where}[${index}]`))
      return
    }
    if (node.enum !== undefined && !node.enum.includes(candidate)) violations.push(`${where} is not one of the enum`)
    if (node.type === 'string' && typeof candidate !== 'string') violations.push(`${where} must be a string`)
    if (node.type === 'boolean' && typeof candidate !== 'boolean') violations.push(`${where} must be a boolean`)
    if (node.type === 'integer' && !Number.isInteger(candidate)) violations.push(`${where} must be an integer`)
    if (node.type === 'number' && typeof candidate !== 'number') violations.push(`${where} must be a number`)
  }
  walk(schema, value, at)
  return violations
}

// --- mocked plugin context ---

function makeHarness() {
  const routes = new Map()
  const tools = new Map()
  const logs = { info: [], warn: [] }
  const savedImages = []
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      savedImages.push({ bytes: data.length, mediaType, name })
      return { attachmentId: `attachment-${savedImages.length}`, mediaType, bytes: data.length, width: 1024, height: 768, name }
    },
  }
  const ctx = {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: { requestRejection: () => undefined },
    tools: {
      register(definition, options) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, { definition, options })
        return () => tools.delete(definition.name)
      },
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'attachments') return attachments
      if (name === 'webServer') return ctx.webServer
      if (name === 'connection') return ctx.connection
      if (name === 'tools') return ctx.tools
      return undefined
    },
    logger: {
      info: (...args) => logs.info.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
    },
  }
  return { routes, tools, logs, savedImages, attachments, ctx }
}

/**
 * Build the config shape the Loader hands to `apply`: every field is a stable
 * volatile reference whose `.get()` the plugin calls at use time.
 */
function liveConfigRefs(initial) {
  const values = {
    enabled: true,
    allowEval: true,
    allowNativeInput: true,
    allowUploads: true,
    allowedHosts: [],
    ...initial,
  }
  return {
    values,
    config: {
      enabled: { get: () => values.enabled },
      allowEval: { get: () => values.allowEval },
      allowNativeInput: { get: () => values.allowNativeInput },
      allowUploads: { get: () => values.allowUploads },
      allowedHosts: { get: () => values.allowedHosts },
    },
  }
}

/** Mount the plugin with live volatile config references. */
function start(initial) {
  const harness = makeHarness()
  const live = liveConfigRefs(initial)
  apply(harness.ctx, live.config)
  return { ...harness, live }
}

function makeExec(sessionId = 'session-1') {
  return { agent: { session: { id: sessionId } }, signal: new AbortController().signal }
}

async function runTool(harness, name, args, sessionId = 'session-1') {
  const registration = harness.tools.get(name)
  if (registration === undefined) throw new Error(`${name} is not registered`)
  return registration.definition.execute(args, makeExec(sessionId))
}

// --- fake page over the real bridge handlers ---

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  return req
}

function makeRes() {
  const res = new EventEmitter()
  res.writableEnded = false
  res.destroyed = false
  let done
  res.finished = new Promise((resolve) => {
    done = resolve
  })
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.writableEnded = true
    res.body = body
    done()
  }
  return res
}

function routeHelpers(harness) {
  async function callRoute(routePath, { method = 'GET', query = '', body } = {}) {
    const route = harness.routes.get(routePath)
    if (route === undefined) throw new Error(`route ${routePath} is not registered`)
    const res = makeRes()
    await route.handler(makeReq(method, `${routePath}${query}`, body), res)
    await res.finished
    return { status: res.status, json: res.body === undefined ? undefined : JSON.parse(res.body) }
  }

  function parkPoll(query = '?clientId=page-1&session=session-1') {
    const route = harness.routes.get('/plugin/sidebar-browser-agent/poll')
    const res = makeRes()
    const pending = Promise.resolve(route.handler(makeReq('GET', `/plugin/sidebar-browser-agent/poll${query}`), res)).then(async () => {
      await res.finished
      return { status: res.status, json: JSON.parse(res.body) }
    })
    return pending
  }

  return { callRoute, parkPoll }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One fake page turn: take the next parked poll and answer its commands. */
async function pageTurn(harness, handler) {
  const { callRoute, parkPoll } = routeHelpers(harness)
  const poll = parkPoll()
  await sleep(20)
  return poll.then(async (result) => {
    for (const command of result.json.commands ?? []) {
      await callRoute('/plugin/sidebar-browser-agent/result', {
        method: 'POST',
        body: JSON.stringify({ id: command.id, ...handler(command) }),
      })
    }
    return result
  })
}

function fakePage(command) {
  const base = { sessionId: command.sessionId, tabId: command.tabId ?? 'tab-1' }
  switch (command.action) {
    case 'open':
      return { ok: true, value: { action: 'open', sessionId: command.sessionId, tabId: 'tab-2', url: command.url } }
    case 'list':
      return {
        ok: true,
        value: {
          action: 'list',
          sessionId: command.sessionId,
          tabs: [{ tabId: 'tab-2', kind: 'browser', url: 'https://example.com/', title: 'Example Domain', active: true }],
        },
      }
    case 'read':
      return {
        ok: true,
        value: {
          action: 'read',
          ...base,
          mode: command.mode ?? 'text',
          url: 'https://example.com/',
          title: 'Example Domain',
          ...(command.mode === 'interactive'
            ? { elements: [{ index: 0, tag: 'a', label: 'More information', href: 'https://iana.org/', selector: 'a', x: 100, y: 200 }] }
            : command.mode === 'html'
              ? { html: '<html><body>hi</body></html>', totalChars: 30, truncated: false }
              : { text: 'Example Domain\nThis domain is for use in illustrative examples.', totalChars: 60, truncated: false }),
        },
      }
    case 'click':
      return {
        ok: true,
        value: {
          action: 'click',
          ...base,
          url: 'https://example.com/',
          title: 'Example Domain',
          target: { tag: 'a', label: 'More information', x: 100, y: 200 },
        },
      }
    case 'type':
      return {
        ok: true,
        value: {
          action: 'type',
          ...base,
          url: 'https://example.com/',
          title: 'Example Domain',
          target: { tag: 'input' },
          typed: String(command.text ?? '').length,
          submitted: command.submit === true,
        },
      }
    case 'screenshot':
      return {
        ok: true,
        value: {
          action: 'screenshot',
          ...base,
          url: 'https://example.com/',
          title: 'Example Domain',
          width: 1024,
          height: 768,
          mediaType: 'image/png',
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        },
      }
    case 'wait':
      return {
        ok: true,
        value: {
          action: 'wait',
          ...base,
          url: 'https://example.com/',
          title: 'Example Domain',
          matched: true,
          waitedMs: 240,
          ...(command.selector === undefined ? {} : { selector: command.selector }),
          ...(command.contains === undefined ? {} : { contains: command.contains }),
        },
      }
    case 'eval':
      return {
        ok: true,
        value: { action: 'eval', ...base, url: 'https://example.com/', title: 'Example Domain', result: '{"answer":42}', truncated: false },
      }
    case 'back':
    case 'forward':
      return {
        ok: true,
        value: { action: command.action, ...base, url: 'https://example.com/previous', canGoBack: command.action === 'forward', canGoForward: command.action === 'back' },
      }
    case 'viewport':
      return {
        ok: true,
        value: { action: 'viewport', ...base, viewport: { width: command.width ?? 723, height: command.height ?? 843 }, frame: { width: 1024, height: 768 }, ...(command.reset === true ? { applied: 'reset' } : command.width === undefined ? {} : { applied: { width: command.width, height: command.height } }) },
      }
    case 'dialog':
      return {
        ok: true,
        value: { action: 'dialog', ...base, policy: command.policy ?? 'dismiss', dialogs: [], count: 0 },
      }
    case 'download':
      return {
        ok: true,
        value: { action: 'download', ...base, url: command.url, name: 'file.txt', method: 'file-bridge', path: '/tmp/example/file.txt', bytes: 3 },
      }
    case 'upload':
      return {
        ok: true,
        value: { action: 'upload', ...base, files: (command.files ?? []).map((file) => file.name), count: (command.files ?? []).length, mode: 'file-input', uploadMode: 'file-input' },
      }
    default:
      return { ok: false, error: `unexpected action ${command.action}` }
  }
}

async function expectThrow(run) {
  try {
    await run()
    return undefined
  } catch (error) {
    return error.message
  }
}

async function main() {
  // --- Config contract: a native Schemastery schema whose fields are volatile ---
  check('config is native schemastery', Config[Symbol.for('schemastery')] === true && typeof Config.type === 'string' && typeof Config.meta === 'object')
  const declared = ['enabled', 'allowedHosts', 'allowEval', 'allowNativeInput', 'allowUploads']
  check('config exposes the five switches', declared.every((key) => Config.dict[key] !== undefined), Object.keys(Config.dict ?? {}).join(','))
  check('config fields are volatile', declared.every((key) => Config.dict[key].meta?.volatile === true), JSON.stringify(declared.map((key) => [key, Config.dict[key]?.meta?.volatile])))
  check('config defaults', Config.dict.enabled.meta.default === true
    && Config.dict.allowEval.meta.default === true
    && Config.dict.allowNativeInput.meta.default === true
    && Config.dict.allowUploads.meta.default === true
    && Array.isArray(Config.dict.allowedHosts.meta.default)
    && Config.dict.allowedHosts.meta.default.length === 0, JSON.stringify(declared.map((key) => Config.dict[key].meta.default)))
  const invalid = Config['~standard'].validate({ enabled: 'nope' })
  check('config rejects invalid values', Array.isArray(invalid.issues) && invalid.issues.length > 0, JSON.stringify(invalid))
  const badHosts = Config['~standard'].validate({ allowedHosts: 'example.com' })
  check('config rejects a non-array host list', Array.isArray(badHosts.issues) && badHosts.issues.length > 0, JSON.stringify(badHosts))

  // --- version consistency and the versioned Host entry ---
  check('package version matches host constant', packageJson.version === PLUGIN_VERSION, `${packageJson.version} vs ${PLUGIN_VERSION}`)
  check('client version matches package', clientSource.includes(`PLUGIN_VERSION = '${packageJson.version}'`), packageJson.version)
  const iconReference = packageJson.icon
  check('package declares a relative icon', typeof iconReference === 'string' && iconReference.startsWith('./') && !iconReference.includes('..'), iconReference)
  const iconFile = typeof iconReference === 'string' ? path.resolve(here, '..', iconReference) : ''
  check('declared icon exists', iconFile !== '' && fs.existsSync(iconFile), iconFile)
  const iconSource = iconFile !== '' && fs.existsSync(iconFile) ? fs.readFileSync(iconFile, 'utf8') : ''
  check('declared icon is a 36x36 svg', iconSource.startsWith('<svg') && iconSource.includes('viewBox="0 0 36 36"'), iconSource.slice(0, 60))
  check('declared icon ships with the package', Array.isArray(packageJson.files) && packageJson.files.includes('icon.svg'), JSON.stringify(packageJson.files))

  const expectedEntry = `./lib/entry-${packageJson.version}.js`
  check('package entry is versioned', packageJson.exports?.['.'] === expectedEntry, packageJson.exports?.['.'])
  const entryFile = path.join(here, '..', 'lib', `entry-${packageJson.version}.js`)
  const hostSource = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
  check('versioned entry exists', fs.existsSync(entryFile), entryFile)
  check('versioned entry matches the host source', fs.existsSync(entryFile) && fs.readFileSync(entryFile, 'utf8') === hostSource)
  check('versioned entry reports the current version', fs.existsSync(entryFile) && fs.readFileSync(entryFile, 'utf8').includes(`PLUGIN_VERSION = '${packageJson.version}'`))

  // --- default mount ---
  const harness = start()
  check('routes registered', harness.routes.size === 3, [...harness.routes.keys()].join(','))
  check('both tools registered', harness.tools.has('sidebar_browser') && harness.tools.has('sidebar_page'))
  check('startup self-check logged ready', harness.logs.info.some((line) => line.includes('ready')) && harness.logs.warn.length === 0, JSON.stringify(harness.logs))
  for (const name of ['sidebar_browser', 'sidebar_page']) {
    let schemaError
    try {
      assertSupportedJsonSchema(harness.tools.get(name).definition.output.schema)
    } catch (error) {
      schemaError = error.message
    }
    check(`${name} output schema supported`, schemaError === undefined, schemaError)
  }

  // --- status offline carries host diagnostics ---
  const offline = await runTool(harness, 'sidebar_browser', { action: 'status' })
  check('offline status is diagnostic', offline.pageConnected === false
    && offline.note.includes(`host-plugin=${PLUGIN_VERSION}`)
    && offline.note.includes('attachments=available')
    && offline.note.includes('"enabled":true'), offline.note)

  // --- disabled mount: tools stay registered but their step condition hides them ---
  const disabled = start({ enabled: false })
  check('disabled config keeps both tools registered', disabled.tools.size === 2, [...disabled.tools.keys()].join(','))
  check('disabled config hides tools from agents', disabled.tools.get('sidebar_browser').options.when() === false
    && disabled.tools.get('sidebar_page').options.when() === false, JSON.stringify(disabled.tools.get('sidebar_browser').options))
  check('disabled config keeps bridge routes', disabled.routes.size === 3)
  check('disabled config logs ready', disabled.logs.info.some((line) => line.includes('enabled=false')), JSON.stringify(disabled.logs))

  // --- editing a volatile field applies live, without a restart ---
  const liveHarness = start()
  check('enabled tool visible by default', liveHarness.tools.get('sidebar_browser').options.when() === true)
  liveHarness.live.values.enabled = false
  check('enabled switch hides tools live', liveHarness.tools.get('sidebar_browser').options.when() === false)
  liveHarness.live.values.enabled = true
  check('enabled switch restores tools live', liveHarness.tools.get('sidebar_browser').options.when() === true)
  liveHarness.live.values.allowEval = false
  const liveEvalBlocked = await expectThrow(() => runTool(liveHarness, 'sidebar_page', { action: 'eval', code: '1+1' }))
  check('live allowEval gate applies', typeof liveEvalBlocked === 'string' && liveEvalBlocked.includes('"eval" is disabled'), liveEvalBlocked)

  // --- configuration gates fire before the bridge ---
  const gated = start({ allowedHosts: ['example.com'], allowEval: false, allowNativeInput: false })
  const blockedHost = await expectThrow(() => runTool(gated, 'sidebar_browser', { action: 'open', url: 'https://malicious.test/' }))
  check('allowedHosts blocks other hosts', typeof blockedHost === 'string' && blockedHost.includes('does not allow host "malicious.test"'), blockedHost)
  const blockedEval = await expectThrow(() => runTool(gated, 'sidebar_page', { action: 'eval', code: '1+1' }))
  check('allowEval=false blocks eval', typeof blockedEval === 'string' && blockedEval.includes('"eval" is disabled'), blockedEval)
  const blockedClick = await expectThrow(() => runTool(gated, 'sidebar_page', { action: 'click', selector: 'a' }))
  check('allowNativeInput=false blocks click', typeof blockedClick === 'string' && blockedClick.includes('disabled by the plugin configuration'), blockedClick)
  const blockedType = await expectThrow(() => runTool(gated, 'sidebar_page', { action: 'type', text: 'x' }))
  check('allowNativeInput=false blocks type', typeof blockedType === 'string' && blockedType.includes('disabled'), blockedType)

  // --- allowlist permits a configured host through the bridge ---
  await routeHelpers(gated).callRoute('/plugin/sidebar-browser-agent/report', {
    method: 'POST',
    body: JSON.stringify({ status: 'started', mounted: 'session-1', carrier: 'electron-webview', href: 'http://127.0.0.1:1/' }),
  })
  const allowedTurn = pageTurn(gated, fakePage)
  await sleep(10)
  const allowedOpen = await runTool(gated, 'sidebar_browser', { action: 'open', url: 'https://example.com/page' })
  await allowedTurn
  check('allowedHosts permits configured host', allowedOpen.url === 'https://example.com/page', JSON.stringify(allowedOpen))

  // --- bridge round trip + tool behaviours on the default mount ---
  await routeHelpers(harness).callRoute('/plugin/sidebar-browser-agent/report', {
    method: 'POST',
    body: JSON.stringify({ status: 'started', mounted: 'session-1', carrier: 'electron-webview', href: 'http://127.0.0.1:1/' }),
  })
  let turn = pageTurn(harness, fakePage)
  await sleep(10)
  const open = await runTool(harness, 'sidebar_browser', { action: 'open', url: 'https://example.com' })
  await turn
  check('open result', open.tabId === 'tab-2' && open.url === 'https://example.com/', JSON.stringify(open))

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const list = await runTool(harness, 'sidebar_browser', { action: 'list' })
  await turn
  check('list carries native title/url', list.tabs[0].title === 'Example Domain', JSON.stringify(list))

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const read = await runTool(harness, 'sidebar_page', { action: 'read' })
  await turn
  check('read text value', read.text.includes('Example Domain') && read.mode === 'text', JSON.stringify(read))
  const readContent = harness.tools.get('sidebar_page').definition.output.render({}, read)
  check('read render', readContent[0].type === 'text' && readContent[0].text.includes('illustrative examples'), readContent[0].text)

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const interactive = await runTool(harness, 'sidebar_page', { action: 'read', mode: 'interactive' })
  await turn
  check('interactive read', interactive.elements.length === 1 && interactive.elements[0].selector === 'a', JSON.stringify(interactive))

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const click = await runTool(harness, 'sidebar_page', { action: 'click', contains: 'More information' })
  await turn
  check('click value', click.target.tag === 'a' && click.target.x === 100, JSON.stringify(click))

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const typed = await runTool(harness, 'sidebar_page', { action: 'type', selector: '#q', text: 'hello', submit: true })
  await turn
  check('type value', typed.typed === 5 && typed.submitted === true, JSON.stringify(typed))

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const waited = await runTool(harness, 'sidebar_page', { action: 'wait', selector: '#q' })
  await turn
  check('wait value', waited.matched === true, JSON.stringify(waited))

  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const evaluated = await runTool(harness, 'sidebar_page', { action: 'eval', code: '({answer: 42})' })
  await turn
  const evalContent = harness.tools.get('sidebar_page').definition.output.render({}, evaluated)
  check('eval render', evalContent[0].text.includes('{"answer":42}'), evalContent[0].text)

  // --- screenshot: attachment conversion + image content block ---
  turn = pageTurn(harness, fakePage)
  await sleep(10)
  const shot = await runTool(harness, 'sidebar_page', { action: 'screenshot' })
  await turn
  check('screenshot saved as attachment', harness.savedImages.length === 1 && harness.savedImages[0].mediaType === 'image/png', JSON.stringify(harness.savedImages))
  check('screenshot value strips base64', shot.image.attachmentId === 'attachment-1' && shot.base64 === undefined, JSON.stringify(shot))
  const shotContent = harness.tools.get('sidebar_page').definition.output.render({}, shot)
  check('screenshot renders image block', shotContent.length === 2 && shotContent[1].type === 'image' && shotContent[1].attachment.attachmentId === 'attachment-1', JSON.stringify(shotContent))

  // --- loopback file bridge: one-shot upload source and download sink tokens ---
  const bridgeDir = fs.mkdtempSync(path.join(tmpdir(), 'dsh-host-bridge-'))
  const samplePath = path.join(bridgeDir, 'sample.txt')
  fs.writeFileSync(samplePath, 'bridge-bytes')
  const uploadTurn = pageTurn(harness, fakePage)
  await sleep(10)
  const upload = await runTool(harness, 'sidebar_page', { action: 'upload', selector: '#file', paths: [samplePath] })
  const uploadPoll = await uploadTurn
  const uploadCommand = uploadPoll.json.commands[0]
  const sourceUrl = uploadCommand?.files?.[0]?.url
  const firstSource = typeof sourceUrl === 'string' ? await fetch(sourceUrl) : undefined
  const sourceBody = firstSource === undefined ? '' : await firstSource.text()
  const secondSource = typeof sourceUrl === 'string' ? await fetch(sourceUrl) : undefined
  check('upload command carries a one-shot bridge URL',
    upload.count === 1 && uploadCommand?.files?.[0]?.name === 'sample.txt'
    && firstSource?.status === 200 && sourceBody === 'bridge-bytes' && secondSource?.status === 403,
    JSON.stringify({ upload, files: uploadCommand?.files, first: firstSource?.status, second: secondSource?.status }))
  fs.rmSync(bridgeDir, { recursive: true, force: true })

  const downloadTurn = pageTurn(harness, fakePage)
  await sleep(10)
  const download = await runTool(harness, 'sidebar_page', { action: 'download', url: 'https://example.com/file.txt' })
  const downloadPoll = await downloadTurn
  const sinkUrl = downloadPoll.json.commands[0]?.sink?.url
  check('download command carries a one-shot sink URL',
    typeof sinkUrl === 'string' && sinkUrl.includes('token=') && download.method === 'file-bridge' && download.path === '/tmp/example/file.txt',
    JSON.stringify({ download, sinkUrl }))

  // --- argument validation before the bridge ---
  const missingText = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'type' }))
  check('type requires text', typeof missingText === 'string' && missingText.startsWith('type requires "text"'), missingText)
  const missingClickTarget = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'click' }))
  check('click requires target', typeof missingClickTarget === 'string' && missingClickTarget.includes('needs a "ref"'), missingClickTarget)
  const invalidRef = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'click', ref: 'nope' }))
  check('invalid ref rejected', typeof invalidRef === 'string' && invalidRef.includes('"ref" must look like'), invalidRef)
  const fullPageTurn = pageTurn(harness, fakePage)
  await sleep(10)
  const fullPageShot = await runTool(harness, 'sidebar_page', { action: 'screenshot', fullPage: true })
  const fullPagePoll = await fullPageTurn
  check('fullPage screenshot forwarded', fullPagePoll.json.commands[0]?.fullPage === true && fullPageShot.image !== undefined && fullPageShot.width === 1024, JSON.stringify(fullPageShot).slice(0, 200))
  const badDialogPolicy = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'dialog', policy: 'maybe' }))
  check('dialog policy validated', typeof badDialogPolicy === 'string' && badDialogPolicy.includes('dialog "policy"'), badDialogPolicy)
  const badViewport = await expectThrow(() => runTool(harness, 'sidebar_browser', { action: 'viewport', tabId: 'tab-1', width: 500 }))
  check('viewport resize needs both dimensions', typeof badViewport === 'string' && badViewport.includes('both "width" and "height"'), badViewport)
  const badDragButton = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'drag', ref: 'e1', toRef: 'e2', button: 'scroll' }))
  check('drag button validated', typeof badDragButton === 'string' && badDragButton.includes('"button" must be'), badDragButton)
  const badZoom = await expectThrow(() => runTool(harness, 'sidebar_browser', { action: 'zoom', tabId: 'tab-1', zoomFactor: 9 }))
  check('zoom factor bounded', typeof badZoom === 'string' && badZoom.includes('zoomFactor'), badZoom)
  const missingMark = await expectThrow(() => runTool(harness, 'sidebar_browser', { action: 'finalize', tabId: 'tab-1' }))
  check('finalize requires a mark', typeof missingMark === 'string' && missingMark.includes('finalize "mark"'), missingMark)
  const batchEval = await expectThrow(() => runTool(gated, 'sidebar_page', { action: 'batch', batch: [{ action: 'eval', code: '1' }] }))
  check('batch gates eval steps', typeof batchEval === 'string' && batchEval.includes('"eval" is disabled'), batchEval)
  const batchNative = await expectThrow(() => runTool(gated, 'sidebar_page', { action: 'batch', batch: [{ action: 'click', selector: 'a' }] }))
  check('batch gates native steps', typeof batchNative === 'string' && batchNative.includes('allowNativeInput'), batchNative)
  const batchScreenshot = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'batch', batch: [{ action: 'screenshot' }] }))
  check('batch refuses screenshots', typeof batchScreenshot === 'string' && batchScreenshot.includes('batch steps cannot take screenshots'), batchScreenshot)
  const nestedBatch = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'batch', batch: [{ action: 'batch', batch: [] }] }))
  check('batch refuses nesting', typeof nestedBatch === 'string' && nestedBatch.includes('cannot be nested'), nestedBatch)
  const badDownloadScheme = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'download', url: 'javascript:alert(1)' }))
  check('download URL scheme validated', typeof badDownloadScheme === 'string' && badDownloadScheme.includes('download "url" must be'), badDownloadScheme)
  const missingDownloadTarget = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'download' }))
  check('download needs a URL or target', typeof missingDownloadTarget === 'string' && missingDownloadTarget.includes('needs a "ref"'), missingDownloadTarget)
  const missingUploadPaths = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'upload', selector: '#file' }))
  check('upload needs paths', typeof missingUploadPaths === 'string' && missingUploadPaths.includes('needs "paths"'), missingUploadPaths)
  const relativeUpload = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'upload', selector: '#file', paths: ['relative/file.txt'] }))
  check('upload rejects relative paths', typeof relativeUpload === 'string' && relativeUpload.includes('[bad-path]'), relativeUpload)
  const gatedUpload = await expectThrow(() => runTool(start({ allowUploads: false }), 'sidebar_page', { action: 'upload', selector: '#file', paths: ['/tmp/x'] }))
  check('allowUploads=false blocks upload', typeof gatedUpload === 'string' && gatedUpload.includes('allowUploads'), gatedUpload)
  const batchUpload = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'batch', batch: [{ action: 'upload', selector: '#file', paths: ['/tmp/x'] }] }))
  check('batch refuses uploads', typeof batchUpload === 'string' && batchUpload.includes('cannot upload files'), batchUpload)
  const batchDownload = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'batch', batch: [{ action: 'download', url: 'https://example.com/f.txt' }] }))
  check('batch refuses downloads', typeof batchDownload === 'string' && batchDownload.includes('cannot download files'), batchDownload)
  const badUrl = await expectThrow(() => runTool(harness, 'sidebar_browser', { action: 'open', url: 'file:///etc/passwd' }))
  check('non-http url rejected', typeof badUrl === 'string' && badUrl.includes('only opens http://'), badUrl)

  // --- page failure propagates ---
  turn = pageTurn(harness, () => ({ ok: false, error: 'the page context rejected the script: boom' }))
  await sleep(10)
  const pageError = await expectThrow(() => runTool(harness, 'sidebar_page', { action: 'read' }))
  await turn
  check('page failure propagates', pageError === 'the page context rejected the script: boom', pageError)

  // --- output values validate against their own schemas ---
  for (const [name, value] of [
    ['sidebar_browser', open],
    ['sidebar_browser', list],
    ['sidebar_page', read],
    ['sidebar_page', interactive],
    ['sidebar_page', click],
    ['sidebar_page', typed],
    ['sidebar_page', waited],
    ['sidebar_page', evaluated],
    ['sidebar_page', shot],
  ]) {
    const violations = validateJsonSchemaValue(harness.tools.get(name).definition.output.schema, value, 'value')
    check(`${name} ${String(value.action)} output validates`, violations.length === 0, violations.join('; '))
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('harness crashed:', error)
  process.exitCode = 1
})
