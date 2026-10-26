/**
 * DeepSeek Harness uTools Plugin — preload.js
 *
 * Node.js bridge layer: manages the DSH server process, reads/writes
 * configuration files, provides an HTTP API client, and handles
 * environment detection. All APIs are exposed on window.dsh.
 *
 * This file follows CommonJS (uTools preload requirement).
 * Code must remain readable — no bundling/minification.
 */

const { spawn, execSync, exec } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const net = require('node:net')
const zlib = require('node:zlib')

// ============================================================
//  Constants
// ============================================================

const DEFAULT_PORT = 3080
const DEFAULT_PROFILE = 'web'
const HEALTH_CHECK_TIMEOUT = 3000
const SERVER_READY_TIMEOUT = 180000 // 3 minutes (first npx install can take a while)
const HEALTH_CHECK_INTERVAL = 1000

// ============================================================
//  State
// ============================================================

let dshProcess = null
let serverStatus = {
  running: false,
  port: DEFAULT_PORT,
  pid: null,
  startTime: null,
  workspace: null,
  profile: DEFAULT_PROFILE,
}

let stdoutBuffer = []
let stderrBuffer = []

// Link-bridge proxy state (see startBridge / stopBridge below)
let bridgeServer = null
let bridgeTargetPort = null
let bridgeListenPort = null

// Bridge-side session cookie jar (name → value).
//
// WHY: DSH ≥0.2.0's trust-fence session cookie is `SameSite=Strict`. The
// Web UI lives in an embedded iframe whose top-level frame is the uTools
// plugin page, so the browser computes site-for-cookies from the TOP level
// and will NOT attach the Strict cookie to the iframe's requests — the
// iframe loads the token URL (303 + Set-Cookie) yet the follow-up `/`
// request arrives cookie-less and renders the 401 text page.
// The bridge therefore holds the session SERVER-SIDE: it acquires it once
// from the token URL and attaches it to every forwarded request. Browser
// cookie policies become irrelevant.
let bridgeCookieJar = new Map()

/**
 * Parse Set-Cookie header(s) from a DSH response into the jar.
 * Keeps only the name=value pair (attributes are irrelevant server-side).
 * @param {object} headers - Response headers (may contain set-cookie)
 */
function bridgeUpdateJarFromResponse(headers) {
  const setCookies = headers['set-cookie']
  if (!setCookies) return
  const list = Array.isArray(setCookies) ? setCookies : [setCookies]
  let updated = false
  for (const raw of list) {
    const m = String(raw).match(/^([^=;]+)=([^;]*)/)
    if (!m) continue
    const name = m[1].trim()
    const value = m[2].trim()
    if (!name) continue
    // Empty value = deletion
    if (!value) bridgeCookieJar.delete(name)
    else bridgeCookieJar.set(name, value)
    updated = true
  }
  if (updated) console.log(`[dsh] bridge session jar updated (${bridgeCookieJar.size} cookie(s))`)
}

/**
 * Merge the bridge jar into an incoming Cookie header for forwarding.
 * Jar entries win on name conflicts (they hold the authenticated session).
 * @param {string|undefined} incomingCookie - Cookie header from the browser
 * @returns {string|undefined} Merged Cookie header value
 */
function bridgeMergeCookie(incomingCookie) {
  if (bridgeCookieJar.size === 0) return incomingCookie
  const jarPairs = [...bridgeCookieJar.entries()].map(([k, v]) => `${k}=${v}`)
  if (!incomingCookie) return jarPairs.join('; ')
  // Incoming cookies first, jar overrides by name
  const byName = new Map()
  for (const part of String(incomingCookie).split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0) byName.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
  }
  for (const [k, v] of bridgeCookieJar) byName.set(k, v)
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * Acquire the DSH trust-fence session cookie SERVER-SIDE.
 * Performs the token-URL flow directly (bridge → DSH, no browser involved)
 * and stores the resulting session cookie in the jar, so every request the
 * bridge forwards afterwards is authenticated — regardless of the browser's
 * SameSite / third-party-cookie behavior in the embedded iframe.
 * @returns {Promise<boolean>} true when the jar now holds a session cookie
 */
async function bridgeAcquireSession() {
  if (!dshWebUrl || !bridgeTargetPort) return false
  const m = dshWebUrl.match(/[?&]token=([^&]+)/)
  if (!m) return false // no-token build (DSH <0.2.0): nothing to acquire
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: bridgeTargetPort,
      path: `/?token=${encodeURIComponent(m[1])}`,
      headers: { Accept: 'text/html' },
      timeout: 8000,
    }, (res) => {
      bridgeUpdateJarFromResponse(res.headers)
      res.resume()
      res.on('end', () => resolve(bridgeCookieJar.size > 0))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// ============================================================
//  Utilities
// ============================================================

/**
 * Plugin sandbox root — the DSH server and ALL its resources live under
 * this directory (DSH_HOME, private npm cache, private runtime install),
 * fully isolated from ~/.dsh (used by VS Code panel / CLI / other shells)
 * and from the shared ~/.npm caches. Uses the uTools plugin-private local
 * data path (official API, see api-reference/system.md) when available.
 * @returns {string}
 */
function getSandboxRoot() {
  if (typeof utools !== 'undefined' && utools.getPluginLocalDataPath) {
    try {
      return path.join(utools.getPluginLocalDataPath(), 'dsh-sandbox')
    } catch { /* fallthrough */ }
  }
  // Dev fallback (outside uTools): a dedicated directory, never ~/.dsh
  return path.join(os.homedir(), '.dsh-utools-sandbox')
}

/**
 * Get the DSH home directory — the SANDBOXED home.
 * Every process we spawn gets DSH_HOME=<sandbox>/home so profiles,
 * plugins, sessions and settings never touch ~/.dsh or other shells.
 * ($DSH_HOME env is honored ONLY in dev runs without utools, where the
 * test harness sets it explicitly.)
 * @returns {string}
 */
function getDshHome() {
  return path.join(getSandboxRoot(), 'home')
}

/**
 * Private npm cache — npx/npm downloads stay inside the sandbox and
 * never read or write the shared ~/.npm caches of other tools.
 * @returns {string}
 */
function getSandboxNpmCache() {
  return path.join(getSandboxRoot(), 'npm-cache')
}

/**
 * Private runtime install dir — `npm install --prefix` target for the
 * plugin-managed DSH copy (instead of a shared global install).
 * @returns {string}
 */
function getSandboxRuntimeDir() {
  return path.join(getSandboxRoot(), 'runtime')
}

/**
 * Ensure the sandbox skeleton exists.
 */
function ensureSandboxDirs() {
  for (const dir of [getDshHome(), getSandboxNpmCache(), getSandboxRuntimeDir()]) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  }
}

/**
 * Get a polyfill path that the spawned plain-Node process can actually load.
 *
 * WHY: published uTools plugins run from inside a .asar archive. Electron's
 * patched fs "sees" files inside the asar (fs.existsSync is true), so the
 * naive path.join(__dirname, 'polyfills', ...) check passes — but the
 * spawned DSH server is a PLAIN Node binary (bundled runtime) with NO asar
 * support: NODE_OPTIONS=--require=<…>.asar/polyfills/… fails with
 * "Cannot find module" and kills the process before it can listen. Dev
 * plugins run from a real directory, where the direct path works.
 * Fix: when the polyfill lives inside an asar, materialize it (read via the
 * patched fs, write to the real sandbox directory) and hand back that path.
 * @returns {string|null} a loadable polyfill path, or null when unavailable
 */
function getPolyfillPath() {
  const src = path.join(__dirname, 'polyfills', 'abort-signal-any.js')
  try {
    if (!fs.existsSync(src)) return null
    // Real directory (dev plugin): use the file in place
    if (!src.includes('.asar' + path.sep) && !src.endsWith('.asar')) return src
    // Inside asar (published plugin): copy it onto the real filesystem
    const destDir = path.join(getSandboxRoot(), 'polyfills')
    const dest = path.join(destDir, 'abort-signal-any.js')
    try {
      fs.mkdirSync(destDir, { recursive: true })
      const content = fs.readFileSync(src, 'utf8')
      let needWrite = true
      try { needWrite = !fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== content } catch { needWrite = true }
      if (needWrite) fs.writeFileSync(dest, content, 'utf8')
      return dest
    } catch (copyErr) {
      console.warn('[dsh] failed to materialize asar polyfill:', copyErr.message)
      return null
    }
  } catch {
    return null
  }
}

/**
 * Check whether anything is listening on a TCP port (raw connect probe).
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isTcpPortOccupied(port) {
  return new Promise((resolve) => {
    const netMod = require('net')
    const sock = netMod.connect({ port, host: '127.0.0.1', timeout: 600 })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
    sock.on('timeout', () => { sock.destroy(); resolve(false) })
  })
}

/**
 * Find the first free TCP port, starting from `startPort` (inclusive),
 * scanning at most 20 candidates. Falls back to a random OS-assigned
 * port when all candidates are busy.
 * @param {number} startPort
 * @returns {Promise<number>}
 */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const netMod = require('net')
    const tryPort = (port, remaining) => {
      const srv = netMod.createServer()
      srv.once('error', () => {
        if (remaining > 0) tryPort(port + 1, remaining - 1)
        else {
          // All candidates busy — ask the OS for any free port
          const tmp = netMod.createServer()
          tmp.listen(0, '127.0.0.1', () => {
            const p = tmp.address().port
            tmp.close(() => resolve(p))
          })
        }
      })
      srv.listen(port, '127.0.0.1', () => {
        const p = srv.address().port
        srv.close(() => resolve(p))
      })
    }
    tryPort(startPort, 20)
  })
}

/**
 * Kill OUR OWN orphaned DSH processes listening on a port.
 *
 * A previous plugin session may have died without stopping its DSH child
 * (e.g. uTools was force-quit) — the child is re-parented to init/launchd
 * and keeps the configured port forever, which then breaks the next start
 * with EADDRINUSE. Only processes whose command line matches BOTH
 *   (a) an @deepseek-ai/dsh entry, and
 *   (b) OUR sandbox root path (this plugin instance's dsh-sandbox)
 * are killed — DSH servers started by the user's terminal, VS Code panel,
 * other shells, or the plugin's OTHER instances (dev vs store) are never
 * touched.
 * Best-effort: darwin/linux only (lsof); silently no-ops elsewhere.
 * @param {number} port
 * @returns {number} number of processes killed
 */
function killOrphanDshProcesses(port) {
  if (process.platform === 'win32') return 0
  let killed = 0
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp 2>/dev/null`, {
      encoding: 'utf8', timeout: 5000,
    })
    const pids = out.split('\n').map((l) => l.trim()).filter((l) => /^p\d+$/.test(l)).map((l) => parseInt(l.slice(1), 10))
    for (const pid of pids) {
      let cmdline = ''
      try {
        cmdline = execSync(`ps -p ${pid} -o command= 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim()
      } catch { continue }
      const isDsh = cmdline.includes('@deepseek-ai/dsh')
      // Own-sandbox ONLY. Matching any 'uTools' path here made the dev
      // instance and the store instance kill EACH OTHER's servers (both run
      // under "Application Support/uTools"), surfacing as random "DSH 已崩溃"
      // notifications whenever the other instance started. Our spawned DSH
      // always runs from <sandboxRoot>/..., so requiring the sandbox root
      // identifies exactly this instance's own orphans.
      const isOurs = cmdline.includes(getSandboxRoot())
      if (isDsh && isOurs) {
        try {
          process.kill(pid, 'SIGTERM')
          killed++
          console.log(`[dsh] killed own orphaned DSH process (pid=${pid}) on port ${port}`)
        } catch { /* already gone */ }
      }
    }
  } catch { /* lsof failed / nothing listening */ }
  return killed
}

/**
 * Get the plugin's runtime data directory.
 * Node.js is downloaded on first launch to uTools userData/runtime.
 * @returns {string}
 */
function getRuntimeDir() {
  // Downloaded Node.js in uTools userData
  if (typeof utools !== 'undefined' && utools.getPath) {
    try {
      return path.join(utools.getPath('userData'), 'runtime')
    } catch { /* fallthrough */ }
  }
  // Dev fallback — inside the sandbox, never ~/.dsh
  return path.join(getSandboxRoot(), 'node-runtime')
}

/**
 * Get the path to the bundled Node.js executable.
 * @returns {string|null}
 */
function getBundledNodePath() {
  const nodeDir = path.join(getRuntimeDir(), 'node')
  const nodeBin = process.platform === 'win32' ? 'node.exe' : 'bin/node'
  const nodePath = path.join(nodeDir, nodeBin)
  return fs.existsSync(nodePath) ? nodePath : null
}

/**
 * Get the paths to the bundled node/npx/npm.
 * @returns {{ node: string|null, npx: string|null, npm: string|null }}
 */
function getBundledPaths() {
  const nodeDir = path.join(getRuntimeDir(), 'node')
  const isWin = process.platform === 'win32'
  const nodeBin = isWin ? 'node.exe' : 'bin/node'
  const npxBin = isWin ? 'npx.cmd' : 'bin/npx'
  const npmBin = isWin ? 'npm.cmd' : 'bin/npm'
  const nodePath = path.join(nodeDir, nodeBin)
  const npxPath = path.join(nodeDir, npxBin)
  const npmPath = path.join(nodeDir, npmBin)
  return {
    node: fs.existsSync(nodePath) ? nodePath : null,
    npx: fs.existsSync(npxPath) ? npxPath : null,
    npm: fs.existsSync(npmPath) ? npmPath : null,
  }
}

/**
 * Collect candidate Node.js binary paths from common install locations.
 *
 * macOS GUI apps (uTools) inherit PATH from /etc/paths — which does NOT
 * include nvm (~/.nvm/versions/node/...), ~/.local/bin, or Homebrew on
 * Apple Silicon.  We probe these locations directly so the plugin works
 * even when `node` is not on the GUI-inherited PATH.
 *
 * @returns {string[]}
 */
function discoverNodePaths() {
  const candidates = []
  const home = os.homedir()
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'

  if (isWin) {
    candidates.push(
      path.join(home, 'AppData', 'Roaming', 'nvm', 'node.exe'),
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
    )
  } else {
    // Homebrew
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node')
    // nvm: scan all installed versions, pick latest
    const nvmDir = path.join(home, '.nvm', 'versions', 'node')
    try {
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir).sort().reverse()
        for (const v of versions) {
          candidates.push(path.join(nvmDir, v, 'bin', 'node'))
        }
      }
    } catch { /* ignore */ }
    // fnm, volta, asdf, n
    candidates.push(
      path.join(home, '.local', 'bin', 'node'),         // common manual symlink
      path.join(home, '.fnm', 'current', 'bin', 'node'),
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.asdf', 'shims', 'node'),
      '/usr/local/n/versions/node/current/bin/node',
    )
  }

  // Deduplicate + filter to files that exist
  return [...new Set(candidates)].filter((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile() } catch { return false }
  })
}

/**
 * Resolve the best available Node.js: bundled first, then PATH, then discovered.
 * @returns {{ path: string|null, version: string|null, source: 'bundled'|'system'|null }}
 */
function resolveNode() {
  // 1. Bundled runtime
  const bundled = getBundledNodePath()
  if (bundled) {
    try {
      const out = execSync(`"${bundled}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
      const ver = out.trim()
      if (versionGte(ver, '24.0.0')) {
        return { path: bundled, version: ver, source: 'bundled' }
      }
    } catch { /* broken, fall through */ }
  }

  // 2. System PATH (works when launched from a shell-aware environment)
  try {
    const out = execSync('node --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
    const ver = out.trim()
    if (versionGte(ver, '24.0.0')) {
      const which = process.platform === 'win32' ? 'where' : 'which'
      const resolved = execSync(`${which} node`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0].trim()
      return { path: resolved, version: ver, source: 'system' }
    }
  } catch { /* not on PATH, try discovered locations */ }

  // 3. Discovered locations (macOS GUI apps don't inherit nvm/homebrew PATH)
  for (const candidate of discoverNodePaths()) {
    try {
      const out = execSync(`"${candidate}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
      const ver = out.trim()
      if (versionGte(ver, '24.0.0')) {
        return { path: candidate, version: ver, source: 'system' }
      }
    } catch { /* try next */ }
  }

  return { path: null, version: null, source: null }
}

/**
 * Resolve the best available npx invocation.
 * Returns either a direct command string (for shell:true spawn)
 * or an object { cmd, args } for shell:false spawn with bundled node.
 * @returns {{ cmd: string, args: string[], shell: boolean }|null}
 */
function resolveNpx() {
  const bundled = getBundledPaths()
  if (bundled.node) {
    // Use bundled node directly to run npx-cli.js (avoids .cmd shell issues)
    const nodeDir = path.dirname(bundled.node)
    const parentDir = path.dirname(nodeDir)
    const npxCliWin = path.join(parentDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (fs.existsSync(npxCliWin)) {
      return { cmd: bundled.node, preArgs: [npxCliWin], shell: false }
    }
    const npxCliUnix = path.join(parentDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (fs.existsSync(npxCliUnix)) {
      return { cmd: bundled.node, preArgs: [npxCliUnix], shell: false }
    }
    if (bundled.npx) {
      return { cmd: bundled.npx, preArgs: [], shell: true }
    }
  }

  // Try system npx via PATH
  if (hasCommand('npx') || hasCommand('npx.cmd')) {
    return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', preArgs: [], shell: true }
  }

  // Fallback: use discovered Node to run npx-cli.js directly
  // (macOS GUI apps don't have nvm/homebrew on PATH, but we can find npx-cli.js
  //  next to the discovered node binary)
  const nodeInfo = resolveNode()
  if (nodeInfo.path && nodeInfo.source === 'system') {
    const nodeBinDir = path.dirname(nodeInfo.path)
    // npx is typically in the same bin/ directory as node
    const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    const npxDirect = path.join(nodeBinDir, npxBin)
    if (fs.existsSync(npxDirect)) {
      return { cmd: npxDirect, preArgs: [], shell: true }
    }
    // Try npx-cli.js via the discovered node
    const parentDir = nodeBinDir.endsWith('bin') ? path.dirname(nodeBinDir) : nodeBinDir
    const npxCliWin = path.join(parentDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (fs.existsSync(npxCliWin)) {
      return { cmd: nodeInfo.path, preArgs: [npxCliWin], shell: false }
    }
    const npxCliUnix = path.join(parentDir, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (fs.existsSync(npxCliUnix)) {
      return { cmd: nodeInfo.path, preArgs: [npxCliUnix], shell: false }
    }
  }

  return null
}

/**
 * Resolve the best available npm: bundled first, then system.
 * @returns {string|null}
 */
function resolveNpm() {
  const bundled = getBundledPaths()
  if (bundled.npm && bundled.node) {
    return bundled.npm
  }
  if (hasCommand('npm') || hasCommand('npm.cmd')) {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm'
  }
  return null
}

/**
 * Resolve a directly-runnable DSH CLI entry, sandbox-first.
 * Resolution order (STRICT — never the shared ~/.npm caches or the user's
 * system-global installs, so the sandbox has zero association with
 * external resources):
 *   1. Plugin-managed runtime install: <sandbox>/runtime/node_modules/…
 *      (created by cli.install() via `npm install --prefix`)
 *   2. Plugin-private npx cache: <sandbox>/npm-cache/_npx/…
 *      (bootstrapped when start()/install() run npx with
 *      npm_config_cache=<sandbox>/npm-cache)
 *   3. uTools bundled runtime's global install — the runtime node shipped
 *      with uTools that this plugin manages; not a user-system resource.
 * Returns null when none exist — start() then spawns npx (private cache),
 * which downloads DSH into the sandbox on first run.
 * @returns {string|null}
 */
function resolveGlobalDshBin() {
  const nodeInfo = resolveNode()
  if (!nodeInfo.path) return null

  // 1. Plugin-managed runtime install (sandbox)
  try {
    const sandboxBin = path.join(getSandboxRuntimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(sandboxBin)) return sandboxBin
  } catch { /* ignore */ }

  // 2. Plugin-private npx cache (sandbox)
  try {
    const privateNpx = path.join(getSandboxNpmCache(), '_npx')
    if (fs.existsSync(privateNpx)) {
      for (const entry of fs.readdirSync(privateNpx)) {
        const bin = path.join(privateNpx, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (fs.existsSync(bin)) return bin
      }
    }
  } catch { /* ignore */ }

  // 3. uTools bundled runtime's global install (started-by-us environment)
  try {
    const bundled = getBundledPaths()
    if (bundled.node) {
      const runtimeDir = path.dirname(path.dirname(bundled.node)) // <runtime>/node
      const globalBin = process.platform === 'win32'
        ? path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        : path.join(runtimeDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (fs.existsSync(globalBin)) return globalBin
    }
  } catch { /* ignore */ }

  return null
}

/**
 * Download a file via HTTPS with progress callback.
 * @param {string} url
 * @param {string} destPath
 * @param {(received: number, total: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    let received = 0
    let total = 0

    const handle = (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close()
        try { fs.unlinkSync(destPath) } catch { /* ignore */ }
        downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject)
        return
      }
      if (response.statusCode !== 200) {
        file.close()
        try { fs.unlinkSync(destPath) } catch { /* ignore */ }
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      total = parseInt(response.headers['content-length'] || '0', 10)
      response.on('data', (chunk) => {
        received += chunk.length
        if (onProgress) onProgress(received, total)
      })
      response.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }

    const client = url.startsWith('https') ? https : http
    client.get(url, handle).on('error', (err) => {
      file.close()
      try { fs.unlinkSync(destPath) } catch { /* ignore */ }
      reject(err)
    })
  })
}

/**
 * Extract a zip/tar.gz using system tools (tar.exe, PowerShell, unzip).
 * @param {string} archivePath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    ensureDir(destDir)
    const isTarGz = archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')
    if (process.platform === 'win32') {
      // Windows 10+ ships tar.exe which handles zip and tar.gz
      exec(`tar -xf "${archivePath}" -C "${destDir}"`, { timeout: 180000 }, (err) => {
        if (err) {
          // Fallback: PowerShell Expand-Archive (zip only)
          if (!isTarGz) {
            exec(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, { timeout: 180000 }, (err2) => {
              if (err2) reject(new Error('Extraction failed: ' + (err2.message || 'unknown')))
              else resolve()
            })
          } else {
            reject(new Error('tar.exe failed and no fallback for tar.gz on Windows: ' + err.message))
          }
        } else {
          resolve()
        }
      })
    } else {
      // macOS/Linux
      if (isTarGz) {
        exec(`tar -xzf "${archivePath}" -C "${destDir}"`, { timeout: 180000 }, (err) => {
          if (err) reject(new Error('Extraction failed: ' + (err.message || 'unknown')))
          else resolve()
        })
      } else {
        exec(`unzip -o "${archivePath}" -d "${destDir}"`, { timeout: 180000 }, (err) => {
          if (err) {
            exec(`tar -xf "${archivePath}" -C "${destDir}"`, { timeout: 180000 }, (err2) => {
              if (err2) reject(new Error('Extraction failed: ' + (err2.message || 'unknown')))
              else resolve()
            })
          } else {
            resolve()
          }
        })
      }
    }
  })
}

/**
 * Download and set up a portable Node.js 22 runtime.
 * @param {{ onProgress?: (msg: string) => void }} callbacks
 * @returns {Promise<{ success: boolean, path: string, error?: string }>}
 */
async function downloadNodeRuntime(callbacks = {}) {
  const { onProgress = () => {} } = callbacks
  const runtimeDir = getRuntimeDir()
  const nodeDir = path.join(runtimeDir, 'node')
  const archiveDir = path.join(runtimeDir, 'archives')
  ensureDir(runtimeDir)
  ensureDir(archiveDir)

  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
  const version = 'v24.11.0'
  const filename = `node-${version}-${platform}-${arch}.${ext}`
  const archivePath = path.join(archiveDir, filename)

  // Check if already extracted
  const expectedBin = process.platform === 'win32' ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node')
  if (fs.existsSync(expectedBin)) {
    try {
      execSync(`"${expectedBin}" --version`, { stdio: 'ignore', timeout: 5000 })
      onProgress('Node.js 运行时已就绪')
      return { success: true, path: expectedBin }
    } catch { /* re-download */ }
  }

  // Mirror list — official first, China mirrors as fallback for domestic users
  const mirrors = [
    `https://nodejs.org/dist/${version}/${filename}`,
    `https://npmmirror.com/mirrors/node/${version}/${filename}`,
    `https://registry.npmmirror.com/-/binary/node/${version}/${filename}`,
    `https://cdn.npmmirror.com/binaries/node/${version}/${filename}`,
  ]

  // Download with mirror fallback
  let downloadOk = false
  let lastError = null
  for (let i = 0; i < mirrors.length; i++) {
    const url = mirrors[i]
    onProgress(`正在下载 Node.js ${version} (${platform}-${arch}) [镜像 ${i + 1}/${mirrors.length}]...`)
    try {
      await downloadFile(url, archivePath, (recv, tot) => {
        if (tot > 0) onProgress(`下载中... ${Math.round((recv / tot) * 100)}%`)
      })
      downloadOk = true
      break
    } catch (err) {
      lastError = err
      // Clean up partial download
      try { fs.unlinkSync(archivePath) } catch { /* ignore */ }
      onProgress(`镜像 ${i + 1} 失败，尝试下一个...`)
    }
  }

  if (!downloadOk) {
    return { success: false, path: '', error: `所有下载镜像均失败: ${lastError?.message || '未知错误'}。\n请检查网络连接，或手动从 https://nodejs.org 下载。` }
  }

  // Extract
  onProgress('正在解压...')
  try { fs.rmSync(nodeDir, { recursive: true, force: true }) } catch { /* ignore */ }
  ensureDir(nodeDir)
  try {
    await extractArchive(archivePath, nodeDir)
  } catch (err) {
    return { success: false, path: '', error: `解压失败: ${err.message}` }
  }

  // The archive extracts to a subfolder — flatten it
  const entries = fs.readdirSync(nodeDir)
  if (entries.length === 1) {
    const subDir = path.join(nodeDir, entries[0])
    if (fs.statSync(subDir).isDirectory()) {
      // Try rename first (fast, same-filesystem); fall back to copy (cross-device)
      try {
        for (const item of fs.readdirSync(subDir)) {
          fs.renameSync(path.join(subDir, item), path.join(nodeDir, item))
        }
        fs.rmdirSync(subDir)
      } catch {
        // Cross-device: use recursive copy + delete
        for (const item of fs.readdirSync(subDir)) {
          fs.cpSync(path.join(subDir, item), path.join(nodeDir, item), { recursive: true })
        }
        fs.rmSync(subDir, { recursive: true, force: true })
      }
    }
  }

  // Verify
  const nodeBin = process.platform === 'win32' ? path.join(nodeDir, 'node.exe') : path.join(nodeDir, 'bin', 'node')
  if (!fs.existsSync(nodeBin)) {
    return { success: false, path: '', error: '解压后未找到 node 可执行文件' }
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(nodeBin, 0o755) } catch { /* ignore */ }
  }
  try {
    execSync(`"${nodeBin}" --version`, { stdio: 'ignore', timeout: 5000 })
  } catch {
    return { success: false, path: '', error: 'Node.js 可执行文件无法运行' }
  }

  // Clean archive
  try { fs.unlinkSync(archivePath) } catch { /* ignore */ }

  onProgress('Node.js 运行时安装完成')
  return { success: true, path: nodeBin }
}

/**
 * Ensure a directory exists (mkdir -p).
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Check if a command is available on the system PATH.
 * @param {string} cmd
 * @returns {boolean}
 */
function hasCommand(cmd) {
  try {
    const check = process.platform === 'win32' ? 'where' : 'which'
    execSync(`${check} ${cmd}`, { stdio: 'ignore', encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

/**
 * Get the Node.js version string (bundled first, then system).
 * @returns {string|null} e.g. "v24.0.0"
 */
function getNodeVersion() {
  const resolved = resolveNode()
  return resolved.version
}

/**
 * Compare two semver version strings (e.g. "v24.0.0" >= "22.19").
 * @param {string} actual
 * @param {string} required
 * @returns {boolean}
 */
function versionGte(actual, required) {
  const parse = (v) => v.replace(/^v/, '').split('.').map(Number)
  const a = parse(actual)
  const r = parse(required)
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const ai = a[i] || 0
    const ri = r[i] || 0
    if (ai > ri) return true
    if (ai < ri) return false
  }
  return true
}

/**
 * Parse a semver-ish string (with optional prerelease) into comparable parts.
 * "0.1.5-rc.2" → { major: 0, minor: 1, patch: 5, pre: ['rc', 2] }
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number, pre: (number|string)[] } | null}
 */
function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/)
  if (!m) return null
  const pre = m[4]
    ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
    : []
  return { major: +m[1], minor: +m[2], patch: +m[3], pre }
}

/**
 * Prerelease-aware semver comparison: -1 / 0 / 1.
 * Per semver: a prerelease sorts LOWER than its release (0.1.5-rc.1 < 0.1.5).
 */
function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  const len = Math.max(pa.pre.length, pb.pre.length)
  // Semver rule 11: a version WITHOUT a prerelease sorts HIGHER than the
  // same version WITH one (0.1.5 > 0.1.5-rc.2).
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // shorter prerelease list sorts lower
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    if (xNum && yNum) return x < y ? -1 : 1
    if (xNum) return -1 // numeric identifiers sort lower than alphanumeric
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Extract the LOWER bound version from a semver range string.
 * Supports: "*", ">=x.y.z", "^x.y.z", "~x.y.z", "x.y.z" (exact → that version).
 * @returns {string|null} lower bound version, or null when unbounded
 */
function semverRangeFloor(range) {
  const r = String(range || '').trim()
  if (!r || r === '*' || r === 'latest' || r === 'x') return null
  const m = r.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/)
  return m ? m[1] : null
}

/**
 * Scan the profile's installed plugins and check their DSH requirements
 * against the actually-resolved DSH version. This detects the
 * "community plugin built against a newer DSH core" case that crashes
 * the Web UI React tree (e.g. React error #130, blank content).
 * Synchronous + filesystem-only — safe to call from the renderer.
 * @param {string} profile
 * @returns {{ dshVersion: string|null, incompatible: Array<{name, version, required, via}>, checked: number }}
 */
function checkPluginCompatImpl(profile) {
  const out = { dshVersion: null, incompatible: [], checked: 0 }

  // Resolve the DSH version the server would actually use
  const nodeInfo = resolveNode()
  const globalDshBin = nodeInfo.path ? resolveGlobalDshBin({ fast: true }) : null
  if (globalDshBin) {
    try {
      const v = execSync(`"${nodeInfo.path}" "${globalDshBin}" --version`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000,
      }).trim()
      out.dshVersion = v
    } catch { /* fall through with null version */ }
  }
  if (!out.dshVersion) return out

  const nmDir = path.join(getDshHome(), 'profiles', profile || DEFAULT_PROFILE, 'node_modules')
  if (!fs.existsSync(nmDir)) return out

  /** @type {Array<(string|null)>} package dirs, including scoped subdirs */
  const pkgDirs = []
  try {
    for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        const scopeDir = path.join(nmDir, entry.name)
        try {
          for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
            if (sub.isDirectory() || sub.isSymbolicLink()) pkgDirs.push(path.join(scopeDir, sub.name))
          }
        } catch { /* unreadable scope */ }
      } else {
        pkgDirs.push(path.join(nmDir, entry.name))
      }
    }
  } catch { /* unreadable node_modules */ }

  for (const dir of pkgDirs) {
    const pkgJsonPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgJsonPath)) continue
    let pkg
    try { pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) } catch { continue }
    if (!pkg || !pkg.name) continue
    // Skip DSH core's own packages — they ARE the reference version
    if (pkg.name.startsWith('@deepseek-ai/')) continue

    out.checked++

    // Collect requirements: engines.dsh + peerDependencies on @deepseek-ai/dsh-* packages
    let floor = null
    let via = ''
    const consider = (range, label) => {
      const f = semverRangeFloor(range)
      if (!f) return
      if (!floor || compareSemver(f, floor) > 0) { floor = f; via = label }
    }
    if (pkg.engines && pkg.engines.dsh) consider(pkg.engines.dsh, 'engines.dsh')
    const peers = pkg.peerDependencies || {}
    for (const [dep, range] of Object.entries(peers)) {
      // Only DSH core packages track the DSH version; skip the cordis framework
      if (/^@deepseek-ai\/dsh(-|$)/.test(dep)) consider(range, dep)
    }
    if (floor && compareSemver(out.dshVersion, floor) < 0) {
      out.incompatible.push({ name: pkg.name, version: pkg.version || '?', required: floor, via })
    }
  }

  return out
}

/**
 * Simple YAML parser for flat key-value files (settings.yaml, credentials).
 * Not a full YAML parser — handles only the subset DSH config uses.
 * @param {string} content
 * @returns {object}
 */
function parseSimpleYaml(content) {
  const result = {}
  const lines = content.split('\n')
  let currentSection = result

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    // Section header (e.g. "llm-pi-ai:")
    const sectionMatch = trimmed.match(/^([\w-]+):\s*$/)
    if (sectionMatch) {
      if (!result[sectionMatch[1]]) result[sectionMatch[1]] = {}
      currentSection = result[sectionMatch[1]]
      continue
    }

    // Key-value pair (e.g. "apiKeyEnv: DEEPSEEK_API_KEY")
    const kvMatch = trimmed.match(/^(\S+):\s*(.*)$/)
    if (kvMatch) {
      let value = kvMatch[2].trim()
      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      // Parse arrays [a, b]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      }
      // Parse booleans
      if (value === 'true') value = true
      if (value === 'false') value = false
      currentSection[kvMatch[1]] = value
    }
  }

  return result
}

/**
 * Serialize a simple object to YAML-like format.
 * @param {object} obj
 * @param {number} indent
 * @returns {string}
 */
function stringifySimpleYaml(obj, indent = 0) {
  const lines = []
  const pad = '  '.repeat(indent)

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue

    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${pad}${key}:`)
      lines.push(stringifySimpleYaml(value, indent + 1))
    } else if (Array.isArray(value)) {
      lines.push(`${pad}${key}:`)
      for (const item of value) {
        lines.push(`${pad}  - ${typeof item === 'string' ? item : JSON.stringify(item)}`)
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${pad}${key}: ${value}`)
    } else if (typeof value === 'number') {
      lines.push(`${pad}${key}: ${value}`)
    } else {
      lines.push(`${pad}${key}: ${value}`)
    }
  }

  return lines.join('\n')
}

/**
 * Make an HTTP request to the DSH server.
 * @param {string} method - HTTP method
 * @param {string} urlPath - Path starting with /
 * @param {object|null} body - Request body
 * @param {number} port - Server port
 * @returns {Promise<object>}
 */
function httpRequest(method, urlPath, body = null, port = serverStatus.port) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {}
          resolve({ statusCode: res.statusCode, data: parsed })
        } catch {
          resolve({ statusCode: res.statusCode, data: { raw: data } })
        }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })

    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

// ============================================================
//  Link Bridge — local reverse proxy that injects an external-link
//  interceptor into the DSH Web UI HTML.
//
//  WHY: the DSH web UI is loaded in a cross-origin iframe
//  (http://127.0.0.1:<port>) inside the uTools plugin page, so the
//  parent page cannot inject scripts into it, and uTools' preload
//  environment does not expose @electron/remote / electron.remote,
//  so setWindowOpenHandler-based interception silently fails.
//
//  SOLUTION: a tiny local reverse proxy listens on the configured
//  port, forwards everything to the real DSH server (which runs on
//  a free port), and injects <script src="/__dsh_link_bridge.js">
//  into text/html responses. The bridge script intercepts clicks on
//  external links / target=_blank and posts a message to the parent
//  page, which calls utools.shellOpenExternal().
// ============================================================

/**
 * Tokenized Web UI entry URL captured from the DSH process output.
 * `dsh web` prints its authenticated URL at startup (browser-trust fence);
 * loading the bare origin returns 401 "authentication required", so the
 * iframe must use this URL. Reset on every server start/stop.
 */
let dshWebUrl = null

/**
 * Extract the loopback Web UI entry URL from DSH process output.
 * Accepts `dsh web: <url>` style lines and bare `http://127.0.0.1:<port>/...`
 * URLs on the configured port. LAN (non-loopback) advertisements are ignored —
 * the iframe must stay on loopback.
 * @param {string} text - a chunk of process stdout/stderr
 */
function captureWebUrl(text) {
  if (!text || !serverStatus || !serverStatus.port) return
  const port = serverStatus.port
  // Prefer the explicit `dsh web:` line, fall back to any loopback URL on our port
  const lineMatch = text.match(/dsh web:?[^ ]* (https?:\/\/[^\s]+)/i)
  const candidates = []
  if (lineMatch) candidates.push(lineMatch[1])
  const loose = text.match(new RegExp(`https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}[^\\s"')]*`, 'g'))
  if (loose) candidates.push(...loose)
  for (const url of candidates) {
    if (url.startsWith(`http://127.0.0.1:${port}`) || url.startsWith(`http://localhost:${port}`) || url.startsWith('http://[::1]:' + port)) {
      dshWebUrl = url.replace(/[.,)]+$/, '')
      console.log(`[dsh] captured Web UI entry URL: ${dshWebUrl}`)
      return
    }
  }
}

/**
 * Small bridge script served at /__dsh_link_bridge.js inside the
 * DSH iframe. Intercepts external-link clicks and window.open(),
 * forwarding the URL to the parent page via postMessage.
 */
const LINK_BRIDGE_SCRIPT = `;(function () {
  if (window.__dshLinkBridgeInstalled) return
  window.__dshLinkBridgeInstalled = true
  var origin = window.location.origin
  // The real DSH server origin (http://127.0.0.1:3080). URLs pointing here
  // are the SAME app behind the proxy — they must navigate inside this
  // iframe (rewritten to the bridge origin), never to the system browser.
  var targetOrigin = '__DSH_TARGET_ORIGIN__'

  // NOTE: no regex literals here — this script lives inside a template
  // literal in preload.js and escape-layer bugs are easy to make. Plain
  // prefix checks are equivalent (loopback host on any port) and safe.
  function isLocalUrl(url) {
    var u = String(url || '')
    var hosts = [
      'http://127.0.0.1:', 'http://localhost:', 'http://[::1]:',
      'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/',
    ]
    for (var i = 0; i < hosts.length; i++) {
      if (u.indexOf(hosts[i]) === 0) return true
    }
    return false
  }

  // Map any local (loopback) URL onto the bridge origin so the SPA stays
  // behind the proxy (keeps the injected bridge script + same-origin APIs).
  // Covers the direct DSH origin (http://127.0.0.1:3080) and host variants
  // (localhost / [::1], any port) — path and query are preserved.
  function toBridgeUrl(url) {
    var u = String(url)
    if (targetOrigin && u.indexOf(targetOrigin) === 0) {
      return origin + u.slice(targetOrigin.length)
    }
    if (isLocalUrl(u)) {
      var idx = u.indexOf('/', u.indexOf('://') + 3)
      var rest = idx === -1 ? '/' : u.slice(idx)
      return origin + rest
    }
    return u
  }

  function openExternal(url) {
    if (!url) return
    try {
      window.parent.postMessage({ type: 'dsh-open-external', url: String(url) }, '*')
    } catch (e) {}
  }

  // Navigate this iframe. Local (DSH/bridge) URLs stay in-frame; only
  // genuinely external URLs go to the system browser. This is what stops
  // plugins / window.open() from yanking the user out of uTools.
  function navigateInFrame(url) {
    var mapped = toBridgeUrl(url)
    if (isLocalUrl(url)) {
      try { window.location.href = mapped } catch (e) {}
      return
    }
    openExternal(url)
  }

  // Handle a link click: decide in-frame vs external, and stop the browser's
  // default navigation so target=_blank never spawns a new window/browser.
  function handleLink(e, href, target) {
    if (!href) return
    var handled = false
    if (target === '_blank' || target === '_new') {
      if (isLocalUrl(href)) navigateInFrame(href)
      else openExternal(href)
      handled = true
    } else if (
      href.indexOf(origin) !== 0 &&
      href.indexOf('about:') !== 0 &&
      href.indexOf('javascript:') !== 0 &&
      href.indexOf('data:') !== 0
    ) {
      if (isLocalUrl(href)) navigateInFrame(href)
      else openExternal(href)
      handled = true
    }
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // Capture clicks on <a> tags (capture phase, before the SPA handles them)
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null
    if (!a || !a.href) return
    handleLink(e, a.href, a.target || '')
  }, true)

  // window.open() calls (e.g. JS-driven popups) → local: stay in this
  // iframe; external: system browser. Plugins like remote-web-ui auto-call
  // window.open(http://127.0.0.1:3080/...) which previously popped the
  // browser — a local URL now navigates in-frame instead.
  var nativeOpen = window.open
  if (nativeOpen) {
    window.open = function (url) {
      if (url && typeof url === 'string' && url.indexOf('about:') !== 0) {
        if (isLocalUrl(url)) {
          navigateInFrame(url)
        } else {
          openExternal(url)
        }
      }
      return null
    }
  }

  // Right-click anywhere in the DSH page → tell the parent to show a
  // context menu. Keep native menu inside editable fields (copy/paste).
  document.addEventListener('contextmenu', function (e) {
    var t = e.target
    var editable = t && (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable
    )
    if (editable) return
    var a = t && t.closest ? t.closest('a[href]') : null
    e.preventDefault()
    e.stopPropagation()
    try {
      window.parent.postMessage({
        type: 'dsh-context-link',
        url: a && a.href ? String(a.href) : '',
        clientX: e.clientX || 0,
        clientY: e.clientY || 0,
      }, '*')
    } catch (err) {}
  }, true)

  // Report client-side errors (React crashes, plugin render failures, …) to
  // the parent so a blank/crashed Web UI shows an actionable message instead
  // of an empty dark page (e.g. plugin ↔ DSH core version incompatibility).
  function reportClientError(message, source) {
    try {
      window.parent.postMessage({
        type: 'dsh-client-error',
        message: String(message || 'Unknown error').slice(0, 1000),
        source: String(source || '').slice(0, 300),
      }, '*')
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    if (e && e.message) {
      reportClientError(e.message, e.filename ? (e.filename + ':' + e.lineno) : '')
    }
  }, true)
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason
    var msg = r && (r.message || r)
    if (msg) reportClientError('Unhandled rejection: ' + msg, r && r.stack ? String(r.stack).split('\\n')[0] : '')
  }, true)

  // ── Boot telemetry ──
  // In the uTools production iframe there is no devtools: when the SPA
  // silently fails to boot (dark blank shell), report WHY to the parent —
  // milestones, every failed resource (script/css/img), and DOM growth
  // samples so the parent can tell "boot shell only" from a mounted app.
  function reportBoot(stage, detail) {
    try {
      window.parent.postMessage({
        type: 'dsh-boot-progress',
        stage: String(stage).slice(0, 60),
        detail: String(detail || '').slice(0, 400),
      }, '*')
    } catch (e) {}
  }
  reportBoot('bridge-installed', document.readyState + ' secure=' + window.isSecureContext)
  document.addEventListener('DOMContentLoaded', function () { reportBoot('dom-content-loaded') })
  window.addEventListener('load', function () { reportBoot('window-load') })
  // Resource load failures (capture phase — these never reach window.onerror)
  window.addEventListener('error', function (e) {
    var t = e && e.target
    if (t && t.tagName && (t.src || t.href)) {
      reportBoot('resource-error', t.tagName + ' ' + String(t.src || t.href).slice(0, 300))
    }
  }, true)
  // DOM growth sampling: the boot shell has only a handful of elements;
  // a mounted SPA has hundreds. >30 total elements = booted.
  var bootSamples = 0
  var bootTimer = setInterval(function () {
    bootSamples++
    try {
      var total = document.body ? document.body.querySelectorAll('*').length : 0
      reportBoot('dom-sample', 'total=' + total)
      if (total > 30) {
        clearInterval(bootTimer)
        reportBoot('spa-booted', 'total=' + total)
        return
      }
    } catch (e) {}
    if (bootSamples >= 30) clearInterval(bootTimer)
  }, 1000)
})()`

/**
 * Start the link-bridge proxy on `listenPort`, forwarding all
 * requests to the real DSH server on `targetPort`.
 * @param {number} listenPort - Port the iframe/UI connects to (configured port)
 * @param {number} targetPort - Port the actual DSH server listens on
 * @returns {Promise<number>} The bound port
 */
function startBridge(listenPort, targetPort) {
  return new Promise((resolve, reject) => {
    stopBridge()
    bridgeTargetPort = targetPort

    const server = http.createServer((req, res) => {
      // Serve the bridge script itself (same-origin with the DSH page).
      // Substitute the real DSH origin so the script can rewrite local
      // (direct-origin) URLs back onto the bridge.
      if (req.url === '/__dsh_link_bridge.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(LINK_BRIDGE_SCRIPT.replace('__DSH_TARGET_ORIGIN__', `http://127.0.0.1:${bridgeTargetPort}`))
        return
      }
      bridgeProxyRequest(req, res)
    })

    server.on('upgrade', (req, socket, head) => bridgeProxyUpgrade(req, socket, head))

    server.on('error', (err) => {
      stopBridge()
      reject(err)
    })

    server.listen(listenPort, '127.0.0.1', () => {
      bridgeServer = server
      bridgeListenPort = server.address().port
      console.log(`[dsh] link bridge listening on 127.0.0.1:${bridgeListenPort} → 127.0.0.1:${targetPort}`)
      resolve(server.address().port)
    })
  })
}

/**
 * Stop the link-bridge proxy.
 */
function stopBridge() {
  if (bridgeServer) {
    try { bridgeServer.close() } catch { /* ignore */ }
    bridgeServer = null
  }
  bridgeTargetPort = null
  bridgeListenPort = null
  // Fresh server → fresh trust session; drop the stale jar so a new one is
  // acquired from the (new) token on the next start()/page load.
  bridgeCookieJar = new Map()
}

/**
 * Rewrite forwarded request headers so the DSH server sees a consistent
 * same-origin request. DSH's isTrustedApiRequest() rejects (403) any
 * /api request whose Origin host does not match the Host header, so we
 * must rewrite Host, Origin and Referer to the DSH's own origin.
 * @param {object} headers - Incoming (browser) request headers
 * @returns {object} New headers object safe to forward to the DSH server
 */
function rewriteBridgeHeaders(headers) {
  const out = { ...headers }
  const targetOrigin = `http://127.0.0.1:${bridgeTargetPort}`
  out.host = `127.0.0.1:${bridgeTargetPort}`
  if (out.origin) out.origin = targetOrigin
  if (out.referer) {
    out.referer = String(out.referer).replace(/^https?:\/\/[^/]+/, targetOrigin)
  }
  // Attach the bridge-held trust session (SameSite=Strict cookies are not
  // sent by browsers in cross-site iframes — the jar guarantees trust).
  const mergedCookie = bridgeMergeCookie(out.cookie)
  if (mergedCookie) out.cookie = mergedCookie
  // Force identity encoding so HTML can be rewritten before forwarding
  delete out['accept-encoding']
  return out
}

/**
 * Rewrite response headers coming back from the DSH server so the
 * browser (whose page origin is the bridge port, not the DSH port)
 * does not reject them. CORS headers emitted by DSH point at its own
 * origin; we retarget them at the bridge origin the iframe lives on.
 * @param {object} headers - Response headers from the DSH server
 * @returns {object} New headers object safe to send to the browser
 */
function rewriteBridgeResponseHeaders(headers) {
  const out = { ...headers }
  const bridgeOrigin = bridgeListenPort ? `http://127.0.0.1:${bridgeListenPort}` : null
  if (!bridgeOrigin) return out
  // Retarget CORS headers at the bridge origin (the page's own origin)
  if (out['access-control-allow-origin']) {
    out['access-control-allow-origin'] = bridgeOrigin
  }
  // Access-Control-Allow-Origin with credentials must not be '*'
  if (out['access-control-allow-credentials'] === 'true' ||
      String(out['access-control-allow-credentials'] || '').toLowerCase() === 'true') {
    out['access-control-allow-origin'] = bridgeOrigin
  }
  // Rewrite redirect targets: a 3xx Location pointing at the DSH's own
  // origin (http://127.0.0.1:3080/...) would bounce the iframe OFF the
  // bridge (losing the injected script and same-origin APIs), and the
  // subsequent origin mismatch is what previously popped the system
  // browser. Keep redirects on the bridge origin instead.
  const targetOrigin = `http://127.0.0.1:${bridgeTargetPort}`
  if (out.location && String(out.location).startsWith(targetOrigin)) {
    out.location = bridgeOrigin + String(out.location).slice(targetOrigin.length)
  }
  return out
}

/**
 * Forward a normal HTTP request to the DSH server, injecting the
 * bridge script into text/html responses.
 */
function bridgeProxyRequest(req, res, retried = false) {
  if (!bridgeTargetPort) {
    res.writeHead(502)
    res.end()
    return
  }
  const headers = rewriteBridgeHeaders(req.headers)

  const proxyResHandler = (proxyRes) => {
    // Harvest any new/refreshed session cookie into the jar (forwarding the
    // Set-Cookie to the browser unchanged below).
    try { bridgeUpdateJarFromResponse(proxyRes.headers) } catch { /* ignore */ }

    const ct = String(proxyRes.headers['content-type'] || '').toLowerCase()
    const isHtml = ct.includes('text/html')
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, rewriteBridgeResponseHeaders(proxyRes.headers))
      proxyRes.pipe(res)
      return
    }

    // A page GET that still answers 401 means the jar's session went stale
    // (e.g. DSH restarted with a new token). Re-acquire once and retry.
    if (proxyRes.statusCode === 401 && !retried && req.method === 'GET') {
      proxyRes.resume()
      proxyRes.on('end', () => {
        bridgeAcquireSession().then((ok) => {
          if (ok) {
            console.log('[dsh] bridge session re-acquired, retrying page request')
            bridgeProxyRequest(req, res, true)
          } else {
            res.writeHead(401, rewriteBridgeResponseHeaders(proxyRes.headers))
            res.end()
          }
        })
      })
      return
    }

    // Buffer the HTML, inject the bridge script, then forward
    const chunks = []
    proxyRes.on('data', (c) => chunks.push(c))
    proxyRes.on('end', () => {
      let buf = Buffer.concat(chunks)
      const enc = String(proxyRes.headers['content-encoding'] || '').toLowerCase()

      const finish = (htmlBuf) => {
        let html = htmlBuf.toString('utf8')
        const tag = '<script src="/__dsh_link_bridge.js"></script>'
        // Strip any CSP meta tags so the injected script is allowed to run
        html = html.replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '')
        if (/<head[^>]*>/i.test(html)) {
          // Inject as the FIRST thing inside <head> so our error/telemetry
          // listeners install before the shell's own boot scripts — errors
          // thrown by those scripts must be captured too.
          html = html.replace(/<head[^>]*>/i, (m) => m + tag)
        } else if (/<\/head>/i.test(html)) {
          html = html.replace(/<\/head>/i, tag + '</head>')
        } else if (/<body[^>]*>/i.test(html)) {
          html = html.replace(/<body[^>]*>/i, (m) => m + tag)
        } else {
          html = tag + html
        }
        const outHeaders = rewriteBridgeResponseHeaders(proxyRes.headers)
        delete outHeaders['content-length']
        delete outHeaders['content-encoding']
        delete outHeaders['content-security-policy']
        outHeaders['cache-control'] = 'no-store'
        console.log(`[dsh] bridge: injected link interceptor into ${req.url} (${html.length} bytes)`)
        res.writeHead(proxyRes.statusCode, outHeaders)
        res.end(html)
      }

      if (enc === 'gzip') {
        zlib.gunzip(buf, (err, out) => finish(err ? buf : out))
      } else if (enc === 'deflate') {
        zlib.inflate(buf, (err, out) => finish(err ? buf : out))
      } else if (enc === 'br') {
        zlib.brotliDecompress(buf, (err, out) => finish(err ? buf : out))
      } else {
        finish(buf)
      }
    })
    proxyRes.on('error', () => { try { res.end() } catch { /* ignore */ } })
  }

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: bridgeTargetPort,
    path: req.url,
    method: req.method,
    headers,
  }, (proxyRes) => proxyResHandler(proxyRes))

  proxyReq.on('error', () => {
    try { res.writeHead(502); res.end() } catch { /* ignore */ }
  })
  req.pipe(proxyReq)
}

/**
 * Forward a WebSocket upgrade to the DSH server (raw TCP tunnel).
 */
function bridgeProxyUpgrade(req, socket, head) {
  if (!bridgeTargetPort) {
    socket.destroy()
    return
  }
  const dest = net.connect(bridgeTargetPort, '127.0.0.1', () => {
    const headers = rewriteBridgeHeaders(req.headers)
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) {
        for (const vv of v) raw += `${k}: ${vv}\r\n`
      } else if (v !== undefined) {
        raw += `${k}: ${v}\r\n`
      }
    }
    raw += '\r\n'
    dest.write(raw)
    if (head && head.length) dest.write(head)
    socket.pipe(dest)
    dest.pipe(socket)
  })
  dest.on('error', () => socket.destroy())
  socket.on('error', () => dest.destroy())
}

// ============================================================
//  window.dsh — Public API
// ============================================================

window.dsh = {}

// ------------------------------------------------------------
//  env — Environment detection
// ------------------------------------------------------------

window.dsh.env = {
  /**
   * Get the Node.js version (bundled first, then system).
   * @returns {string|null}
   */
  getNodeVersion() {
    return getNodeVersion()
  },

  /**
   * Check if npx is available (bundled or system).
   * @returns {boolean}
   */
  hasNpx() {
    return resolveNpx() !== null
  },

  /**
   * Check if pnpm is available.
   * @returns {boolean}
   */
  hasPnpm() {
    return hasCommand('pnpm') || hasCommand('pnpm.cmd')
  },

  /**
   * Check if DSH is installed (globally or via npx cache).
   * Uses bundled or system npx.
   * @param {{ skipNpx?: boolean }} opts — skip the slow npx check (may
   *   block up to 30s and trigger a package download). UI entry points
   *   MUST pass { skipNpx: true } to avoid freezing the plugin window.
   * @returns {{ installed: boolean, version: string|null, method: string|null }}
   */
  hasDshInstalled(opts = {}) {
    const nodeInfo = resolveNode()
    if (!nodeInfo.path) return { installed: false, version: null, method: null }

    // 1. Sandbox installs only (fast — pure filesystem + one --version probe).
    //    The user's system-global `dsh`, the shared ~/.npm npx cache and other
    //    shells' installs are deliberately NOT considered: the server runs
    //    sandboxed, so its presence/absence elsewhere is irrelevant.
    const sandboxBin = resolveGlobalDshBin()
    if (sandboxBin) {
      try {
        const out = execSync(`"${nodeInfo.path}" "${sandboxBin}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
        return { installed: true, version: out.trim(), method: 'sandbox' }
      } catch { /* probe failed — report uninstalled */ }
    }

    // 2. (Optional, non-UI paths) probe the PRIVATE npx cache by running npx
    //    with the sandbox cache dir — may download into the sandbox (slow,
    //    up to 30s); UI entry points pass { skipNpx: true }.
    if (!opts.skipNpx) {
      const npxInfo = resolveNpx()
      if (npxInfo) {
        try {
          const env = { ...process.env, npm_config_cache: getSandboxNpmCache() }
          const npxArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--version'].join(' ')
          const out = execSync(`"${npxInfo.cmd}" ${npxArgs}`, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 30000,
            env,
          })
          return { installed: true, version: out.trim(), method: 'npx' }
        } catch { /* npx failed */ }
      }
    }

    return { installed: false, version: null, method: null }
  },

  /**
   * Check installed profile plugins against the resolved DSH version.
   * Detects community plugins built for a newer DSH core (the "blank Web UI"
   * React crash case). Filesystem-only, synchronous.
   * @param {string} [profile]
   * @returns {{ dshVersion: string|null, incompatible: Array<{name, version, required, via}>, checked: number }}
   */
  checkPluginCompat(profile) {
    return checkPluginCompatImpl(profile)
  },

  /**
   * Get the operating system platform.
   * @returns {string}
   */
  getPlatform() {
    return process.platform
  },

  /**
   * Check all prerequisites, considering bundled runtime.
   * Note: hasDshInstalled() is SLOW (up to 30s via npx) and blocks the UI.
   * Pass { skipDshCheck: true } for a fast check that only verifies Node+npx.
   * @param {{ skipDshCheck?: boolean }} opts
   * @returns {{ nodeVersion: string|null, nodeOk: boolean, nodeSource: string|null, npxOk: boolean, pnpmOk: boolean, dsh: object, platform: string, allOk: boolean, bundledNode: boolean }}
   */
  checkPrerequisites(opts = {}) {
    const nodeInfo = resolveNode()
    const nodeVersion = nodeInfo.version
    const nodeOk = nodeVersion ? versionGte(nodeVersion, '24.0.0') : false
    const npxOk = this.hasNpx()
    const pnpmOk = this.hasPnpm()
    // Skip the slow npx check unless explicitly requested
    const dsh = opts.skipDshCheck ? { installed: false, version: null, method: null } : this.hasDshInstalled()

    return {
      nodeVersion,
      nodeOk,
      nodeSource: nodeInfo.source,
      bundledNode: nodeInfo.source === 'bundled',
      npxOk,
      pnpmOk,
      dsh,
      platform: this.getPlatform(),
      // allOk only requires Node + npx; DSH auto-installs on first npx run
      allOk: nodeOk && npxOk,
    }
  },

  /**
   * Bundled Node.js runtime management.
   */
  runtime: {
    /**
     * Get the status of the bundled Node.js runtime.
     * @returns {{ installed: boolean, path: string|null, version: string|null }}
     */
    getStatus() {
      const bundled = getBundledNodePath()
      if (!bundled) return { installed: false, path: null, version: null }
      try {
        const out = execSync(`"${bundled}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
        return { installed: true, path: bundled, version: out.trim() }
      } catch {
        return { installed: false, path: bundled, version: null }
      }
    },

    /**
     * Download and install the bundled Node.js runtime.
     * @param {{ onProgress?: (msg: string) => void }} callbacks
     * @returns {Promise<{ success: boolean, path: string, error?: string }>}
     */
    async download(callbacks = {}) {
      return downloadNodeRuntime(callbacks)
    },

    /**
     * Get the path to the bundled node binary.
     * @returns {string|null}
     */
    getPath() {
      return getBundledNodePath()
    },
  },
}

// ------------------------------------------------------------
//  server — DSH server lifecycle management
// ------------------------------------------------------------

window.dsh.server = {
  /**
   * Start the DSH web server.
   * @param {{ port?: number, workspace?: string, profile?: string, patches?: string[] }} options
   * @returns {Promise<{ success: boolean, url: string, error?: string }>}
   */
  async start(options = {}) {
    // Serialize concurrent starts (double onPluginEnter, autoStart + manual
    // click / hotkey entry, crash-restart overlap). Two parallel start()
    // calls spawn two DSH processes racing for the same port — the loser
    // dies with EADDRINUSE ("startup failed: webserver did not activate")
    // and the UI reports a bogus startup failure. Joining the in-flight
    // promise makes every caller share one spawn.
    if (this._startPromise) return this._startPromise
    this._startPromise = this._doStart(options).finally(() => {
      this._startPromise = null
    })
    return this._startPromise
  },

  /**
   * Actual start implementation — always invoked through start() so that
   * concurrent callers join the same in-flight promise.
   * @param {{ port?: number, workspace?: string, profile?: string, patches?: string[] }} options
   * @returns {Promise<{ success: boolean, url: string, error?: string }>}
   */
  async _doStart(options = {}) {
    const {
      port = DEFAULT_PORT,
      workspace = null,
      profile = DEFAULT_PROFILE,
      patches = [],
    } = options

    // Resolve workspace: use provided, or saved, or DSH home, or os.homedir()
    const resolvedWorkspace = workspace
      || this.getWorkspace()
      || getDshHome()
      || os.homedir()

    // ── Crash auto-restart bookkeeping (consumed by the exit handler below) ──
    // A manual start() always resets the retry budget; stop() marks the
    // upcoming exit as intentional so it is never auto-restarted.
    this._intentionalStop = false
    this._crashRetries = 0
    this._lastStartOptions = { workspace: resolvedWorkspace, port, profile, patches }

    // If already running, check if same config
    if (dshProcess && serverStatus.running) {
      if (serverStatus.port === port && serverStatus.workspace === resolvedWorkspace) {
        // Ensure the bridge is still up (it may have been stopped)
        if (!bridgeServer) {
          try {
            await startBridge(0, serverStatus.dshPort || port)
          } catch (err) {
            console.warn('[dsh] bridge re-start failed:', err.message)
          }
        }
        return { success: true, url: this.getServerUrl() }
      }
      await this.stop()
    }

    // Reset buffers
    stdoutBuffer = []
    stderrBuffer = []

    // Yield before synchronous execSync calls to let UI render
    await new Promise(r => setTimeout(r, 0))

    // ── Port arbitration (sandboxed) ──
    // The DSH server must never share a port with foreign processes:
    // 1. Kill OUR OWN orphaned DSH from a previous plugin session
    //    (crashed uTools leaves children re-parented to init holding the port).
    // 2. If the port is still busy after that, it belongs to a foreign service
    //    (user's VS Code panel DSH, CLI, or an unrelated app) — under the
    //    full-isolation mandate we do NOT adopt it; pick a free port instead.
    let actualPort = port
    try {
      if (await isTcpPortOccupied(port)) {
        const killed = killOrphanDshProcesses(port)
        if (killed > 0) {
          // Give the killed processes a moment to release the port
          await new Promise(r => setTimeout(r, 500))
        }
        if (await isTcpPortOccupied(port)) {
          actualPort = await findFreePort(port + 1)
          console.warn(`[dsh] port ${port} is held by a foreign process — using sandbox port ${actualPort} instead`)
        } else {
          console.log(`[dsh] cleaned ${killed} own orphaned DSH process(es), reusing port ${port}`)
        }
      }
    } catch (err) {
      console.warn('[dsh] port arbitration failed:', err.message)
    }

    // Determine the command to run — prefer the plugin-managed sandbox DSH
    // (fast: no npx registry round-trip), falling back to npx (private cache)
    // when missing. Neither ever touches the user's shared npm caches or
    // system-global installs.
    const globalDshBin = resolveGlobalDshBin()
    const npxInfo = resolveNpx()
    const nodeInfo = resolveNode()

    // Debug: log resolved paths to console for troubleshooting
    console.log('[dsh] sandbox root:', getSandboxRoot())
    console.log('[dsh] resolveGlobalDshBin:', globalDshBin)
    console.log('[dsh] resolveNpx:', JSON.stringify(npxInfo))
    console.log('[dsh] resolveNode:', JSON.stringify(nodeInfo))

    if (!globalDshBin && (!npxInfo || !nodeInfo.path)) {
      // Last resort: try system npx directly
      return {
        success: false,
        url: '',
        error: `Node.js 或 npx 不可用。globalDshBin=${globalDshBin}, npxInfo=${JSON.stringify(npxInfo)}, nodeInfo=${JSON.stringify(nodeInfo)}`,
      }
    }

    // Link bridge: the bridge listens on a RANDOM free port and forwards
    // to the DSH server on the sandbox port. The iframe connects to the
    // bridge URL (getServerUrl) so it receives the injected link
    // interceptor. The bridge is best-effort — if it fails to start, the
    // server still runs (links just won't auto-open in the system browser).
    try {
      await startBridge(0, actualPort)
    } catch (err) {
      console.warn('[dsh] link bridge failed to start (non-fatal):', err.message)
    }

    // Build command arguments
    const cmdArgs = globalDshBin ? [globalDshBin] : [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh']
    if (profile === 'web') {
      cmdArgs.push('web')
      // DSH web auto-opens the DEFAULT SYSTEM BROWSER at startup
      // ("dsh web: opening the default browser; pass --no-open to disable").
      // Without this flag every server start pops an external browser window.
      cmdArgs.push('--no-open')
      // A fresh process issues a fresh trust token, so any user-pasted entry
      // URL for this port (from a previous/external process) is now stale.
      try {
        if (typeof utools !== 'undefined' && utools.dbStorage) {
          utools.dbStorage.removeItem(`dsh-web-entry-${actualPort}`)
          utools.dbStorage.removeItem(`dsh-web-entry-${port}`)
        }
      } catch { /* ignore */ }
    } else {
      cmdArgs.push('--profile', profile)
    }

    // DSH listens on the sandbox port; the bridge (random port) forwards to it
    cmdArgs.push('--port', String(actualPort))

    for (const patch of patches) {
      cmdArgs.push('--patch', patch)
    }

    // ── Sandbox environment ──
    // Everything the spawned process touches stays inside the sandbox:
    //   DSH_HOME=<sandbox>/home          (profiles/sessions/settings)
    //   npm_config_cache=<sandbox>/cache (npx/npm downloads)
    // Foreign resources (~/.dsh, ~/.npm) are neither read nor written.
    ensureSandboxDirs()
    const env = { ...process.env }
    env.DSH_HOME = getDshHome()
    env.npm_config_cache = getSandboxNpmCache()
    // Use China-friendly registry by default (user can override via .npmrc)
    if (!env.npm_config_registry) {
      env.npm_config_registry = 'https://registry.npmmirror.com'
    }
    const nodeDir = path.dirname(nodeInfo.path)
    const pathSep = process.platform === 'win32' ? ';' : ':'
    // Ensure PATH includes system paths + bundled node
    const systemPath = process.env.PATH || process.env.Path || ''
    env.PATH = nodeDir + pathSep + systemPath
    // Windows needs ComSpec for .cmd/.bat execution
    if (process.platform === 'win32' && !env.ComSpec) {
      env.ComSpec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    }

    // Inject the AbortSignal.any polyfill (if present) into the spawned DSH
    // server process. The uTools embedded runtime / older Node versions do not
    // implement AbortSignal.any(), which many DSH dependencies rely on, causing
    // "AbortSignal.any is not a function (internal)" when sending messages.
    // NODE_OPTIONS=--require is inherited by both the global-DSH and the npx path.
    // NOTE: getPolyfillPath() is required here — published plugins run from an
    // .asar archive, and a --require path inside the asar is unloadable by the
    // plain-Node child process (it crashes with "Cannot find module"). The
    // helper materializes the file into the real sandbox dir when needed.
    try {
      const polyfillPath = getPolyfillPath()
      if (polyfillPath) {
        const existing = env.NODE_OPTIONS || ''
        // NODE_OPTIONS is a space-separated token list, so quote the path —
        // otherwise install paths containing spaces (e.g. Windows user
        // directories) would be split into invalid tokens and abort startup.
        const requireOpt = polyfillPath.includes(' ')
          ? `--require="${polyfillPath}"`
          : `--require=${polyfillPath}`
        env.NODE_OPTIONS = (existing ? existing + ' ' : '') + requireOpt
      }
    } catch (polyfillErr) {
      // Non-fatal: if the polyfill cannot be injected, let the server start anyway.
      console.warn('[dsh] failed to inject AbortSignal.any polyfill:', polyfillErr.message)
    }

    try {
      // With a global DSH, spawn the bundled node directly on the DSH entry
      // (shell:false); otherwise spawn npx as before.
      dshProcess = globalDshBin
        ? spawn(nodeInfo.path, cmdArgs, {
            cwd: resolvedWorkspace,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
          })
        : spawn(npxInfo.cmd, cmdArgs, {
            cwd: resolvedWorkspace,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: npxInfo.shell,
          })
    } catch (err) {
      return { success: false, url: '', error: `Failed to spawn process: ${err.message}` }
    }

    serverStatus = {
      running: true,
      port: actualPort,
      dshPort: actualPort,
      pid: dshProcess.pid,
      startTime: Date.now(),
      workspace: resolvedWorkspace,
      profile,
    }
    // Fresh process → any previously captured entry URL is stale
    dshWebUrl = null

    // Capture stdout/stderr for debugging + the tokenized Web UI entry URL.
    // `dsh web` prints its authenticated entry URL (browser-trust fence) at
    // startup, e.g. `dsh web: http://127.0.0.1:3080/?...`. Loading the bare
    // origin gets a 401 "authentication required" page, so the iframe must
    // load the printed URL instead. Parse it from the process output.
    dshProcess.stdout.on('data', (data) => {
      const text = data.toString()
      stdoutBuffer.push(text)
      if (stdoutBuffer.length > 2000) stdoutBuffer.shift()
      captureWebUrl(text)
    })

    // Capture stderr for debugging (the URL may also land on stderr)
    dshProcess.stderr.on('data', (data) => {
      const text = data.toString()
      stderrBuffer.push(text)
      if (stderrBuffer.length > 2000) stderrBuffer.shift()
      captureWebUrl(text)
    })

    // Handle process exit
    dshProcess.on('exit', (code) => {
      const wasIntentional = !!this._intentionalStop
      serverStatus.running = false
      serverStatus.pid = null
      dshWebUrl = null
      stopBridge()
      console.log(`[dsh] server process exited (code=${code})`)

      // ── Crash auto-restart ──
      // Only for UNEXPECTED exits (stop() sets _intentionalStop). Controlled
      // by the settings toggle "服务器崩溃后自动重启" (dbStorage key
      // dsh-setting-autoRestart, default on). Up to 3 attempts with
      // 2s/5s/10s backoff, re-using the original start options. Runs in the
      // preload (node context) so it also works while the renderer is closed.
      let autoRestart = null
      if (this._intentionalStop) {
        this._intentionalStop = false
      } else if (this._crashRetries < 3 && this._lastStartOptions) {
        let enabled = true
        try {
          if (typeof utools !== 'undefined' && utools.dbStorage) {
            const v = utools.dbStorage.getItem('dsh-setting-autoRestart')
            if (v === 'false' || v === false) enabled = false
          }
        } catch { /* default on */ }
        if (enabled) {
          this._crashRetries++
          const attempt = this._crashRetries
          const delay = [2000, 5000, 10000][attempt - 1]
          autoRestart = { attempt, max: 3, delay }
          setTimeout(() => {
            if (serverStatus.running) return
            try {
              const opts = this._lastStartOptions
              this.start(opts).then((res) => {
                if (res && res.success === false) {
                  console.error('[dsh] auto-restart start() failed:', res.error)
                  try {
                    window.dispatchEvent(new CustomEvent('dsh-server-exited', {
                      detail: { code: 'auto-restart-failed', autoRestart: null },
                    }))
                  } catch { /* ignore */ }
                }
              }).catch((e) => {
                console.error('[dsh] auto-restart failed:', e.message)
              })
            } catch (e) {
              console.error('[dsh] auto-restart failed:', e.message)
            }
          }, delay)
        }
      }

      // Post-mortem: dump the exited process's recent output to the sandbox
      // so crash causes stay diagnosable after the fact (DSH only writes its
      // own startup-failure log for some paths; plain exits leave no trace).
      if (!wasIntentional) {
        try {
          const dumpDir = path.join(getSandboxRoot(), 'logs')
          fs.mkdirSync(dumpDir, { recursive: true })
          const dump = [
            `exit at: ${new Date().toISOString()}`,
            `code: ${code}`,
            `autoRestart: ${JSON.stringify(autoRestart)}`,
            `port: ${serverStatus.port}`,
            '--- stdout (tail) ---',
            stdoutBuffer.join('').slice(-8000),
            '--- stderr (tail) ---',
            stderrBuffer.join('').slice(-8000),
          ].join('\n')
          fs.writeFileSync(path.join(dumpDir, `dsh-exit-${Date.now()}.log`), dump, 'utf8')
        } catch { /* best-effort */ }
      }

      // Broadcast a custom event so the UI layer can react
      try {
        window.dispatchEvent(new CustomEvent('dsh-server-exited', { detail: { code, autoRestart } }))
      } catch { /* not in browser context */ }
    })

    dshProcess.on('error', (err) => {
      serverStatus.running = false
      serverStatus.pid = null
      dshWebUrl = null
      console.error('DSH server error:', err.message)
    })

    // Wait for the server to be ready, then for the tokenized entry URL
    // (printed AFTER ready — the race that used to show the 401 page).
    try {
      await this.waitForReady(SERVER_READY_TIMEOUT)
      if (profile === 'web') {
        const gotUrl = await this.waitForWebUrl(15000)
        console.log(gotUrl
          ? `[dsh] Web UI entry URL ready: ${dshWebUrl}`
          : '[dsh] no entry URL seen in output — trust guidance will handle it')
        if (gotUrl) {
          // Acquire the trust session SERVER-SIDE (SameSite=Strict cookies are
          // never attached by browsers inside cross-site iframes). Bounded so
          // a slow server cannot stall start(); the 401-retry in the bridge
          // proxy re-acquires lazily if this didn't finish in time.
          const acquired = await Promise.race([
            bridgeAcquireSession(),
            new Promise((r) => setTimeout(() => r(null), 6000)),
          ])
          console.log(`[dsh] bridge trust session: ${acquired === null ? '(still acquiring — lazy)' : acquired ? 'acquired' : 'not acquired (no token build?)'}`)
        }
      }
      return { success: true, url: this.getServerUrl() }
    } catch (err) {
      const stderr = stderrBuffer.join('')
      const stdout = stdoutBuffer.join('')
      // Build a more useful error message
      let errorMsg = err.message
      if (stderr) errorMsg += '\n--- stderr ---\n' + stderr.slice(-2000)
      if (stdout) errorMsg += '\n--- stdout ---\n' + stdout.slice(-2000)
      // Check for port conflict — suggest retry on different port
      const combined = stderr + stdout
      if (combined.includes('EADDRINUSE')) {
        errorMsg = `端口 ${port} 被占用。可能是之前的 DSH 服务器未正常关闭。\n请点击"重启"按钮重试，或关闭占用该端口的程序后重试。`
      }
      if (combined.includes('EACCES')) {
        const isWin = process.platform === 'win32'
        errorMsg = `端口 ${port} 访问被拒绝 (EACCES)。可能原因：\n` +
          (isWin
            ? `1. 防火墙拦截了 Node.js — 请检查 Windows 防火墙设置\n`
            : `1. 端口需要更高权限 — Unix 系统下 1024 以下端口需要 root\n`) +
          `2. 端口被系统保留 — 请尝试在设置中更换端口 (如 3081, 3180)\n` +
          (isWin
            ? `3. 权限不足 — 请尝试以管理员身份运行 uTools`
            : `3. 权限不足 — 请尝试在终端运行: sudo uTools 或更换端口`)
      }
      return {
        success: false,
        url: '',
        error: errorMsg,
        stderr: stderr.slice(-2000),
        stdout: stdout.slice(-2000),
      }
    }
  },

  /**
   * Stop the DSH server.
   * @returns {Promise<{ success: boolean }>}
   */
  async stop() {
    stopBridge()
    // Mark the upcoming exit as intentional — the crash auto-restart in the
    // exit handler must not respawn a user-stopped server.
    this._intentionalStop = true
    if (!dshProcess) return { success: true }

    return new Promise((resolve) => {
      let resolved = false
      const done = (result) => {
        if (!resolved) {
          resolved = true
          dshProcess = null
          serverStatus.running = false
          serverStatus.pid = null
          resolve(result)
        }
      }

      dshProcess.on('exit', () => done({ success: true }))

      // Try graceful shutdown
      try {
        dshProcess.kill('SIGTERM')
      } catch {
        done({ success: true })
        return
      }

      // Force kill after 5 seconds
      setTimeout(() => {
        if (dshProcess) {
          try {
            dshProcess.kill('SIGKILL')
          } catch { /* ignore */ }
          done({ success: true })
        }
      }, 5000)

      // Safety timeout
      setTimeout(() => done({ success: true }), 8000)
    })
  },

  /**
   * Restart the DSH server.
   * @param {object} options - Same as start()
   * @returns {Promise<{ success: boolean, url: string, error?: string }>}
   */
  async restart(options = {}) {
    const currentOpts = {
      port: serverStatus.port,
      workspace: serverStatus.workspace,
      profile: serverStatus.profile,
    }
    await this.stop()
    return this.start({ ...currentOpts, ...options })
  },

  /**
   * Get current server status.
   * @returns {{ running: boolean, port: number, pid: number|null, startTime: number|null, workspace: string|null, profile: string, uptime: number }}
   */
  getStatus() {
    return {
      ...serverStatus,
      uptime: serverStatus.startTime ? Date.now() - serverStatus.startTime : 0,
    }
  },

  /**
   * Recent server output (stdout + stderr tails), for the in-plugin log
   * viewer. Tokens in captured entry URLs are masked before display.
   * @returns {{ stdout: string, stderr: string, running: boolean }}
   */
  getServerLogs() {
    const mask = (s) => String(s).replace(/(token=)[A-Za-z0-9_-]+/g, '$1***')
    return {
      stdout: mask(stdoutBuffer.join('')),
      stderr: mask(stderrBuffer.join('')),
      running: !!serverStatus.running,
    }
  },

  /**
   * Health check — probe the DSH server.
   * @returns {Promise<{ healthy: boolean }>}
   */
  async healthCheck() {
    return new Promise((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: serverStatus.port,
        path: '/',
        timeout: HEALTH_CHECK_TIMEOUT,
      }, (res) => {
        // Any HTTP response means the server is up
        const statusCode = res.statusCode
        // 401 on the bare origin = DSH ≥0.2.0 browser-trust fence: the
        // authenticated entry URL (printed as "dsh web: http://...?token=…")
        // must be used, or the page shows the 401 text instead of the UI.
        resolve({ healthy: statusCode < 500, trustRequired: statusCode === 401 })
        res.destroy()
      })

      req.on('error', () => resolve({ healthy: false, trustRequired: false }))
      req.on('timeout', () => { req.destroy(); resolve({ healthy: false, trustRequired: false }) })
    })
  },

  /**
   * Probe an arbitrary port for a running HTTP service (used before
   * starting the server to detect leftover/external DSH instances).
   * @param {number} port
   * @returns {Promise<boolean>}
   */
  async probePort(port) {
    try {
      // Probe a DSH RPC endpoint and validate the response envelope, so we
      // only adopt a real DSH server — not any unrelated HTTP service that
      // happens to be listening on the configured port.
      // NOTE: DSH uses dot-separated endpoints (session.list), NOT slashes.
      const result = await httpRequest(
        'POST',
        '/api/session.list',
        {
          type: 'client-request',
          rpcId: String(Date.now()),
          method: 'session.list',
          payload: { args: {} },
        },
        port,
      )
      if (result.statusCode >= 400) return false
      const d = result.data
      return !!(d && d.result &&
        (d.result.ok !== undefined || d.result.value !== undefined || d.result.error !== undefined))
    } catch {
      return false
    }
  },

  /**
   * Wait for the DSH server to become ready.
   * @param {number} timeout - Maximum wait in milliseconds
   * @returns {Promise<boolean>}
   */
  async waitForReady(timeout = SERVER_READY_TIMEOUT) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      // Check if process exited
      if (dshProcess && dshProcess.exitCode !== null) {
        const stderr = stderrBuffer.join('').slice(-1000)
        const stdout = stdoutBuffer.join('').slice(-1000)
        const detail = stderr || stdout || '(no output)'
        throw new Error(`DSH process exited with code ${dshProcess.exitCode}. Output:\n${detail}`)
      }

      const { healthy } = await this.healthCheck()
      if (healthy) return true

      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL))
    }
    throw new Error(`DSH server did not become ready within ${timeout}ms`)
  },

  /**
   * Wait for the tokenized Web UI entry URL to appear in the process output.
   *
   * WHY: `dsh web` prints its entry URL ("dsh web: http://…?token=…") AFTER
   * the HTTP server is ready — waitForReady() therefore resolves BEFORE the
   * URL exists. If start() returned at that instant, the renderer's load()
   * would read a token-less getWebUrl() and the iframe would render the raw
   * "dsh web authentication required" 401 page. Waiting here closes the race
   * for every consumer (WebUI.open, toolbar buttons, MCP tools).
   *
   * Non-fatal: if nothing appears within the grace window (unexpected output
   * shape), return anyway — the trust-guidance panel in web-ui.js covers it.
   * @param {number} timeout - max wait in ms (default 15s)
   * @returns {Promise<boolean>} true when an entry URL was captured
   */
  async waitForWebUrl(timeout = 15000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (dshProcess && dshProcess.exitCode !== null) return !!dshWebUrl
      if (dshWebUrl) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return !!dshWebUrl
  },

  /**
   * Get the server URL. If the link bridge is running, returns the
   * bridge URL (which is where the iframe must connect to get the
   * injected link interceptor); otherwise returns the direct DSH URL.
   * @returns {string}
   */
  getServerUrl() {
    if (bridgeListenPort) {
      return `http://127.0.0.1:${bridgeListenPort}`
    }
    return `http://127.0.0.1:${serverStatus.port}`
  },

  /**
   * Get the direct DSH server URL (the configured port, without the
   * bridge). Use this for display, copy, and opening in an external
   * browser — it is the stable address the user expects to see.
   * @returns {string}
   */
  getDirectUrl() {
    return `http://127.0.0.1:${serverStatus.port}`
  },

  /**
   * Get the authenticated Web UI entry URL. Precedence:
   *   1. User-pasted entry URL (persisted per port in dbStorage — used when
   *      adopting an external DSH instance whose stdout we cannot read)
   *   2. Tokenized URL captured from our own process output (dshWebUrl)
   *   3. Bare bridge URL (works for DSH versions without the trust fence)
   * Direct-origin URLs are mapped onto the bridge origin (same path/query)
   * so the page keeps the injected bridge script.
   * @returns {string}
   */
  getWebUrl() {
    // 1. Persisted user entry (external/adopted server)
    let entry = null
    try {
      if (typeof utools !== 'undefined' && utools.dbStorage) {
        entry = utools.dbStorage.getItem(`dsh-web-entry-${serverStatus.port}`) || null
      }
    } catch { /* ignore */ }
    // 2. Captured from process output
    if (!entry) entry = dshWebUrl
    if (!entry) return this.getServerUrl()
    const targetOrigin = `http://127.0.0.1:${serverStatus.port}`
    if (bridgeListenPort && entry.startsWith(targetOrigin)) {
      return `http://127.0.0.1:${bridgeListenPort}` + entry.slice(targetOrigin.length)
    }
    return entry
  },

  /**
   * Set (or clear) a user-pasted Web UI entry URL for the current server
   * port. Used when the running DSH instance is external (adopted) and its
   * tokenized URL is only visible in whatever terminal started it.
   * @param {string} url - Full URL, e.g. http://127.0.0.1:3080/?token=xxx
   * @returns {{ ok: boolean, error?: string }}
   */
  setWebEntryUrl(url) {
    const raw = String(url || '').trim()
    if (!raw) {
      try {
        if (typeof utools !== 'undefined' && utools.dbStorage) {
          utools.dbStorage.removeItem(`dsh-web-entry-${serverStatus.port}`)
        }
      } catch { /* ignore */ }
      dshWebUrl = null
      return { ok: true }
    }
    // Validate: must be an http URL on a loopback host with the server's port
    const m = raw.match(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#][^\s]*)?$/i)
    if (!m) return { ok: false, error: 'URL 需形如 http://127.0.0.1:3080/?token=…' }
    const port = m[2] ? parseInt(m[2].slice(1), 10) : 80
    if (port !== serverStatus.port) {
      return { ok: false, error: `端口不匹配：当前服务器端口为 ${serverStatus.port}` }
    }
    const normalized = `http://127.0.0.1:${port}${m[3] || '/'}`
    try {
      if (typeof utools !== 'undefined' && utools.dbStorage) {
        utools.dbStorage.setItem(`dsh-web-entry-${port}`, normalized)
      }
    } catch { /* ignore */ }
    dshWebUrl = normalized
    console.log(`[dsh] user-set Web UI entry URL: ${normalized}`)
    // The pasted token may carry a NEW session — refresh the bridge jar so
    // forwarded requests are trusted without waiting for a 401-retry.
    if (bridgeServer) bridgeAcquireSession().catch(() => {})
    return { ok: true }
  },

  /**
   * Get the current workspace from uTools dbStorage.
   * @returns {string|null}
   */
  getWorkspace() {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      return utools.dbStorage.getItem('dsh-current-workspace') || null
    }
    return null
  },

  /**
   * Get recent stdout output.
   * @param {number} lines - Number of recent lines
   * @returns {string}
   */
  getStdout(lines = 500) {
    return stdoutBuffer.slice(-lines).join('')
  },

  /**
   * Get recent stderr output.
   * @param {number} lines - Number of recent lines
   * @returns {string}
   */
  getStderr(lines = 500) {
    return stderrBuffer.slice(-lines).join('')
  },

  /**
   * Adopt an externally-running DSH server (not started by us).
   * Starts the link bridge on a random port so the iframe still gets
   * the injected link interceptor even for external/leftover servers.
   * @param {number} port
   */
  async adoptExternal(port = DEFAULT_PORT) {
    serverStatus = {
      running: true,
      port,
      dshPort: port,
      pid: null,
      startTime: Date.now(),
      workspace: null,
      profile: DEFAULT_PROFILE,
    }
    // The external DSH already occupies `port`, so the bridge listens on
    // a random port and forwards to it. getServerUrl() then returns the
    // bridge URL so the iframe is guaranteed to get the injected script.
    try {
      await startBridge(0, port)
      console.log(`[dsh] adoptExternal: bridge ready at 127.0.0.1:${bridgeListenPort}`)
    } catch (err) {
      console.warn('[dsh] adoptExternal: bridge failed to start:', err.message)
    }
  },
}

// ------------------------------------------------------------
//  config — DSH configuration management
// ------------------------------------------------------------

window.dsh.config = {
  /**
   * Get the DSH home directory.
   * @returns {string}
   */
  getDshHome() {
    return getDshHome()
  },

  /**
   * Read settings.yaml.
   * @returns {object}
   */
  getSettings() {
    const settingsPath = path.join(getDshHome(), 'settings.yaml')
    try {
      if (!fs.existsSync(settingsPath)) return {}
      const content = fs.readFileSync(settingsPath, 'utf8')
      return parseSimpleYaml(content)
    } catch {
      return {}
    }
  },

  /**
   * Write settings.yaml.
   * @param {object} settings
   * @returns {boolean}
   */
  saveSettings(settings) {
    const dshHome = getDshHome()
    ensureDir(dshHome)
    const settingsPath = path.join(dshHome, 'settings.yaml')
    try {
      const yaml = stringifySimpleYaml(settings)
      fs.writeFileSync(settingsPath, yaml, 'utf8')
      return true
    } catch (err) {
      console.error('Failed to save settings:', err.message)
      return false
    }
  },

  /**
   * Read credentials file (redacted — keys are write-only in DSH).
   * @returns {object}
   */
  getCredentials() {
    const credPath = path.join(getDshHome(), '.credentials.yaml')
    try {
      if (!fs.existsSync(credPath)) return {}
      const content = fs.readFileSync(credPath, 'utf8')
      return parseSimpleYaml(content)
    } catch {
      return {}
    }
  },

  /**
   * Write credentials file.
   * @param {object} credentials
   * @returns {boolean}
   */
  saveCredentials(credentials) {
    const dshHome = getDshHome()
    ensureDir(dshHome)
    const credPath = path.join(dshHome, '.credentials.yaml')
    try {
      const yaml = stringifySimpleYaml(credentials)
      fs.writeFileSync(credPath, yaml, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (err) {
      console.error('Failed to save credentials:', err.message)
      return false
    }
  },

  /**
   * Save a DeepSeek API key.
   * @param {string} apiKey
   * @returns {boolean}
   */
  saveDeepSeekApiKey(apiKey) {
    // Store in credentials file
    const creds = this.getCredentials()
    if (!creds.deepseek) creds.deepseek = {}
    creds.deepseek.apiKey = apiKey
    return this.saveCredentials(creds)
  },

  /**
   * List available profiles.
   * @returns {string[]}
   */
  getProfiles() {
    const profilesDir = path.join(getDshHome(), 'profiles')
    try {
      if (!fs.existsSync(profilesDir)) return ['web', 'headless']
      const entries = fs.readdirSync(profilesDir, { withFileTypes: true })
      const profiles = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      // Always include built-in templates
      const builtins = ['web', 'headless']
      return [...new Set([...builtins, ...profiles])]
    } catch {
      return ['web', 'headless']
    }
  },

  /**
   * Dump the composed profile config tree (dsh --dump-config).
   * @param {string} profile
   * @param {boolean} defaultOnly
   * @returns {Promise<string>}
   */
  async dumpConfig(profile = 'web', defaultOnly = false) {
    return new Promise((resolve, reject) => {
      const npxInfo = resolveNpx()
      const nodeInfo = resolveNode()
      if (!npxInfo || !nodeInfo.path) {
        reject(new Error('Node.js 或 npx 不可用'))
        return
      }
      const args = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--profile', profile]
      if (defaultOnly) {
        args.push('--dump-default-config')
      } else {
        args.push('--dump-config')
      }

      const pathSep = process.platform === 'win32' ? ';' : ':'
      const systemPath = process.env.PATH || process.env.Path || ''
      exec(`"${npxInfo.cmd}" ${args.join(' ')}`, {
        encoding: 'utf8',
        timeout: 30000,
        cwd: getDshHome(),
        // Sandbox env: the dumped config must be THIS sandbox's composition,
        // not the user's ~/.dsh, and npx downloads stay in the private cache.
        env: {
          ...process.env,
          DSH_HOME: getDshHome(),
          npm_config_cache: getSandboxNpmCache(),
          PATH: path.dirname(nodeInfo.path) + pathSep + systemPath,
        },
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message))
        } else {
          resolve(stdout)
        }
      })
    })
  },
}

// ------------------------------------------------------------
//  openExternal — Open a URL in the system's default browser
// ------------------------------------------------------------

/**
 * Open a URL in the system's default browser.
 * @param {string} url
 */
// Dedup guard: one link click can reach openExternal from 2-3 layers at once
// (setWindowOpenHandler, legacy 'new-window', and the caller in web-ui.js).
// Collapse identical URLs that arrive within a short window to a single open.
window.dsh.__lastExternalOpenUrl = null
window.dsh.__lastExternalOpenTime = 0

window.dsh.openExternal = function (url) {
  const now = Date.now()
  if (url && url === window.dsh.__lastExternalOpenUrl && now - window.dsh.__lastExternalOpenTime < 1000) {
    return
  }
  window.dsh.__lastExternalOpenUrl = url
  window.dsh.__lastExternalOpenTime = now

  if (typeof utools !== 'undefined' && utools.shellOpenExternal) {
    utools.shellOpenExternal(url)
  } else {
    try {
      const { shell } = require('electron')
      if (shell && shell.openExternal) shell.openExternal(url)
    } catch (e) {
      console.error('Cannot open URL externally:', url, e)
    }
  }
}

// ------------------------------------------------------------
//  Intercept new-window / window.open from cross-origin iframes
//  so links open in the system browser, not new Electron windows.
// ------------------------------------------------------------

;(function setupIframeLinkInterception() {
  /**
   * Local DSH-family URL (loopback host, any port)? Those belong to the
   * DSH server / bridge inside the iframe — they must never pop the
   * system browser; the iframe's own link handling navigates them.
   */
  function isLocalUrl(url) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#]|$)/.test(String(url || ''))
  }

  /**
   * Attach a window-open handler to a webContents.
   * Catches window.open(), target="_blank", and middle-click-new-tab
   * from the DSH iframe (which is cross-origin, so JS injection fails).
   * Local URLs are denied silently (the iframe navigates itself); only
   * genuinely external URLs open in the system browser.
   */
  function hookWebContents(wc) {
    if (!wc || wc.__dshHooked) return
    wc.__dshHooked = true

    // Electron ≥ 15: setWindowOpenHandler
    if (typeof wc.setWindowOpenHandler === 'function') {
      wc.setWindowOpenHandler(({ url }) => {
        if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) {
          if (!isLocalUrl(url)) {
            window.dsh.openExternal(url)
          }
          // Local URLs: deny quietly — the iframe handles its own navigation.
        }
        return { action: 'deny' }
      })
      console.log('[dsh] webContents.setWindowOpenHandler attached')
    }

    // Legacy: 'new-window' event (Electron < 15)
    if (typeof wc.on === 'function') {
      wc.on('new-window', (event, url) => {
        if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) {
          event.preventDefault()
          if (!isLocalUrl(url)) {
            window.dsh.openExternal(url)
          }
        }
      })
      console.log('[dsh] webContents new-window listener attached')
    }
  }

  // Method 1: Try via @electron/remote (uTools uses this internally)
  try {
    const remote = require('@electron/remote') || require('electron').remote
    if (remote && remote.getCurrentWindow) {
      const win = remote.getCurrentWindow()
      hookWebContents(win.webContents)
    }
  } catch (e) {
    // remote not available — try other methods
  }

  // Method 2: Poll for iframe webContents via webFrame
  // The iframe's webContents appears as a child; we hook it when the
  // iframe is created (on WebUI.load). We expose a helper for JS to call.
  window.dsh.hookIframeLinks = function () {
    try {
      const remote = require('@electron/remote') || require('electron').remote
      if (remote && remote.getCurrentWindow) {
        const win = remote.getCurrentWindow()
        if (win.webContents) {
          // Hook the host webContents plus any child webContents (iframes)
          hookWebContents(win.webContents)
          if (typeof win.webContents.getAllWebContents === 'function') {
            for (const wc of win.webContents.getAllWebContents()) {
              hookWebContents(wc)
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Method 3: Re-hook after a delay (iframe may be created later)
  setTimeout(() => {
    try {
      const remote = require('@electron/remote') || require('electron').remote
      if (remote && remote.getCurrentWindow) {
        const win = remote.getCurrentWindow()
        // Also hook child webContents (iframes)
        if (win.webContents && win.webContents.getAllWebContents) {
          for (const wc of win.webContents.getAllWebContents()) {
            hookWebContents(wc)
          }
        }
      }
    } catch (e) { /* ignore */ }
  }, 3000)
})()

// ------------------------------------------------------------
//  workspace — Workspace management
// ------------------------------------------------------------

window.dsh.workspace = {
  /**
   * List saved workspaces from uTools dbStorage.
   * @returns {Array<{ path: string, name: string, lastUsed: number }>}
   */
  list() {
    // uTools dbStorage is available in the preload context
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      return utools.dbStorage.getItem('dsh-workspaces') || []
    }
    return []
  },

  /**
   * Add a workspace.
   * @param {string} dirPath
   * @returns {boolean}
   */
  add(dirPath) {
    const workspaces = this.list()
    const existing = workspaces.find((w) => w.path === dirPath)
    if (existing) {
      existing.lastUsed = Date.now()
    } else {
      workspaces.push({
        path: dirPath,
        name: path.basename(dirPath),
        lastUsed: Date.now(),
      })
    }
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      utools.dbStorage.setItem('dsh-workspaces', workspaces)
    }
    return true
  },

  /**
   * Remove a workspace.
   * @param {string} dirPath
   * @returns {boolean}
   */
  remove(dirPath) {
    const workspaces = this.list().filter((w) => w.path !== dirPath)
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      utools.dbStorage.setItem('dsh-workspaces', workspaces)
    }
    return true
  },

  /**
   * Validate that a path exists and is a directory.
   * @param {string} dirPath
   * @returns {boolean}
   */
  validate(dirPath) {
    try {
      return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
    } catch {
      return false
    }
  },

  /**
   * Export all settings + workspaces as a backup payload (for the settings
   * backup/restore feature). Includes every dsh-setting-* key and the
   * workspace list.
   * @returns {object}
   */
  exportBackup() {
    const settings = {}
    try {
      if (typeof utools !== 'undefined' && utools.dbStorage) {
        // dbStorage has no key enumeration; the known setting keys are a
        // small closed set owned by this plugin — list them explicitly.
        const KEYS = ['port', 'autoStart', 'autoOpenWebUI', 'backgroundRun', 'autoRestart', 'telemetryDisabled']
        for (const k of KEYS) {
          const v = utools.dbStorage.getItem(`dsh-setting-${k}`)
          if (v !== null && v !== undefined) settings[k] = v
        }
      }
    } catch { /* ignore */ }
    return {
      format: 'deepseek-harness-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      workspaces: this.list(),
      currentWorkspace: this.getCurrent(),
    }
  },

  /**
   * Restore settings + workspaces from a backup payload (see exportBackup).
   * Workspaces are merged (path-unique, existing lastUsed preserved); only
   * known setting keys are accepted.
   * @param {object} backup
   * @returns {{ settings: number, workspaces: number }}
   */
  importBackup(backup) {
    if (!backup || backup.format !== 'deepseek-harness-backup') {
      throw new Error('不是有效的 DeepSeek Harness 备份文件')
    }
    const KNOWN = ['port', 'autoStart', 'autoOpenWebUI', 'backgroundRun', 'autoRestart', 'telemetryDisabled']
    let nSettings = 0
    try {
      if (backup.settings && typeof backup.settings === 'object' && typeof utools !== 'undefined' && utools.dbStorage) {
        for (const k of KNOWN) {
          if (backup.settings[k] !== undefined) {
            utools.dbStorage.setItem(`dsh-setting-${k}`, backup.settings[k])
            nSettings++
          }
        }
      }
    } catch { /* ignore */ }
    let nWorkspaces = 0
    try {
      if (Array.isArray(backup.workspaces)) {
        const existing = this.list()
        const paths = new Set(existing.map((w) => w.path))
        for (const w of backup.workspaces) {
          if (w && typeof w.path === 'string' && w.path && !paths.has(w.path)) {
            existing.push({ path: w.path, name: w.name || path.basename(w.path), lastUsed: w.lastUsed || 0 })
            paths.add(w.path)
            nWorkspaces++
          }
        }
        if (typeof utools !== 'undefined' && utools.dbStorage) {
          utools.dbStorage.setItem('dsh-workspaces', existing)
        }
      }
    } catch { /* ignore */ }
    return { settings: nSettings, workspaces: nWorkspaces }
  },

  /**
   * Get the current/last-used workspace.
   * @returns {string|null}
   */
  getCurrent() {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      return utools.dbStorage.getItem('dsh-current-workspace') || null
    }
    return null
  },

  /**
   * Set the current workspace.
   * @param {string} dirPath
   * @returns {boolean}
   */
  setCurrent(dirPath) {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      utools.dbStorage.setItem('dsh-current-workspace', dirPath)
    }
    return true
  },
}

// ------------------------------------------------------------
//  cli — DSH CLI command wrappers
// ------------------------------------------------------------

window.dsh.cli = {
  /**
   * Run a headless task.
   * @param {string} task - Task description
   * @param {{ workspace?: string, model?: string, onOutput?: Function, onError?: Function }} options
   * @returns {Promise<{ success: boolean, output: string, error?: string }>}
   */
  async runHeadless(task, options = {}) {
    const {
      workspace = null,
      model,
      onOutput,
      onError,
    } = options

    const resolvedWorkspace = workspace || window.dsh.workspace.getCurrent() || getDshHome() || os.homedir()

    return new Promise((resolve) => {
      const globalDshBin = resolveGlobalDshBin()
      const npxInfo = resolveNpx()
      const nodeInfo = resolveNode()

      if (!globalDshBin && (!npxInfo || !nodeInfo.path)) {
        resolve({ success: false, output: '', error: 'Node.js 或 npx 不可用' })
        return
      }

      // Build command — prefer global DSH for speed (no npx round-trip)
      let cmd, cmdArgs, useShell
      const env = { ...process.env }
      // Sandbox isolation: DSH home + private npm cache (never ~/.dsh / ~/.npm)
      env.DSH_HOME = getDshHome()
      env.npm_config_cache = getSandboxNpmCache()
      if (nodeInfo.path) {
        const nodeDir = path.dirname(nodeInfo.path)
        const pathSep = process.platform === 'win32' ? ';' : ':'
        env.PATH = nodeDir + pathSep + (process.env.PATH || process.env.Path || '')
      }
      if (!env.npm_config_registry) {
        env.npm_config_registry = 'https://registry.npmmirror.com'
      }
      if (model) env.DSH_MODEL = model

      if (globalDshBin) {
        cmd = nodeInfo.path
        cmdArgs = [globalDshBin, '--profile', 'headless', task]
        useShell = false
      } else {
        cmd = npxInfo.cmd
        cmdArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--profile', 'headless', task]
        useShell = npxInfo.shell
      }

      let output = ''
      let errorOutput = ''

      const child = spawn(cmd, cmdArgs, {
        cwd: resolvedWorkspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      })

      child.stdout.on('data', (data) => {
        const text = data.toString()
        output += text
        if (onOutput) onOutput(text)
      })

      child.stderr.on('data', (data) => {
        const text = data.toString()
        errorOutput += text
        if (onError) onError(text)
      })

      child.on('exit', (code) => {
        resolve({
          success: code === 0,
          output: output.trim(),
          error: code !== 0 ? errorOutput.trim() : undefined,
        })
      })

      child.on('error', (err) => {
        resolve({
          success: false,
          output: output.trim(),
          error: err.message,
        })
      })
    })
  },

  /**
   * Run a dsh plugin command (forwards to pnpm).
   * @param {string} profile - Profile name
   * @param {string[]} args - pnpm arguments (e.g. ['add', '@scope/pkg'])
   * @param {{ onOutput?: Function, onError?: Function }} callbacks
   * @returns {Promise<{ success: boolean, output: string, error?: string }>}
   */
  async runPlugin(profile, args, callbacks = {}) {
    return new Promise((resolve) => {
      const globalDshBin = resolveGlobalDshBin()
      const npxInfo = resolveNpx()
      const nodeInfo = resolveNode()

      if (!globalDshBin && (!npxInfo || !nodeInfo.path)) {
        resolve({ success: false, output: '', error: 'Node.js 或 npx 不可用' })
        return
      }

      let cmd, cmdArgs, useShell
      const env = { ...process.env }
      // Sandbox isolation: DSH home + private npm cache (never ~/.dsh / ~/.npm)
      env.DSH_HOME = getDshHome()
      env.npm_config_cache = getSandboxNpmCache()
      if (nodeInfo.path) {
        const nodeDir = path.dirname(nodeInfo.path)
        const pathSep = process.platform === 'win32' ? ';' : ':'
        env.PATH = nodeDir + pathSep + (process.env.PATH || process.env.Path || '')
      }
      if (!env.npm_config_registry) {
        env.npm_config_registry = 'https://registry.npmmirror.com'
      }

      if (globalDshBin) {
        cmd = nodeInfo.path
        cmdArgs = [globalDshBin, 'plugin', '--profile', profile, ...args]
        useShell = false
      } else {
        cmd = npxInfo.cmd
        cmdArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', 'plugin', '--profile', profile, ...args]
        useShell = npxInfo.shell
      }

      let output = ''
      let errorOutput = ''

      const child = spawn(cmd, cmdArgs, {
        cwd: getDshHome(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      })

      child.stdout.on('data', (data) => {
        const text = data.toString()
        output += text
        if (callbacks.onOutput) callbacks.onOutput(text)
      })

      child.stderr.on('data', (data) => {
        const text = data.toString()
        errorOutput += text
        if (callbacks.onError) callbacks.onError(text)
      })

      child.on('exit', (code) => {
        resolve({
          success: code === 0,
          output: output.trim(),
          error: code !== 0 ? errorOutput.trim() : undefined,
        })
      })

      child.on('error', (err) => {
        resolve({
          success: false,
          output: output.trim(),
          error: err.message,
        })
      })
    })
  },

  /**
   * Get the DSH version.
   * @returns {string|null}
   */
  getVersion() {
    const nodeInfo = resolveNode()
    const globalDshBin = resolveGlobalDshBin()
    if (!nodeInfo.path) return null
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const env = { ...process.env, PATH: path.dirname(nodeInfo.path) + pathSep + (process.env.PATH || process.env.Path || '') }
    // Prefer global DSH (fast), fall back to npx
    if (globalDshBin) {
      try {
        const out = execSync(`"${nodeInfo.path}" "${globalDshBin}" --version`, {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, env,
        })
        return out.trim()
      } catch { /* fall through */ }
    }
    const npxInfo = resolveNpx()
    if (!npxInfo) return null
    try {
      const npxArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--version'].join(' ')
      const out = execSync(`"${npxInfo.cmd}" ${npxArgs}`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000, env,
      })
      return out.trim()
    } catch {
      return null
    }
  },

  /**
   * Check if DSH is installed (fast check — skips the slow npx probe,
   * see env.hasDshInstalled).
   * @returns {boolean}
   */
  isInstalled() {
    return window.dsh.env.hasDshInstalled({ skipNpx: true }).installed
  },

  /**
   * Get the sandbox DSH version (fast — reads the installed package.json,
   * no process spawn).
   * @returns {string|null}
   */
  getInstalledVersion() {
    try {
      const pkg = path.join(getSandboxRuntimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || null
    } catch { /* fall through */ }
    return null
  },

  /**
   * Latest DSH version on the registry (npm view, China mirror default).
   * @returns {Promise<string|null>}
   */
  async getLatestVersion() {
    const nodeInfo = resolveNode()
    if (!nodeInfo.path) return null
    const nodeBinDir = path.dirname(nodeInfo.path)
    const parentDir = path.dirname(nodeBinDir)
    const env = { ...process.env }
    env.npm_config_cache = getSandboxNpmCache()
    if (!env.npm_config_registry) env.npm_config_registry = 'https://registry.npmmirror.com'
    let npmInfo = null
    const npmCliWin = path.join(parentDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const npmCliUnix = path.join(parentDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(npmCliWin)) npmInfo = { cmd: nodeInfo.path, preArgs: [npmCliWin] }
    else if (fs.existsSync(npmCliUnix)) npmInfo = { cmd: nodeInfo.path, preArgs: [npmCliUnix] }
    else return null
    try {
      const out = execSync(`"${npmInfo.cmd}" ${npmInfo.preArgs.join(' ')} view @deepseek-ai/dsh version`.replace('"" ', '" "'), {
        encoding: 'utf8', timeout: 20000, env, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const v = String(out).trim()
      return v && /^\d/.test(v) ? v : null
    } catch {
      return null
    }
  },

  /**
   * Compare two semver strings (prerelease-aware for 0.x-rc versions).
   * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
   */
  compareVersions(a, b) {
    const parse = (v) => String(v || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
    const pa = parse(a)
    const pb = parse(b)
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return pa[i] > pb[i] ? 1 : -1
    }
    // Same numeric core: prerelease (0.2.0-rc.2) < release (0.2.0)
    const preA = String(a || '').includes('-')
    const preB = String(b || '').includes('-')
    if (preA !== preB) return preA ? -1 : 1
    return 0
  },

  /**
   * Install/update DSH via npx.
   * IMPORTANT: installs GLOBALLY (`npm install -g`) — the server prefers the
   * global `dsh` binary (resolveGlobalDshBin), so a plain `npx @deepseek-ai/dsh`
   * would only fill the npx cache and leave a stale global install in place.
   * That mismatch is exactly how "updated DSH but still runs the old version"
   * happens, so we update the global install first and only fall back to npx
   * when the global install fails (e.g. permission-restricted prefixes).
   * @param {{ onOutput?: Function }} callbacks
   * @returns {Promise<boolean>}
   */
  async install(callbacks = {}) {
    const nodeInfo = resolveNode()
    if (!nodeInfo.path) { return false }

    const env = { ...process.env }
    const pathSep = process.platform === 'win32' ? ';' : ':'
    env.PATH = path.dirname(nodeInfo.path) + pathSep + (process.env.PATH || process.env.Path || '')
    // Sandbox isolation: installs go into <sandbox>/runtime via --prefix and
    // downloads cache in <sandbox>/npm-cache — the user's system global npm
    // tree and ~/.npm cache are never touched.
    ensureSandboxDirs()
    env.DSH_HOME = getDshHome()
    env.npm_config_cache = getSandboxNpmCache()
    // Use China-friendly registry by default (user can override via .npmrc)
    if (!env.npm_config_registry) {
      env.npm_config_registry = 'https://registry.npmmirror.com'
    }

    // Resolve an npm invocation next to the chosen node (same layout as npx)
    const nodeBinDir = path.dirname(nodeInfo.path)
    const parentDir = path.dirname(nodeBinDir)
    let npmInfo = null
    const npmCliWin = path.join(parentDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const npmCliUnix = path.join(parentDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(npmCliWin)) npmInfo = { cmd: nodeInfo.path, preArgs: [npmCliWin], shell: false }
    else if (fs.existsSync(npmCliUnix)) npmInfo = { cmd: nodeInfo.path, preArgs: [npmCliUnix], shell: false }
    else if (hasCommand('npm') || hasCommand('npm.cmd')) {
      npmInfo = { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', preArgs: [], shell: true }
    }

    const runInstall = (spawnSpec) => new Promise((resolve) => {
      const child = spawn(spawnSpec.cmd, [...spawnSpec.preArgs, ...spawnSpec.args], {
        cwd: getDshHome(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: spawnSpec.shell,
      })
      let output = ''
      child.stdout.on('data', (data) => {
        const text = data.toString()
        output += text
        if (callbacks.onOutput) callbacks.onOutput(text)
      })
      child.stderr.on('data', (data) => {
        const text = data.toString()
        output += text
        if (callbacks.onOutput) callbacks.onOutput(text)
      })
      child.on('exit', (code) => resolve({ ok: code === 0, output }))
      child.on('error', () => resolve({ ok: false, output }))
    })

    // 1. Preferred: install/update into the plugin-managed sandbox runtime
    //    (<sandbox>/runtime/node_modules/@deepseek-ai/dsh). This is the copy
    //    resolveGlobalDshBin() runs — isolated from the user's global npm.
    if (npmInfo) {
      const result = await runInstall({
        cmd: npmInfo.cmd, preArgs: npmInfo.preArgs, shell: npmInfo.shell,
        args: ['install', '--prefix', getSandboxRuntimeDir(), '@deepseek-ai/dsh'],
      })
      if (result.ok) return true
      if (callbacks.onOutput) {
        callbacks.onOutput('\n[沙盒安装失败，回退到私有 npx 缓存模式]\n' + result.output.slice(-300))
      }
    }

    // 2. Fallback: npx into the PRIVATE cache (sandbox; never ~/.npm)
    const npxInfo = resolveNpx()
    if (!npxInfo) return false
    const result = await runInstall({
      cmd: npxInfo.cmd, preArgs: npxInfo.preArgs, shell: npxInfo.shell,
      args: ['--yes', '@deepseek-ai/dsh', '--version'],
    })
    return result.ok
  },
}

// ------------------------------------------------------------
//  api — HTTP API client for DSH server
// ------------------------------------------------------------

/**
 * Generic DSH RPC call. DSH uses POST /api/<namespace>.<method>
 * with a ClientRequest envelope body.
 * @param {string} method - e.g. 'session.list' (dot-separated)
 * @param {object} payload - request payload (wrapped in args field)
 * @returns {Promise<object>} response value
 */
async function rpc(method, payload = {}) {
  // DSH RPC wire format: endpoint uses '.' separator (session.list),
  // both in the URL path and in the method field of the envelope.
  const rpcId = crypto.randomUUID()
  const body = {
    type: 'client-request',
    rpcId,
    method,
    payload: { args: payload },
  }
  const result = await httpRequest('POST', `/api/${method}`, body)
  if (result.statusCode >= 400) {
    const errData = result.data
    const errMsg = errData?.result?.error?.message || errData?.error?.message || `HTTP ${result.statusCode}`
    throw new Error(`RPC ${method} failed: ${errMsg}`)
  }
  const data = result.data
  if (data?.result?.ok === false) {
    throw new Error(`RPC ${method} error: ${data.result.error?.message || 'unknown'}`)
  }
  return data?.result?.value ?? data
}

window.dsh.api = {
  // ----------------------------------------------------------
  //  Generic RPC and HTTP methods
  // ----------------------------------------------------------

  /**
   * Make a GET request to the DSH server.
   * @param {string} urlPath
   * @returns {Promise<object>}
   */
  async get(urlPath) {
    const result = await httpRequest('GET', urlPath)
    if (result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.data)}`)
    }
    return result.data
  },

  /**
   * Make a POST request to the DSH server.
   * @param {string} urlPath
   * @param {object} data
   * @returns {Promise<object>}
   */
  async post(urlPath, data) {
    const result = await httpRequest('POST', urlPath, data)
    if (result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.data)}`)
    }
    return result.data
  },

  /**
   * Generic DSH RPC call. DSH uses POST /api/<namespace>.<method>
   * with a JSON body containing the payload.
   * @param {string} method - e.g. 'session.list'
   * @param {object} payload - request payload
   * @returns {Promise<object>} response value
   */
  async rpc(method, payload = {}) {
    return rpc(method, payload)
  },

  // ----------------------------------------------------------
  //  session.* — Session management (12 methods)
  // ----------------------------------------------------------

  session: {
    /** List all sessions (attached + cold). */
    async list() { return rpc('session.list', {}) },

    /** Search session content. */
    async search(query, cursor) { return rpc('session.search', { query, cursor }) },

    /** Create a new session. opts: { workspaceId?, cwd?, agentPreset? } */
    async create(opts = {}) { return rpc('session.create', opts) },

    /** Get session history (paginated). */
    async history(sessionId, beforeSeq, maxMessages) {
      return rpc('session.history', { sessionId, beforeSeq, maxMessages })
    },

    /** Get models available to a session. */
    async models(sessionId) { return rpc('session.models', { sessionId }) },

    /** Select model for a session. */
    async selectModel(sessionId, provider, model, reasoningEffort) {
      return rpc('session.selectModel', { sessionId, provider, model, reasoningEffort })
    },

    /** Rename a session. */
    async rename(sessionId, title) { return rpc('session.rename', { sessionId, title }) },

    /** Fork a session at a given sequence. */
    async fork(sessionId, atSeq) { return rpc('session.fork', { sessionId, atSeq }) },

    /** Send a prompt to a session. content: string | PromptContentPart[] */
    async prompt(sessionId, content, timeZone) {
      return rpc('session.prompt', { sessionId, content, timeZone })
    },

    /** Attach an image to a session. */
    async attachment(sessionId, content) {
      return rpc('session.attachment', { sessionId, content })
    },

    /** Update queue item (edit/remove steering message). */
    async updateQueue(sessionId, itemId, action) {
      return rpc('session.updateQueue', { sessionId, itemId, action })
    },

    /** Cancel the current agent turn. */
    async cancel(sessionId) { return rpc('session.cancel', { sessionId }) },
  },

  // ----------------------------------------------------------
  //  subagent.* — Sub-agent management (4 methods)
  // ----------------------------------------------------------

  subagent: {
    /** List direct children of a parent session. */
    async list(parentSessionId) { return rpc('subagent.list', { parentSessionId }) },

    /** Get sub-agent history. */
    async history(parentSessionId, childSessionId, beforeSeq, maxMessages) {
      return rpc('subagent.history', { parentSessionId, childSessionId, beforeSeq, maxMessages })
    },

    /** Send a follow-up prompt to a sub-agent. */
    async prompt(parentSessionId, childSessionId, message) {
      return rpc('subagent.prompt', { parentSessionId, childSessionId, message })
    },

    /** Interrupt a running sub-agent. */
    async interrupt(parentSessionId, childSessionId) {
      return rpc('subagent.interrupt', { parentSessionId, childSessionId })
    },
  },

  // ----------------------------------------------------------
  //  host.* — Host operations (5 methods)
  // ----------------------------------------------------------

  host: {
    /** Describe host capabilities. */
    async describe() { return rpc('host.describe', {}) },

    /** Show a native directory picker. */
    async pickDirectory() { return rpc('host.pickDirectory', {}) },

    /** List directory contents. */
    async listDirectory(dirPath) { return rpc('host.listDirectory', { path: dirPath }) },

    /** Create a directory. */
    async createDirectory(dirPath) { return rpc('host.createDirectory', { path: dirPath }) },

    /** Open a file/folder with the system default application. */
    async openPath(filePath) { return rpc('host.openPath', { path: filePath }) },
  },

  // ----------------------------------------------------------
  //  workspace.* — DSH Workspace management (7 methods)
  // ----------------------------------------------------------

  workspace: {
    /** List all workspaces. */
    async list() { return rpc('workspace.list', {}) },

    /** Create a workspace from a path. */
    async create(dirPath) { return rpc('workspace.create', { path: dirPath }) },

    /** Rename a workspace. */
    async rename(workspaceId, title) { return rpc('workspace.rename', { workspaceId, title }) },

    /** Delete a workspace. */
    async delete(workspaceId) { return rpc('workspace.delete', { workspaceId }) },

    /** Reorder workspace position. */
    async insertBefore(workspaceId, beforeId) { return rpc('workspace.insertBefore', { workspaceId, beforeId }) },

    /** Move a session within workspace ordering. */
    async insertSessionBefore(workspaceId, sessionId, beforeSessionId) {
      return rpc('workspace.insertSessionBefore', { workspaceId, sessionId, beforeSessionId })
    },

    /** Archive (detach) a session from a workspace. */
    async archiveSession(workspaceId, sessionId) {
      return rpc('workspace.archiveSession', { workspaceId, sessionId })
    },
  },

  // ----------------------------------------------------------
  //  skill.* — Skill listing (1 method)
  // ----------------------------------------------------------

  skill: {
    /** List all available skills. */
    async list() { return rpc('skill.list', {}) },
  },

  // ----------------------------------------------------------
  //  agentPreset.* — Agent preset management (6 methods)
  // ----------------------------------------------------------

  agentPreset: {
    /** List all agent presets. */
    async list() { return rpc('agentPreset.list', {}) },

    /** Select a preset for a session. */
    async select(sessionId, presetId) { return rpc('agentPreset.select', { sessionId, presetId }) },

    /** Read a preset's configuration. */
    async read(presetId) { return rpc('agentPreset.read', { presetId }) },

    /** Copy a preset to a new id. */
    async copy(presetId, newId) { return rpc('agentPreset.copy', { presetId, newId }) },

    /** Open a preset's document. */
    async openDocument(presetId) { return rpc('agentPreset.openDocument', { presetId }) },

    /** Remove a preset. */
    async remove(presetId) { return rpc('agentPreset.remove', { presetId }) },
  },

  // ----------------------------------------------------------
  //  goal.* — Goal management (6 methods)
  // ----------------------------------------------------------

  goal: {
    /** Create a goal for a session. */
    async create(sessionId, objective) { return rpc('goal.create', { sessionId, objective }) },

    /** Edit a goal's objective. */
    async edit(sessionId, goalId, objective) { return rpc('goal.edit', { sessionId, goalId, objective }) },

    /** Pause a goal. */
    async pause(sessionId, goalId) { return rpc('goal.pause', { sessionId, goalId }) },

    /** Resume a paused goal. */
    async resume(sessionId, goalId) { return rpc('goal.resume', { sessionId, goalId }) },

    /** Mark a goal as complete. */
    async complete(sessionId, goalId) { return rpc('goal.complete', { sessionId, goalId }) },

    /** Clear all goals for a session. */
    async clear(sessionId) { return rpc('goal.clear', { sessionId }) },
  },

  // ----------------------------------------------------------
  //  settings.* — Settings management (5 methods)
  // ----------------------------------------------------------

  settings: {
    /** Describe settings namespaces. Pass ns for a specific one. */
    async describe(ns) { return rpc('settings.describe', { ns }) },

    /** Open a settings document. */
    async openDocument(ns) { return rpc('settings.openDocument', { ns }) },

    /** Update settings (merge ops). */
    async update(ns, ops, expectedRevision) { return rpc('settings.update', { ns, ops, expectedRevision }) },

    /** Replace an entire settings namespace value. */
    async replace(ns, value, expectedRevision) { return rpc('settings.replace', { ns, value, expectedRevision }) },

    /** Mutate a provider's apiKey/baseURL. */
    async mutate(ns, apiKey, baseURL) { return rpc('settings.mutate', { ns, apiKey, baseURL }) },
  },

  // ----------------------------------------------------------
  //  credentials.* — Credential management (3 methods)
  // ----------------------------------------------------------

  credentials: {
    /** Describe all credentials (redacted). */
    async describe() { return rpc('credentials.describe', {}) },

    /** Set a credential value. */
    async set(ref, value) { return rpc('credentials.set', { ref, value }) },

    /** Unset a credential. */
    async unset(ref) { return rpc('credentials.unset', { ref }) },
  },

  // ----------------------------------------------------------
  //  llm.* — LLM provider/model management (3 methods)
  // ----------------------------------------------------------

  llm: {
    /** List all LLM providers. */
    async providers() { return rpc('llm.providers', {}) },

    /** List all models across providers. */
    async models() { return rpc('llm.models', {}) },

    /** Discover available models from a provider endpoint. */
    async discoverModels(ns, baseURL, apiKey) { return rpc('llm.discoverModels', { ns, baseURL, apiKey }) },
  },

  // ----------------------------------------------------------
  //  Backward-compatible convenience methods
  //  (delegate to the new domain methods above)
  // ----------------------------------------------------------

  /**
   * List sessions — tries RPC, falls back to filesystem scan.
   * @returns {Promise<Array>}
   */
  async listSessions() {
    try {
      return await this.session.list()
    } catch {
      return this._scanSessionsFromFilesystem()
    }
  },

  /**
   * Get session details — tries RPC, falls back to filesystem.
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async getSession(sessionId) {
    try {
      return await this.session.history(sessionId)
    } catch {
      return this._readSessionFromFile(sessionId)
    }
  },

  /**
   * Create a new session.
   * @param {{ workspace?: string, model?: string }} options
   * @returns {Promise<object>}
   */
  async createSession(options = {}) {
    return await this.session.create(options)
  },

  /**
   * Send a message to a session.
   * @param {string} sessionId
   * @param {string} message
   * @returns {Promise<object>}
   */
  async sendMessage(sessionId, message) {
    return await this.session.prompt(sessionId, message)
  },

  /**
   * List workspaces known to the server.
   * @returns {Promise<Array>}
   */
  async listWorkspaces() {
    try {
      return await this.workspace.list()
    } catch {
      return []
    }
  },

  /**
   * Get configured models.
   * @returns {Promise<Array>}
   */
  async getModels() {
    try {
      return await this.llm.models()
    } catch {
      return []
    }
  },

  // ----------------------------------------------------------
  //  Filesystem fallback methods (for when server is down)
  // ----------------------------------------------------------

  /**
   * Scan session directory for session files.
   * @returns {Array}
   * @private
   */
  _scanSessionsFromFilesystem() {
    const sessionRoot = path.join(getDshHome(), 'sessions')
    try {
      if (!fs.existsSync(sessionRoot)) return []

      const sessions = []
      const scanDir = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            scanDir(fullPath)
          } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) {
            const stat = fs.statSync(fullPath)
            sessions.push({
              id: entry.name.replace(/\.(jsonl?|json)$/, ''),
              path: fullPath,
              modified: stat.mtime.toISOString(),
              size: stat.size,
            })
          }
        }
      }
      scanDir(sessionRoot)
      return sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified))
    } catch {
      return []
    }
  },

  /**
   * Read a session from a JSONL file.
   * @param {string} sessionId
   * @returns {object}
   * @private
   */
  _readSessionFromFile(sessionId) {
    const sessionRoot = path.join(getDshHome(), 'sessions')
    try {
      const findFile = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            const found = findFile(fullPath)
            if (found) return found
          } else if (entry.name.includes(sessionId)) {
            return fullPath
          }
        }
        return null
      }

      const filePath = findFile(sessionRoot)
      if (!filePath) return { id: sessionId, messages: [] }

      const content = fs.readFileSync(filePath, 'utf8')
      const messages = []

      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          messages.push(JSON.parse(line))
        } catch { /* skip */ }
      }

      return { id: sessionId, messages, path: filePath }
    } catch {
      return { id: sessionId, messages: [] }
    }
  },
}

// ------------------------------------------------------------
//  fs — File system operations
// ------------------------------------------------------------

window.dsh.fs = {
  /**
   * Read a file.
   * @param {string} filePath
   * @returns {string}
   */
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      throw new Error(`Failed to read file: ${err.message}`)
    }
  },

  /**
   * Write a file.
   * @param {string} filePath
   * @param {string} content
   * @returns {boolean}
   */
  writeFile(filePath, content) {
    try {
      const dir = path.dirname(filePath)
      ensureDir(dir)
      fs.writeFileSync(filePath, content, 'utf8')
      return true
    } catch (err) {
      throw new Error(`Failed to write file: ${err.message}`)
    }
  },

  /**
   * Check if a path exists.
   * @param {string} filePath
   * @returns {boolean}
   */
  exists(filePath) {
    return fs.existsSync(filePath)
  },

  /**
   * Check if a path is a directory.
   * @param {string} dirPath
   * @returns {boolean}
   */
  isDir(dirPath) {
    try {
      return fs.statSync(dirPath).isDirectory()
    } catch {
      return false
    }
  },

  /**
   * List directory contents.
   * @param {string} dirPath
   * @returns {Array<{ name: string, isDir: boolean }>}
   */
  listDir(dirPath) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      return []
    }
  },

  /**
   * Join path segments.
   * @param {...string} paths
   * @returns {string}
   */
  joinPath(...paths) {
    return path.join(...paths)
  },

  /**
   * Show a native directory picker dialog via uTools API.
   * @returns {string|null} Selected directory path, or null if cancelled.
   */
  showOpenDialog() {
    // uTools provides its own showOpenDialog (synchronous, available in preload)
    if (typeof utools !== 'undefined' && utools.showOpenDialog) {
      const result = utools.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择工作区目录',
      })
      if (result && result.length > 0) {
        return result[0]
      }
      return null
    }
    // Fallback: try Electron dialog (async)
    try {
      const { dialog } = require('electron')
      // dialog.showOpenDialog is async but uTools preload is synchronous context;
      // use showOpenDialogSync if available
      if (dialog.showOpenDialogSync) {
        const result = dialog.showOpenDialogSync({
          properties: ['openDirectory'],
          title: '选择工作区目录',
        })
        if (result && result.length > 0) {
          return result[0]
        }
      }
    } catch { /* not available */ }
    return null
  },
}

// ------------------------------------------------------------
//  utoolsAi — uTools AI ecosystem bridge
// ------------------------------------------------------------

window.dsh.utoolsAi = {
  /**
   * Check if uTools AI API is available (uTools >= 7.0).
   * @returns {boolean}
   */
  isAvailable() {
    return typeof utools !== 'undefined' && typeof utools.ai === 'function'
  },

  /**
   * Get all AI models registered in uTools.
   * @returns {Promise<Array<{id:string,label:string,description:string,icon:string,cost:number}>>}
   */
  async getModels() {
    if (typeof utools !== 'undefined' && utools.allAiModels) {
      try {
        return await utools.allAiModels()
      } catch {
        return []
      }
    }
    return []
  },

  /**
   * Stream a chat completion via uTools AI.
   * @param {Array<{role:string,content:string}>} messages
   * @param {string} [model] - Model ID (empty = default deepseek-v3)
   * @param {Array} [tools] - Function Calling tools
   * @param {(chunk:string)=>void} [onChunk] - Stream callback
   * @returns {Promise<{content:string}>}
   */
  async chat(messages, model, tools, onChunk) {
    if (!this.isAvailable()) {
      throw new Error('uTools AI 不可用 (需要 uTools 7.0+)')
    }
    const option = { messages }
    if (model) option.model = model
    if (tools && tools.length > 0) option.tools = tools

    if (onChunk) {
      let fullContent = ''
      await utools.ai(option, (chunk) => {
        if (chunk && chunk.content) {
          fullContent += chunk.content
          onChunk(chunk.content)
        }
      })
      return { content: fullContent }
    }
    const result = await utools.ai(option)
    return { content: (result && result.content) || '' }
  },
}

// ============================================================
//  MCP Tool Registration — expose DSH capabilities to uTools AI Agent
//  Must run at preload init, NOT inside onPluginEnter.
// ============================================================

// Read the user's configured port from uTools dbStorage (mirrors the
// renderer's App.getSetting('port', 3080)). Used by MCP tools that run in
// this preload context without renderer access.
function readPortSetting() {
  try {
    if (typeof utools !== 'undefined' && utools.dbStorage) {
      const v = utools.dbStorage.getItem('dsh-setting-port')
      if (v) return parseInt(v, 10) || 3080
    }
  } catch { /* ignore */ }
  return 3080
}

if (typeof utools !== 'undefined' && utools.registerTool) {
  try {

  utools.registerTool('dsh_run_headless', async (params, ctx) => {
    const { task, workspace } = params
    ctx?.sendProgress?.({ progress: 0, total: 1, message: '正在启动 DSH…' })

    const status = window.dsh.server.getStatus()
    if (!status.running) {
      const ws = workspace || window.dsh.workspace.getCurrent()
      await window.dsh.server.start({ workspace: ws, port: 3080, profile: 'web' })
    }

    ctx?.sendProgress?.({ progress: 0, total: 1, message: '任务执行中…' })

    const result = await window.dsh.cli.runHeadless(task, {
      workspace: workspace || window.dsh.workspace.getCurrent(),
    })

    if (result.success) {
      return { success: true, output: result.output }
    }
    throw new Error(result.error || '任务执行失败')
  })

  utools.registerTool('dsh_list_sessions', async (params) => {
    const { query } = params || {}
    try {
      if (query) {
        return await window.dsh.api.session.search(query)
      }
      return await window.dsh.api.session.list()
    } catch (err) {
      throw new Error('无法获取会话列表: ' + err.message)
    }
  })

  utools.registerTool('dsh_read_file', async (params) => {
    const { path: filePath } = params
    if (!window.dsh.fs.exists(filePath)) {
      throw new Error(`文件不存在: ${filePath}`)
    }
    const content = window.dsh.fs.readFile(filePath)
    if (content.length > 50000) {
      return content.slice(0, 50000) + '\n\n... (已截断，总长度: ' + content.length + ')'
    }
    return content
  })

  utools.registerTool('dsh_search_sessions', async (params) => {
    const { query } = params
    return await window.dsh.api.session.search(query)
  })

  utools.registerTool('dsh_get_server_status', async () => {
    const status = window.dsh.server.getStatus()
    return {
      running: status.running,
      url: window.dsh.server.getDirectUrl(),
      port: status.port,
      pid: status.pid,
      uptime: status.uptime,
      workspace: status.workspace,
    }
  })

  utools.registerTool('dsh_stop_server', async () => {
    const status = window.dsh.server.getStatus()
    if (!status.running) {
      return { success: true, message: '服务器未运行，无需停止' }
    }
    const res = await window.dsh.server.stop()
    return { success: res.success !== false, message: 'DSH 服务器已停止' }
  })

  utools.registerTool('dsh_restart_server', async () => {
    const status = window.dsh.server.getStatus()
    const workspace = status.workspace || window.dsh.server.getWorkspace()
    const port = status.port || readPortSetting()
    const profile = status.profile || 'web'
    if (status.running) {
      await window.dsh.server.stop()
    }
    const res = await window.dsh.server.start({ workspace, port, profile })
    if (res && res.success === false) throw new Error(res.error || '重启失败')
    return { success: true, message: 'DSH 服务器已重启', url: res.url }
  })

  utools.registerTool('dsh_create_session', async (params) => {
    const { workspace, model } = params || {}
    if (!window.dsh.server.getStatus().running) {
      throw new Error('DSH 服务器未运行，请先启动（dsh_restart_server）')
    }
    const session = await window.dsh.api.createSession({ workspace, model })
    return { success: true, session }
  })

  utools.registerTool('dsh_send_message', async (params) => {
    const { sessionId, message } = params
    if (!sessionId || !message) throw new Error('需要 sessionId 和 message 参数')
    if (!window.dsh.server.getStatus().running) {
      throw new Error('DSH 服务器未运行，请先启动（dsh_restart_server）')
    }
    const result = await window.dsh.api.sendMessage(sessionId, message)
    return { success: true, result }
  })

  utools.registerTool('dsh_update_dsh', async (params, ctx) => {
    ctx?.sendProgress?.({ progress: 0, total: 1, message: '正在安装/更新 DSH（可能需几分钟）…' })
    const ok = await window.dsh.cli.install({})
    if (!ok) throw new Error('DSH 安装/更新失败')
    return { success: true, message: 'DSH 安装/更新完成，重启服务器后生效' }
  })

  } catch (e) {
    console.error('[dsh] MCP tool registration failed:', e.message)
  }
}

// ============================================================
//  Cleanup on exit
// ============================================================

// Ensure DSH server is stopped when uTools exits
// (unless background mode is enabled)
process.on('beforeExit', () => {
  if (dshProcess && serverStatus.running) {
    try {
      dshProcess.kill('SIGTERM')
    } catch { /* ignore */ }
  }
})
