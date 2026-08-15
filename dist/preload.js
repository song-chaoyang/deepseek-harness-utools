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

// ============================================================
//  Constants
// ============================================================

const DEFAULT_PORT = 3080
const DEFAULT_PROFILE = 'web'
const HEALTH_CHECK_TIMEOUT = 3000
const SERVER_READY_TIMEOUT = 60000 // 1 minute (npx cache hit is fast)
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

// ============================================================
//  Utilities
// ============================================================

/**
 * Get the DSH home directory ($DSH_HOME or ~/.dsh).
 * @returns {string}
 */
function getDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Get the plugin's runtime data directory.
 * Bundled Node.js ships in the plugin's own `runtime/node/` folder;
 * downloaded runtimes go to uTools userData/runtime/node.
 * @returns {string}
 */
function getRuntimeDir() {
  // 1. Bundled Node.js in the plugin directory itself (shipped in the package)
  const pluginDir = __dirname
  const bundledDir = path.join(pluginDir, 'runtime')
  if (fs.existsSync(path.join(bundledDir, 'node', 'node.exe')) ||
      fs.existsSync(path.join(bundledDir, 'node', 'bin', 'node'))) {
    return bundledDir
  }
  // 2. Downloaded Node.js in uTools userData
  if (typeof utools !== 'undefined' && utools.getPath) {
    try {
      return path.join(utools.getPath('userData'), 'runtime')
    } catch { /* fallthrough */ }
  }
  return path.join(os.homedir(), '.dsh', 'utools-runtime')
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
 * Resolve the best available Node.js: bundled first, then system.
 * @returns {{ path: string|null, version: string|null, source: 'bundled'|'system'|null }}
 */
function resolveNode() {
  // 1. Bundled
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
  // 2. System
  try {
    const out = execSync('node --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
    const ver = out.trim()
    if (versionGte(ver, '24.0.0')) {
      const which = process.platform === 'win32' ? 'where' : 'which'
      const resolved = execSync(`${which} node`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0].trim()
      return { path: resolved, version: ver, source: 'system' }
    }
    return { path: null, version: ver, source: null }
  } catch {
    return { path: null, version: null, source: null }
  }
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
    // Use bundled node.exe directly to run npx-cli.js (avoids .cmd shell issues)
    const npxCli = path.join(path.dirname(bundled.node), 'node_modules', 'npm', 'bin', 'npx-cli.js')
    if (fs.existsSync(npxCli)) {
      return { cmd: bundled.node, preArgs: [npxCli], shell: false }
    }
    // Fallback: npx.cmd path (requires shell:true)
    if (bundled.npx) {
      return { cmd: bundled.npx, preArgs: [], shell: true }
    }
  }
  // System npx
  if (hasCommand('npx') || hasCommand('npx.cmd')) {
    return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', preArgs: [], shell: true }
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
  const url = `https://nodejs.org/dist/${version}/${filename}`
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

  // Download
  onProgress(`正在下载 Node.js ${version} (${platform}-${arch})...`)
  try {
    await downloadFile(url, archivePath, (recv, tot) => {
      if (tot > 0) onProgress(`下载中... ${Math.round((recv / tot) * 100)}%`)
    })
  } catch (err) {
    return { success: false, path: '', error: `下载失败: ${err.message}` }
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
      for (const item of fs.readdirSync(subDir)) {
        fs.renameSync(path.join(subDir, item), path.join(nodeDir, item))
      }
      fs.rmdirSync(subDir)
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
   * @returns {{ installed: boolean, version: string|null, method: string|null }}
   */
  hasDshInstalled() {
    const npxInfo = resolveNpx()
    const nodeInfo = resolveNode()

    // Check global install
    try {
      const out = execSync('dsh --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
      return { installed: true, version: out.trim(), method: 'global' }
    } catch { /* not global */ }

    // Check via npx
    if (npxInfo && nodeInfo.path) {
      try {
        const npxArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--version'].join(' ')
        const out = execSync(`"${npxInfo.cmd}" ${npxArgs}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
          timeout: 30000,
          env: { ...process.env, PATH: path.dirname(nodeInfo.path) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || '') },
        })
        return { installed: true, version: out.trim(), method: 'npx' }
      } catch { /* npx failed */ }
    }

    return { installed: false, version: null, method: null }
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
    const {
      port = DEFAULT_PORT,
      workspace = process.cwd(),
      profile = DEFAULT_PROFILE,
      patches = [],
    } = options

    // If already running, check if same config
    if (dshProcess && serverStatus.running) {
      if (serverStatus.port === port && serverStatus.workspace === workspace) {
        return { success: true, url: `http://127.0.0.1:${port}` }
      }
      await this.stop()
    }

    // Reset buffers
    stdoutBuffer = []
    stderrBuffer = []

    // Yield before synchronous execSync calls to let UI render
    await new Promise(r => setTimeout(r, 0))

    // Determine the command to run — use bundled or system npx
    const npxInfo = resolveNpx()
    const nodeInfo = resolveNode()

    // Debug: log resolved paths to console for troubleshooting
    console.log('[dsh] resolveNpx:', JSON.stringify(npxInfo))
    console.log('[dsh] resolveNode:', JSON.stringify(nodeInfo))

    if (!npxInfo || !nodeInfo.path) {
      // Last resort: try system npx directly
      return {
        success: false,
        url: '',
        error: `Node.js 或 npx 不可用。npxInfo=${JSON.stringify(npxInfo)}, nodeInfo=${JSON.stringify(nodeInfo)}`,
      }
    }

    // Build command arguments
    const cmdArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh']
    if (profile === 'web') {
      cmdArgs.push('web')
    } else {
      cmdArgs.push('--profile', profile)
    }

    if (port !== DEFAULT_PORT) {
      cmdArgs.push('--port', String(port))
    }

    for (const patch of patches) {
      cmdArgs.push('--patch', patch)
    }

    // Environment variables — prepend bundled node dir to PATH
    const env = { ...process.env }
    env.DSH_HOME = getDshHome()
    const nodeDir = path.dirname(nodeInfo.path)
    const pathSep = process.platform === 'win32' ? ';' : ':'
    // Ensure PATH includes system paths + bundled node
    const systemPath = process.env.PATH || process.env.Path || ''
    env.PATH = nodeDir + pathSep + systemPath
    // Windows needs ComSpec for .cmd/.bat execution
    if (process.platform === 'win32' && !env.ComSpec) {
      env.ComSpec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    }

    try {
      dshProcess = spawn(npxInfo.cmd, cmdArgs, {
        cwd: workspace || process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: npxInfo.shell,
      })
    } catch (err) {
      return { success: false, url: '', error: `Failed to spawn process: ${err.message}` }
    }

    serverStatus = {
      running: true,
      port,
      pid: dshProcess.pid,
      startTime: Date.now(),
      workspace,
      profile,
    }

    // Capture stdout for debugging
    dshProcess.stdout.on('data', (data) => {
      const text = data.toString()
      stdoutBuffer.push(text)
      if (stdoutBuffer.length > 500) stdoutBuffer.shift()
    })

    // Capture stderr for debugging
    dshProcess.stderr.on('data', (data) => {
      const text = data.toString()
      stderrBuffer.push(text)
      if (stderrBuffer.length > 500) stderrBuffer.shift()
    })

    // Handle process exit
    dshProcess.on('exit', (code) => {
      serverStatus.running = false
      serverStatus.pid = null
      console.log(`[dsh] server process exited (code=${code})`)
      // Broadcast a custom event so the UI layer can react
      try {
        window.dispatchEvent(new CustomEvent('dsh-server-exited', { detail: { code } }))
      } catch { /* not in browser context */ }
    })

    dshProcess.on('error', (err) => {
      serverStatus.running = false
      serverStatus.pid = null
      console.error('DSH server error:', err.message)
    })

    // Wait for the server to be ready
    try {
      await this.waitForReady(SERVER_READY_TIMEOUT)
      return { success: true, url: `http://127.0.0.1:${port}` }
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
        resolve({ healthy: res.statusCode < 500 })
        res.destroy()
      })

      req.on('error', () => resolve({ healthy: false }))
      req.on('timeout', () => { req.destroy(); resolve({ healthy: false }) })
    })
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
   * Get the server URL.
   * @returns {string}
   */
  getServerUrl() {
    return `http://127.0.0.1:${serverStatus.port}`
  },

  /**
   * Get recent stdout output.
   * @param {number} lines - Number of recent lines
   * @returns {string}
   */
  getStdout(lines = 50) {
    return stdoutBuffer.slice(-lines).join('')
  },

  /**
   * Get recent stderr output.
   * @param {number} lines - Number of recent lines
   * @returns {string}
   */
  getStderr(lines = 50) {
    return stderrBuffer.slice(-lines).join('')
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
      exec(`"${npxInfo.cmd}" ${args.join(' ')}`, {
        encoding: 'utf8',
        timeout: 30000,
        cwd: process.cwd(),
        env: { ...process.env, PATH: path.dirname(nodeInfo.path) + pathSep + (process.env.PATH || '') },
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
      workspace = process.cwd(),
      model,
      onOutput,
      onError,
    } = options

    return new Promise((resolve) => {
      const npxInfo = resolveNpx()
      const args = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--profile', 'headless', task]

      let output = ''
      let errorOutput = ''

      const child = spawn(npxInfo.cmd, args, {
        cwd: workspace,
        env: { ...process.env, ...(model ? { DSH_MODEL: model } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: npxInfo.shell,
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
      const npxInfo = resolveNpx()
      const cmdArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', 'plugin', '--profile', profile, ...args]

      let output = ''
      let errorOutput = ''

      const child = spawn(npxInfo.cmd, cmdArgs, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: npxInfo.shell,
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
    const npxInfo = resolveNpx()
    const nodeInfo = resolveNode()
    if (!npxInfo || !nodeInfo.path) return null
    try {
      const npxArgs = [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--version'].join(' ')
      const out = execSync(`"${npxInfo.cmd}" ${npxArgs}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 30000,
        env: { ...process.env, PATH: path.dirname(nodeInfo.path) + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH || '') },
      })
      return out.trim()
    } catch {
      return null
    }
  },

  /**
   * Check if DSH is installed.
   * @returns {boolean}
   */
  isInstalled() {
    return window.dsh.env.hasDshInstalled().installed
  },

  /**
   * Install/update DSH via npx.
   * @param {{ onOutput?: Function }} callbacks
   * @returns {Promise<boolean>}
   */
  async install(callbacks = {}) {
    return new Promise((resolve) => {
      const npxInfo = resolveNpx()
      // Running npx with the package will trigger install
      const child = spawn(npxInfo.cmd, [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--version'], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: npxInfo.shell,
      })

      let output = ''
      child.stdout.on('data', (data) => {
        output += data.toString()
        if (callbacks.onOutput) callbacks.onOutput(data.toString())
      })
      child.stderr.on('data', (data) => {
        output += data.toString()
        if (callbacks.onOutput) callbacks.onOutput(data.toString())
      })

      child.on('exit', (code) => {
        resolve(code === 0)
      })
      child.on('error', () => resolve(false))
    })
  },
}

// ------------------------------------------------------------
//  api — HTTP API client for DSH server
// ------------------------------------------------------------

/**
 * Generic DSH RPC call. DSH uses POST /api/<namespace>.<method>
 * with a JSON body containing the payload.
 * @param {string} method - e.g. 'session.list'
 * @param {object} payload - request payload
 * @returns {Promise<object>} response value
 */
async function rpc(method, payload = {}) {
  const result = await httpRequest('POST', `/api/${method}`, payload)
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
