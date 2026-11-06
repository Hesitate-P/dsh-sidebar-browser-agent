/**
 * Host half of `dsh-sidebar-browser-agent`.
 *
 * Responsibilities:
 *  1. Register two model-facing tools:
 *     - `sidebar_browser` — tab management of the native right-sidebar browser;
 *     - `sidebar_page`    — page content and interaction in a native browser tab.
 *  2. Run the HTTP long-poll bridge carrying commands to the Web page half and
 *     answers back.
 *  3. Turn a screenshot's base64 PNG into a durable image attachment so the
 *     model receives the actual image as a content block.
 *
 * The page half drives the native Electron guest (`executeJavaScript`,
 * `capturePage`, `sendInputEvent`); this half never renders a page itself.
 */
import { randomUUID } from 'node:crypto'
import z from '../vendor/schemastery/index.mjs'

/** Plugin identity used by the bundle patch row. */
export const name = 'dsh-sidebar-browser-agent'

/** Plugin version reported by diagnostics; keep in sync with package.json. */
export const PLUGIN_VERSION = '0.2.11'

/** Services that must exist before this plugin mounts. */
export const inject = ['webServer', 'connection', 'tools']

/**
 * Configuration schema shown by the Plugin Manager.
 *
 * This is a real native Schemastery schema (vendored, so a linked install
 * needs no module resolution from the profile): the Loader validates and
 * applies defaults, and Plugin Manager renders the fields for editing.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('Register the sidebar_browser and sidebar_page agent tools.'),
  allowedHosts: z.array(z.string()).default([]).volatile().description('Limit "open" and "navigate" to these hosts. An entry matches that exact host or a subdomain suffix; an empty list allows every HTTP(S) host.'),
  allowEval: z.boolean().default(true).volatile().description('Allow sidebar_page action "eval" (arbitrary JavaScript in the page).'),
  allowNativeInput: z.boolean().default(true).volatile().description('Allow sidebar_page click, type and press actions (native mouse and keyboard input).'),
})

/** Routes the page half talks to. */
const ROUTES = {
  poll: '/plugin/sidebar-browser-agent/poll',
  result: '/plugin/sidebar-browser-agent/result',
  report: '/plugin/sidebar-browser-agent/report',
}

/** How long one poll request is held open while no command is pending. */
const POLL_HOLD_MS = 15_000
/** How long a tool call waits for the page's answer before failing. */
const RESULT_TIMEOUT_MS = 30_000
/** How long a tool call waits for a connected poller when none is parked. */
const CLIENT_WAIT_MS = 2_500
/** A client whose last poll is older than this is treated as disconnected. */
const CLIENT_STALE_MS = 5_000
/** Upper bound for a bridge request body (screenshots travel through it). */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** Hard cap on one screenshot payload. */
const MAX_SCREENSHOT_BASE64 = 12_000_000

/** Tab-management actions of `sidebar_browser`. */
const TAB_ACTIONS = ['status', 'list', 'open', 'navigate', 'reload', 'focus', 'close']
/** Actions that need an HTTP(S) address. */
const URL_ACTIONS = new Set(['open', 'navigate'])
/** Actions that need an existing tab id. */
const TAB_ID_ACTIONS = new Set(['navigate', 'reload', 'focus', 'close'])
/** Page-content actions of `sidebar_page`. */
const PAGE_ACTIONS = ['read', 'click', 'type', 'press', 'scroll', 'eval', 'wait', 'screenshot']
/** Read modes. */
const READ_MODES = ['text', 'interactive', 'html']

/**
 * Write one JSON response unless the peer already went away.
 * @param res - Node response owned by the route handler.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function writeJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read a bounded request body as UTF-8 text.
 * @param req - Node request.
 * @param limit - maximum accepted byte count.
 * @returns the decoded body.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/**
 * Build the error a cancellation raises from a tool call.
 * @param reason - abort reason when the caller supplied one.
 * @returns an Error carrying the usual aborted message.
 */
function abortError(reason) {
  const error = new Error('the tool call was aborted')
  error.name = 'AbortError'
  if (reason !== undefined) error.cause = reason
  return error
}

/**
 * Sleep that also settles when the caller aborts.
 * @param ms - milliseconds to wait.
 * @param signal - optional caller signal.
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      finish()
      resolve()
    }, ms)
    const onAbort = () => {
      finish()
      reject(abortError(signal.reason))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        finish()
        reject(abortError(signal.reason))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Validate and normalize one HTTP(S) address.
 * @param raw - model-supplied address.
 * @param action - action asking for it, used in the failure text.
 * @returns the normalized absolute URL string.
 */
function normalizeHttpUrl(raw, action) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`action "${action}" requires an http:// or https:// url`)
  }
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new Error(`"${raw}" is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('the sidebar browser only opens http:// and https:// URLs')
  }
  return parsed.toString()
}

/**
 * Normalize the validated plugin configuration into the exact shape used at runtime.
 * @param config - config object handed to apply (defaults already applied by the loader).
 * @returns the resolved switches.
 */
function fieldValue(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  if (field === undefined) return fallback
  return field
}

/**
 * Read the switch values currently in force.
 *
 * The declaration marks every field `.volatile()`, so the Loader hands the
 * plugin stable references; editing the row in Plugin Manager (or the profile
 * patch) updates those references without restarting the plugin.
 * @param config - raw plugin config from `apply` (volatile fields are references).
 * @returns the resolved switches.
 */
function liveConfig(config) {
  const raw = config === null || typeof config !== 'object' ? {} : config
  const hosts = fieldValue(raw.allowedHosts, [])
  return {
    enabled: fieldValue(raw.enabled, true) !== false,
    allowEval: fieldValue(raw.allowEval, true) !== false,
    allowNativeInput: fieldValue(raw.allowNativeInput, true) !== false,
    allowedHosts: Array.isArray(hosts)
      ? hosts.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim().toLowerCase())
      : [],
  }
}

/**
 * Enforce the configured host allowlist for one navigation.
 * @param url - normalized absolute HTTP(S) URL.
 * @param config - resolved switches.
 */
function assertHostAllowed(url, config) {
  if (config.allowedHosts.length === 0) return
  const parsed = new URL(url)
  const host = parsed.host.toLowerCase()
  const hostname = parsed.hostname.toLowerCase()
  const allowed = config.allowedHosts.some((entry) => {
    const candidate = entry.startsWith('*.') ? entry.slice(2) : entry
    return host === candidate || hostname === candidate || hostname.endsWith(`.${candidate}`)
  })
  if (!allowed) {
    throw new Error(`The plugin configuration does not allow host "${parsed.host}"; allowed hosts: ${config.allowedHosts.join(', ')}`)
  }
}

/**
 * Join non-empty diagnostic notes.
 * @param parts - note fragments.
 * @returns one note string.
 */
function joinNotes(parts) {
  return parts.filter((part) => typeof part === 'string' && part !== '').join('; ')
}

/**
 * Host-side facts appended to status notes.
 * @param ctx - host plugin context.
 * @param config - resolved switches.
 * @returns the host diagnostic fragment.
 */
function hostFacts(ctx, config) {
  const attachments = ctx.get('attachments')
  const attachmentsReady = attachments !== undefined && typeof attachments.saveImage === 'function'
  return `host-plugin=${PLUGIN_VERSION}; config=${JSON.stringify(liveConfig(config))}; attachments=${attachmentsReady ? 'available' : 'missing (screenshots unavailable)'}`
}

/**
 * Startup readiness check: verify the services the tools rely on.
 * @param ctx - host plugin context.
 * @param config - resolved switches.
 * @returns the list of problems found.
 */
function selfCheck(ctx, config) {
  const current = liveConfig(config)
  const problems = []
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') problems.push('webServer service is missing route registration')
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') problems.push('connection service is missing requestRejection')
  if (ctx.get('tools') === undefined) problems.push('tools service is missing')
  const attachments = ctx.get('attachments')
  if (attachments === undefined || typeof attachments.saveImage !== 'function') problems.push('attachments service is missing; screenshots will be unavailable')
  const summary = `sidebar-browser-agent ${PLUGIN_VERSION}: ready (enabled=${current.enabled}, allowEval=${current.allowEval}, allowNativeInput=${current.allowNativeInput}, allowedHosts=${current.allowedHosts.length})`
  const logger = ctx.logger
  if (problems.length > 0) {
    if (typeof logger?.warn === 'function') logger.warn(`${summary}; self-check: ${problems.join('; ')}`)
  } else if (typeof logger?.info === 'function') {
    logger.info(summary)
  }
  return problems
}

/**
 * Require one model argument to be a string.
 * @param value - candidate value.
 * @param name - parameter name used in the failure text.
 * @param optional - whether absence is allowed.
 * @returns the trimmed string or undefined.
 */
function requireString(value, name, optional = false) {
  if (value === undefined || value === null) {
    if (optional) return undefined
    throw new Error(`this action requires "${name}"`)
  }
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') {
    if (optional) return undefined
    throw new Error(`"${name}" must be a non-empty string`)
  }
  return trimmed
}

/**
 * @param value - candidate value.
 * @param name - parameter name used in the failure text.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param fallback - value to use when the argument is absent.
 * @returns the bounded number.
 */
function boundedNumber(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${name}" must be a finite number`)
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** One parked poll request waiting for commands. */
class PollWaiter {
  /**
   * @param clientId - page instance that parked the request.
   * @param session - session the page currently shows ('' when none).
   * @param respond - writes the command list to the parked response.
   */
  constructor(clientId, session, respond) {
    this.clientId = clientId
    this.session = session
    this.respond = respond
    this.timer = undefined
    this.answered = false
  }

  /**
   * Answer exactly once.
   * @param commands - commands delivered to this poll.
   */
  answer(commands) {
    if (this.answered) return
    this.answered = true
    clearTimeout(this.timer)
    this.respond(commands)
  }
}

/**
 * Cross-page command bridge for both tools.
 *
 * One process-wide instance owns parked polls, the command queue, and pending
 * tool calls. Multiple pages are supported best-effort: a command is handed to
 * a page showing the calling session when one is parked, otherwise to the
 * first parked page.
 */
class Bridge {
  /**
   * @param ctx - host plugin context (carries webServer and connection).
   */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Map<string, PollWaiter>} parked polls by page instance id */
    this.waiters = new Map()
    /** @type {Array<object>} commands waiting for a poll */
    this.queue = []
    /** @type {Map<string, { settle: (result: object) => void }>} in-flight tool calls */
    this.pending = new Map()
    /** @type {number} time of the most recent poll request */
    this.lastPollAt = 0
    /** @type {object | null} last `started` report from a page */
    this.lastHello = null
    /** @type {string | null} last browser-half error report */
    this.lastError = null
    this.disposed = false
  }

  /** Whether a page is currently parked on a poll. */
  get connected() {
    return this.waiters.size > 0
  }

  /**
   * Register the three bridge routes.
   * @returns a disposer removing them.
   */
  registerRoutes() {
    const disposers = [
      this.ctx.webServer.register({
        kind: 'exact',
        path: ROUTES.poll,
        handler: (req, res) => this.handlePoll(req, res),
      }),
      this.ctx.webServer.register({
        kind: 'exact',
        path: ROUTES.result,
        handler: (req, res) => this.handleResult(req, res),
      }),
      this.ctx.webServer.register({
        kind: 'exact',
        path: ROUTES.report,
        handler: (req, res) => this.handleReport(req, res),
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  /**
   * Admit or refuse one browser request.
   * @param req - Node request.
   * @returns true when the request may be served.
   */
  fence(req) {
    try {
      return this.ctx.connection.requestRejection(req) === undefined
    } catch {
      return false
    }
  }

  /**
   * `GET /poll`: hand over queued commands or park until one arrives.
   * @param req - Node request carrying `clientId` and the shown `session`.
   * @param res - Node response.
   */
  handlePoll(req, res) {
    if (!this.fence(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
    if (this.disposed) return writeJson(res, 503, { ok: false, error: 'plugin disposed' })
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const clientId = (url.searchParams.get('clientId') ?? '').trim()
    if (clientId === '') return writeJson(res, 400, { ok: false, error: 'clientId is required' })
    const session = url.searchParams.get('session') ?? ''
    this.lastPollAt = Date.now()

    const immediate = this.queue.splice(0, this.queue.length)
    if (immediate.length > 0) return writeJson(res, 200, { commands: immediate })

    const previous = this.waiters.get(clientId)
    if (previous !== undefined) {
      this.waiters.delete(clientId)
      previous.answer([])
    }
    const waiter = new PollWaiter(clientId, session, (commands) => {
      writeJson(res, 200, { commands })
    })
    waiter.timer = setTimeout(() => {
      if (this.waiters.get(clientId) === waiter) this.waiters.delete(clientId)
      waiter.answer([])
    }, POLL_HOLD_MS)
    this.waiters.set(clientId, waiter)
    res.on('close', () => {
      if (this.waiters.get(clientId) === waiter) this.waiters.delete(clientId)
    })
  }

  /**
   * `POST /result`: settle one in-flight tool call.
   * @param req - Node request carrying `{ id, ok, value?, error? }`.
   * @param res - Node response.
   */
  async handleResult(req, res) {
    if (!this.fence(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
    let body
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      return writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid body' })
    }
    if (body === null || typeof body !== 'object') {
      return writeJson(res, 400, { ok: false, error: 'invalid body' })
    }
    const id = typeof body.id === 'string' ? body.id : ''
    const pending = this.pending.get(id)
    if (pending === undefined) return writeJson(res, 200, { ok: false, error: 'unknown command' })
    this.pending.delete(id)
    pending.settle({
      ok: body.ok === true,
      value: body.value,
      error: typeof body.error === 'string' && body.error !== '' ? body.error : undefined,
    })
    return writeJson(res, 200, { ok: true })
  }

  /**
   * `POST /report`: record a browser-half lifecycle report for diagnostics.
   * @param req - Node request carrying `{ status, mounted?, carrier?, href?, error? }`.
   * @param res - Node response.
   */
  async handleReport(req, res) {
    if (!this.fence(req)) return writeJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
    let body
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES))
    } catch (error) {
      return writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid body' })
    }
    if (body === null || typeof body !== 'object') return writeJson(res, 400, { ok: false, error: 'invalid body' })
    if (body.status === 'started') {
      this.lastHello = {
        reportedAt: Date.now(),
        mounted: typeof body.mounted === 'string' ? body.mounted : '',
        carrier: typeof body.carrier === 'string' ? body.carrier : '',
        href: typeof body.href === 'string' ? body.href : '',
      }
      this.lastError = null
    } else if (typeof body.error === 'string' && body.error !== '') {
      this.lastError = body.error
    }
    return writeJson(res, 200, { ok: true })
  }

  /**
   * Describe why no page half answered.
   * @returns the failure text handed to the model.
   */
  noClientMessage() {
    const detail = this.lastError !== null
      ? ` Last browser-half error: ${this.lastError}`
      : this.lastHello === null
        ? ' The plugin\'s browser half never reported in; check Settings > Plugins for a client-side load failure, then reload the Harness page.'
        : ` Last browser-half report: carrier=${this.lastHello.carrier || 'unknown'}, mounted=${this.lastHello.mounted === '' ? 'none' : this.lastHello.mounted}, page=${this.lastHello.href}.`
    return `The Harness Web page is not connected to the sidebar browser bridge. Open or reload the Harness page in this profile and retry.${detail}`
  }

  /**
   * Wait until some page is parked on a poll.
   * @param signal - caller cancellation.
   */
  async ensureClient(signal) {
    if (this.connected) return
    if (Date.now() - this.lastPollAt > CLIENT_STALE_MS) throw new Error(this.noClientMessage())
    const deadline = Date.now() + CLIENT_WAIT_MS
    while (!this.connected && Date.now() < deadline) await delay(50, signal)
    if (!this.connected) throw new Error(this.noClientMessage())
  }

  /**
   * Deliver one command to a parked poll, or queue it for the next one.
   * @param entry - command frame including its id.
   * @param sessionId - session the page should show.
   */
  deliver(entry, sessionId) {
    const parked = [...this.waiters.values()]
    const preferred = parked.find((waiter) => waiter.session === sessionId) ?? parked[0]
    if (preferred !== undefined) {
      this.waiters.delete(preferred.clientId)
      preferred.answer([entry])
      return
    }
    this.queue.push(entry)
  }

  /**
   * Send one command to the page half and await its answer.
   * @param command - command fields without id.
   * @param signal - caller cancellation.
   * @returns `{ ok, value?, error? }` from the page.
   */
  async dispatch(command, signal) {
    await this.ensureClient(signal)
    const id = randomUUID()
    const entry = { id, ...command }
    return await new Promise((resolve, reject) => {
      const settle = (result) => {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const fail = (error) => {
        clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) fail(new Error(`The Harness Web page did not answer within ${Math.round(RESULT_TIMEOUT_MS / 1000)}s; retry once the page is focused.`))
      }, RESULT_TIMEOUT_MS)
      const onAbort = () => {
        if (this.pending.delete(id)) fail(abortError(signal?.reason))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          fail(abortError(signal.reason))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, { settle })
      this.deliver(entry, command.sessionId)
    })
  }

  /** Drop parked polls, queued commands and in-flight calls (plugin unload). */
  dispose() {
    this.disposed = true
    for (const waiter of this.waiters.values()) waiter.answer([])
    this.waiters.clear()
    this.queue = []
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.settle({ ok: false, error: 'the sidebar browser agent plugin was unloaded' })
    }
  }
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

/** Parameter JSON Schema of `sidebar_browser`. */
const BROWSER_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: TAB_ACTIONS,
      description: 'status | list | open | navigate | reload | focus | close.',
    },
    url: {
      type: 'string',
      description: 'HTTP(S) address for "open" (new tab) and "navigate" (load into the current tab).',
    },
    tabId: {
      type: 'string',
      description: 'Target tab id from "list" for navigate, reload, focus and close.',
    },
  },
  required: ['action'],
}

/** Output JSON Schema of `sidebar_browser`. */
const BROWSER_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', description: 'The action that ran.' },
    sessionId: { type: 'string', description: 'Calling conversation session id.' },
    tabId: { type: 'string', description: 'The native browser tab affected or created.' },
    url: { type: 'string', description: 'The HTTP(S) address involved.' },
    pageConnected: { type: 'boolean', description: 'Whether the Web page half answered (status only).' },
    note: { type: 'string', description: 'Carrier and bridge diagnostics (status only).' },
    tabs: {
      type: 'array',
      description: 'Open native sidebar browser tabs (list only).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string' },
          kind: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          active: { type: 'boolean' },
        },
      },
    },
  },
  required: ['action'],
}

/** Parameter JSON Schema of `sidebar_page`. */
const PAGE_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: PAGE_ACTIONS,
      description: 'read | click | type | press | scroll | eval | wait | screenshot.',
    },
    tabId: {
      type: 'string',
      description: 'Target browser tab id; omit to use the active browser tab of the calling conversation.',
    },
    mode: {
      type: 'string',
      enum: READ_MODES,
      description: 'read only: "text" visible text (default), "interactive" clickable elements, "html" raw markup.',
    },
    selector: {
      type: 'string',
      description: 'CSS selector for read (scope), click, type, scroll (into view) and wait.',
    },
    contains: {
      type: 'string',
      description: 'Case-insensitive visible-text match for click and wait.',
    },
    text: { type: 'string', description: 'type only: text to write into the field.' },
    clear: { type: 'boolean', description: 'type only: replace the field value first (default true).' },
    submit: { type: 'boolean', description: 'type only: press Enter after typing (default false).' },
    key: {
      type: 'string',
      description: 'press only: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp/Down, Home, End, Space.',
    },
    code: { type: 'string', description: 'eval only: JavaScript to execute in the page; returns its JSON result.' },
    dx: { type: 'number', description: 'scroll only: horizontal pixels (positive scrolls right).' },
    dy: { type: 'number', description: 'scroll only: vertical pixels (positive scrolls down).' },
    x: { type: 'number', description: 'click only: viewport x coordinate when clicking by position.' },
    y: { type: 'number', description: 'click only: viewport y coordinate when clicking by position.' },
    maxChars: { type: 'number', description: 'read only: character cap for text/html (default 12000/30000).' },
    maxElements: { type: 'number', description: 'read interactive only: element cap (default 200, max 500).' },
    timeoutMs: { type: 'number', description: 'wait only: maximum wait in milliseconds (default 5000, max 15000).' },
  },
  required: ['action'],
}

/** Output JSON Schema of `sidebar_page`. */
const PAGE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', description: 'The action that ran.' },
    sessionId: { type: 'string', description: 'Calling conversation session id.' },
    tabId: { type: 'string', description: 'Native browser tab used.' },
    url: { type: 'string', description: 'Page address after the action.' },
    title: { type: 'string', description: 'Page title after the action.' },
    mode: { type: 'string', description: 'read only: the requested mode.' },
    text: { type: 'string', description: 'read text: visible page text.' },
    html: { type: 'string', description: 'read html: page markup.' },
    totalChars: { type: 'integer', description: 'read only: characters before the cap.' },
    truncated: { type: 'boolean', description: 'read/eval only: whether the result hit its cap.' },
    viewport: {
      type: 'object',
      additionalProperties: false,
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
    },
    scroll: {
      type: 'object',
      additionalProperties: false,
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, height: { type: 'integer' } },
    },
    elements: {
      type: 'array',
      description: 'read interactive: visible interactive elements.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          tag: { type: 'string' },
          type: { type: 'string' },
          label: { type: 'string' },
          href: { type: 'string' },
          selector: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          disabled: { type: 'boolean' },
        },
      },
    },
    target: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string' },
        label: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
      },
    },
    typed: { type: 'integer', description: 'type only: characters written.' },
    submitted: { type: 'boolean', description: 'type only: whether Enter was pressed.' },
    key: { type: 'string', description: 'press only: the key code dispatched.' },
    scrollX: { type: 'integer' },
    scrollY: { type: 'integer' },
    scrollHeight: { type: 'integer' },
    viewportHeight: { type: 'integer' },
    matched: { type: 'boolean', description: 'wait only: whether the condition became true.' },
    waitedMs: { type: 'integer', description: 'wait only: elapsed milliseconds.' },
    selector: { type: 'string', description: 'wait only: the selector waited for.' },
    contains: { type: 'string', description: 'wait only: the text waited for.' },
    result: { type: 'string', description: 'eval only: JSON text of the script result.' },
    note: { type: 'string', description: 'Extra context; present when the operation ran while another conversation was on screen.' },
    width: { type: 'integer', description: 'screenshot only: image width.' },
    height: { type: 'integer', description: 'screenshot only: image height.' },
    image: {
      type: 'object',
      description: 'screenshot only: durable image attachment reference.',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
    },
  },
  required: ['action'],
}

// ---------------------------------------------------------------------------
// Tool descriptions and rendering
// ---------------------------------------------------------------------------

/** Model-facing description of `sidebar_browser`. */
const BROWSER_DESCRIPTION =
  'Manage the native browser tabs of the DSH right sidebar for the calling conversation. '
  + '"open" shows an HTTP(S) page in a new sidebar browser tab; "list" returns open tabs with tab ids, URLs and titles; '
  + '"navigate", "reload", "focus" and "close" act on one tab; "status" reports the page carrier and bridge health. '
  + 'The Harness Web page must be open. "navigate" and "reload" drive the native guest and also work while another conversation is on screen; '
  + '"open", "focus" and "close" change the visible sidebar layout and need the calling conversation to be the one on screen. '
  + 'Use sidebar_page to read or interact with the loaded page, and web_fetch for page text without a tab.'

/** Model-facing description of `sidebar_page`. */
const PAGE_DESCRIPTION =
  'Read and operate the page loaded in a native DSH sidebar browser tab, on the real Chromium guest: '
  + '"read" returns visible text, the list of interactive elements, or markup; '
  + '"click" clicks an element by CSS selector, by visible text, or by viewport coordinates using native input; '
  + '"type" writes into a field and optionally submits; "press" sends a native key; "scroll" moves the page or an element into view; '
  + '"wait" polls for a selector or text; "eval" runs JavaScript in the page and returns its JSON result; '
  + '"screenshot" captures the visible page and returns the image. '
  + 'Works in the DSH Desktop app (native Electron browser). In a Web build the sidebar browser is a sandboxed cross-origin iframe, so page actions fail and only tab management plus web_fetch work. '
  + 'A browser tab must be open in the calling conversation (sidebar_browser action "open" or "list"); page actions also work while another conversation is on screen, on the calling conversation\'s hidden sidebar tab. '
  + 'Call "read" with mode "interactive" before clicking when you do not know the page structure.'

/**
 * Human-readable projection of one `sidebar_browser` value.
 * @param _args - model arguments (unused).
 * @param value - canonical tool value.
 * @returns model-facing content blocks.
 */
function renderBrowser(_args, value) {
  const result = value ?? {}
  if (result.action === 'status') {
    const head = result.pageConnected === true
      ? 'Sidebar browser bridge: connected.'
      : 'Sidebar browser bridge: not connected.'
    return [{ type: 'text', text: result.note === undefined ? head : `${head} ${result.note}` }]
  }
  if (result.action === 'list') {
    const tabs = Array.isArray(result.tabs) ? result.tabs : []
    if (tabs.length === 0) return [{ type: 'text', text: 'No native sidebar browser tabs are open for this conversation.' }]
    const lines = tabs.map((tab) => {
      const bits = [`- ${tab.tabId}${tab.active === true ? ' (active)' : ''}`]
      if (tab.title !== undefined) bits.push(`"${tab.title}"`)
      if (tab.url !== undefined) bits.push(tab.url)
      return bits.join(' ')
    })
    return [{ type: 'text', text: `Native sidebar browser tabs (${tabs.length}):\n${lines.join('\n')}` }]
  }
  const parts = [`sidebar_browser ${String(result.action)} completed.`]
  if (result.tabId !== undefined) parts.push(`tab: ${result.tabId}`)
  if (result.url !== undefined) parts.push(`url: ${result.url}`)
  if (result.note !== undefined) parts.push(String(result.note))
  return [{ type: 'text', text: parts.join(' ') }]
}

/**
 * Format the interactive-element list of a read result.
 * @param elements - element summaries.
 * @returns one text block.
 */
function renderElements(elements) {
  const lines = elements.map((element) => {
    const bits = [`[${element.index}] <${element.tag}${element.type === undefined ? '' : ` type=${element.type}`}>`]
    if (element.label !== undefined) bits.push(`"${element.label}"`)
    if (element.selector !== undefined) bits.push(`selector=${element.selector}`)
    bits.push(`@(${element.x},${element.y})`)
    if (element.href !== undefined) bits.push(element.href)
    if (element.disabled === true) bits.push('[disabled]')
    return bits.join(' ')
  })
  return [{ type: 'text', text: `Interactive elements (${elements.length}):\n${lines.join('\n')}` }]
}

/**
 * Human-readable projection of one `sidebar_page` value, without its note.
 * @param result - canonical tool value.
 * @returns model-facing content blocks.
 */
function renderPageBody(result) {
  const where = [result.url === undefined ? '' : String(result.url), result.title === undefined ? '' : `"${String(result.title)}"`]
    .filter((part) => part !== '')
    .join(' ')
  const header = where === '' ? '' : `${where}\n`

  if (result.action === 'read') {
    if (result.mode === 'interactive') {
      const elements = Array.isArray(result.elements) ? result.elements : []
      const info = `Page ${header}viewport ${result.viewport?.width ?? '?'}x${result.viewport?.height ?? '?'}, scrollY ${result.scroll?.y ?? '?'}/${result.scroll?.height ?? '?'}.\n`
      return [{ type: 'text', text: info + renderElements(elements)[0].text }]
    }
    if (result.mode === 'html') {
      const suffix = result.truncated === true ? `\n… truncated (${result.totalChars ?? '?'} chars total)` : ''
      return [{ type: 'text', text: `${header}${String(result.html ?? '')}${suffix}` }]
    }
    const suffix = result.truncated === true ? `\n… truncated (${result.totalChars ?? '?'} chars total)` : ''
    return [{ type: 'text', text: `${header}${String(result.text ?? '')}${suffix}` }]
  }

  if (result.action === 'screenshot') {
    const image = result.image ?? {}
    const attachment = {
      attachmentId: String(image.attachmentId ?? ''),
      mediaType: String(image.mediaType ?? 'image/png'),
      bytes: Number(image.bytes ?? 0),
      width: Number(image.width ?? result.width ?? 0),
      height: Number(image.height ?? result.height ?? 0),
    }
    if (typeof image.name === 'string' && image.name !== '') attachment.name = image.name
    return [
      { type: 'text', text: `Sidebar browser screenshot of ${header || 'the page'} (${attachment.width}x${attachment.height} px).` },
      { type: 'image', attachment },
    ]
  }

  if (result.action === 'click') {
    const target = result.target ?? {}
    const label = target.label === undefined ? '' : ` "${target.label}"`
    return [{ type: 'text', text: `Clicked <${target.tag ?? 'element'}>${label} at (${target.x ?? '?'},${target.y ?? '?'}) in ${header || 'the page'}` }]
  }

  if (result.action === 'type') {
    const target = result.target ?? {}
    return [{
      type: 'text',
      text: `Typed ${result.typed ?? 0} characters into <${target.tag ?? 'field'}>${result.submitted === true ? ' and pressed Enter' : ''} in ${header || 'the page'}`,
    }]
  }

  if (result.action === 'press') {
    return [{ type: 'text', text: `Pressed ${result.key ?? 'key'} in ${header || 'the page'}` }]
  }

  if (result.action === 'scroll') {
    return [{
      type: 'text',
      text: `Scrolled ${header || 'the page'} to y=${result.scrollY ?? '?'} of ${result.scrollHeight ?? '?'} (viewport ${result.viewportHeight ?? '?'} px).`,
    }]
  }

  if (result.action === 'wait') {
    return [{
      type: 'text',
      text: result.matched === true
        ? `Condition met after ${result.waitedMs ?? 0} ms in ${header || 'the page'}.`
        : `Condition not met after ${result.waitedMs ?? 0} ms in ${header || 'the page'}.`,
    }]
  }

  if (result.action === 'eval') {
    const suffix = result.truncated === true ? '\n… result truncated' : ''
    return [{ type: 'text', text: `JavaScript result for ${header || 'the page'}:\n${String(result.result ?? 'undefined')}${suffix}` }]
  }

  return [{ type: 'text', text: `sidebar_page ${String(result.action)} completed.` }]
}

/**
 * Project one `sidebar_page` value and append its optional note.
 * @param _args - model arguments (unused).
 * @param value - canonical tool value.
 * @returns model-facing content blocks.
 */
function renderPage(_args, value) {
  const result = value ?? {}
  const blocks = renderPageBody(result)
  if (typeof result.note === 'string' && result.note !== '') blocks.push({ type: 'text', text: result.note })
  return blocks
}

// ---------------------------------------------------------------------------
// Tool execution helpers
// ---------------------------------------------------------------------------

/**
 * Extract the calling session id or throw the canonical error.
 * @param exec - tool execution context.
 * @returns the session id.
 */
function sessionIdOf(exec) {
  const raw = exec.agent?.session?.id
  if (typeof raw !== 'string' || raw === '') throw new Error('this tool requires an initiating agent session')
  return raw
}

/**
 * Throw the page half's failure as a tool error.
 * @param result - bridge result.
 * @param fallback - message used when the page half gave no reason.
 * @returns never.
 */
function throwPageFailure(result, fallback) {
  throw new Error(result.error ?? fallback)
}

/**
 * Register the `sidebar_browser` tool.
 * @param ctx - host plugin context.
 * @param bridge - running bridge.
 * @returns a disposer unregistering the tool.
 */
function registerBrowserTool(ctx, bridge, config) {
  return ctx.tools.register({
    name: 'sidebar_browser',
    description: BROWSER_DESCRIPTION,
    parameters: BROWSER_PARAMETERS,
    timeoutMs: 60_000,
    output: { schema: BROWSER_OUTPUT, render: renderBrowser },
    async execute(rawArgs, exec) {
      exec.signal?.throwIfAborted?.()
      if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new Error('sidebar_browser requires an object of arguments')
      const action = rawArgs.action
      if (typeof action !== 'string' || !TAB_ACTIONS.includes(action)) throw new Error(`sidebar_browser action must be one of: ${TAB_ACTIONS.join(', ')}`)
      const sessionId = typeof exec.agent?.session?.id === 'string' ? exec.agent.session.id : ''

      if (action === 'status') {
        const command = { action, sessionId }
        if (!bridge.connected && Date.now() - bridge.lastPollAt > CLIENT_STALE_MS) {
          return {
            action: 'status',
            ...(sessionId === '' ? {} : { sessionId }),
            pageConnected: false,
            note: joinNotes([bridge.noClientMessage(), hostFacts(ctx, config)]),
          }
        }
        await bridge.ensureClient(exec.signal)
        const result = await bridge.dispatch(command, exec.signal)
        if (result.ok !== true) throwPageFailure(result, 'the page half did not answer')
        const value = result.value ?? {}
        const clientMatch = typeof value.note === 'string' ? /"plugin":"([^"]+)"/.exec(value.note) : null
        const clientVersion = clientMatch === null ? undefined : clientMatch[1]
        const versionNotice = clientVersion !== undefined && clientVersion !== PLUGIN_VERSION
          ? `warning: the page half is v${clientVersion} but the running Host half is v${PLUGIN_VERSION}; restart the Harness to load the installed Host code.`
          : ''
        return { ...value, note: joinNotes([typeof value.note === 'string' ? value.note : '', hostFacts(ctx, config), versionNotice]) }
      }

      if (sessionId === '') throw new Error('sidebar_browser requires an initiating agent session')
      const command = { action, sessionId }
      if (URL_ACTIONS.has(action)) {
        command.url = normalizeHttpUrl(rawArgs.url, action)
        assertHostAllowed(command.url, liveConfig(config))
      }
      if (TAB_ID_ACTIONS.has(action)) {
        const tabId = requireString(rawArgs.tabId, 'tabId')
        if (tabId !== undefined) command.tabId = tabId
      }

      await bridge.ensureClient(exec.signal)
      const result = await bridge.dispatch(command, exec.signal)
      if (result.ok !== true) throwPageFailure(result, 'the sidebar browser did not complete the command')
      return result.value
    },
  }, { when: () => liveConfig(config).enabled })
}

/**
 * Register the `sidebar_page` tool.
 * @param ctx - host plugin context.
 * @param bridge - running bridge.
 * @returns a disposer unregistering the tool.
 */
function registerPageTool(ctx, bridge, config) {
  return ctx.tools.register({
    name: 'sidebar_page',
    description: PAGE_DESCRIPTION,
    parameters: PAGE_PARAMETERS,
    timeoutMs: 90_000,
    output: { schema: PAGE_OUTPUT, render: renderPage },
    async execute(rawArgs, exec) {
      exec.signal?.throwIfAborted?.()
      if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) throw new Error('sidebar_page requires an object of arguments')
      const action = rawArgs.action
      if (typeof action !== 'string' || !PAGE_ACTIONS.includes(action)) throw new Error(`sidebar_page action must be one of: ${PAGE_ACTIONS.join(', ')}`)
      const current = liveConfig(config)
      if (action === 'eval' && current.allowEval !== true) throw new Error('sidebar_page action "eval" is disabled by the plugin configuration')
      if ((action === 'click' || action === 'type' || action === 'press') && current.allowNativeInput !== true) {
        throw new Error('sidebar_page click/type/press actions are disabled by the plugin configuration')
      }
      const sessionId = sessionIdOf(exec)
      const tabId = requireString(rawArgs.tabId, 'tabId', true)
      const selector = requireString(rawArgs.selector, 'selector', true)
      const contains = requireString(rawArgs.contains, 'contains', true)
      const command = {
        action,
        sessionId,
        ...(tabId === undefined ? {} : { tabId }),
      }

      if (action === 'read') {
        const mode = rawArgs.mode === undefined ? 'text' : rawArgs.mode
        if (typeof mode !== 'string' || !READ_MODES.includes(mode)) throw new Error(`read mode must be one of: ${READ_MODES.join(', ')}`)
        command.mode = mode
        if (selector !== undefined) command.selector = selector
        if (mode === 'text' || mode === 'html') {
          command.maxChars = boundedNumber(rawArgs.maxChars, 'maxChars', 100, mode === 'html' ? 120_000 : 60_000, mode === 'html' ? 30_000 : 12_000)
        } else {
          command.maxElements = boundedNumber(rawArgs.maxElements, 'maxElements', 1, 500, 200)
        }
      } else if (action === 'click') {
        const hasPoint = typeof rawArgs.x === 'number' && typeof rawArgs.y === 'number'
        if (selector === undefined && contains === undefined && !hasPoint) throw new Error('click needs "selector", "contains", or numeric "x" and "y"')
        if (selector !== undefined) command.selector = selector
        if (contains !== undefined) command.contains = contains
        if (hasPoint) {
          command.x = boundedNumber(rawArgs.x, 'x', 0, 10_000, 0)
          command.y = boundedNumber(rawArgs.y, 'y', 0, 10_000, 0)
        }
      } else if (action === 'type') {
        if (rawArgs.text === undefined || typeof rawArgs.text !== 'string') throw new Error('type requires "text"')
        command.text = rawArgs.text
        if (selector !== undefined) command.selector = selector
        command.clear = rawArgs.clear !== false
        command.submit = rawArgs.submit === true
      } else if (action === 'press') {
        const key = requireString(rawArgs.key, 'key')
        if (key !== undefined) command.key = key
      } else if (action === 'scroll') {
        if (selector === undefined && typeof rawArgs.dy !== 'number' && typeof rawArgs.dx !== 'number') {
          throw new Error('scroll needs "selector", "dy", or "dx"')
        }
        if (selector !== undefined) command.selector = selector
        if (typeof rawArgs.dy === 'number') command.dy = boundedNumber(rawArgs.dy, 'dy', -100_000, 100_000, 0)
        if (typeof rawArgs.dx === 'number') command.dx = boundedNumber(rawArgs.dx, 'dx', -100_000, 100_000, 0)
      } else if (action === 'eval') {
        const code = requireString(rawArgs.code, 'code')
        if (code === undefined || code.length > 200_000) throw new Error('eval "code" must be 1..200000 characters')
        command.code = code
      } else if (action === 'wait') {
        if (selector === undefined && contains === undefined) throw new Error('wait needs "selector" or "contains"')
        if (selector !== undefined) command.selector = selector
        if (contains !== undefined) command.contains = contains
        command.timeoutMs = boundedNumber(rawArgs.timeoutMs, 'timeoutMs', 100, 15_000, 5_000)
      }

      await bridge.ensureClient(exec.signal)
      const result = await bridge.dispatch(command, exec.signal)
      if (result.ok !== true) throwPageFailure(result, 'the sidebar page action failed')

      if (action !== 'screenshot') return result.value

      const value = result.value ?? {}
      const base64 = typeof value.base64 === 'string' ? value.base64 : ''
      if (base64 === '') throw new Error('the page half returned no screenshot payload')
      if (base64.length > MAX_SCREENSHOT_BASE64) throw new Error('the screenshot is too large to store; zoom or scroll and retry')
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('screenshots require the attachment service, which is not mounted in this profile')
      let ref
      try {
        ref = await attachments.saveImage({
          data: Buffer.from(base64, 'base64'),
          mediaType: 'image/png',
          name: `sidebar-browser-${value.tabId ?? 'tab'}.png`,
        })
      } catch (error) {
        throw new Error(`could not store the sidebar screenshot: ${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        action: 'screenshot',
        sessionId: value.sessionId ?? sessionId,
        ...(value.tabId === undefined ? {} : { tabId: value.tabId }),
        ...(value.url === undefined ? {} : { url: value.url }),
        ...(value.title === undefined ? {} : { title: value.title }),
        width: ref.width,
        height: ref.height,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
    },
  }, { when: () => liveConfig(config).enabled })
}

/**
 * Plugin body: mount the bridge routes, the configured tools, and teardown.
 * @param ctx - host plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const bridge = new Bridge(ctx)
  ctx.effect(() => bridge.registerRoutes(), 'sidebar-browser-agent: bridge routes')
  ctx.effect(() => registerBrowserTool(ctx, bridge, config), 'sidebar-browser-agent: browser tool')
  ctx.effect(() => registerPageTool(ctx, bridge, config), 'sidebar-browser-agent: page tool')
  ctx.effect(() => () => bridge.dispose(), 'sidebar-browser-agent: bridge lifetime')
  selfCheck(ctx, config)
}
