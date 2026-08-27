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
 * Resolve the globally-installed DSH CLI entry (npm global install).
 * Returns the absolute path to `@deepseek-ai/dsh/lib/bin.js`, or null when
 * DSH is not installed globally. Using this directly avoids the slow
 * npx registry round-trip on every server start.
 * @returns {string|null}
 */
function resolveGlobalDshBin() {
  const nodeInfo = resolveNode()
  if (!nodeInfo.path) return null

  // 1. Try npm root -g with the resolved node's npm
  try {
    const nodeBinDir = path.dirname(nodeInfo.path)
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const systemPath = process.env.PATH || process.env.Path || ''
    const env = { ...process.env, PATH: nodeBinDir + pathSep + systemPath }
    // Try npm from same bin/ dir as node
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const npmPath = path.join(nodeBinDir, npmBin)
    const npmCmd = fs.existsSync(npmPath) ? `"${nodeInfo.path}" "${path.join(nodeBinDir.endsWith('bin') ? path.dirname(nodeBinDir) : nodeBinDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')}"` : `"${npmBin}"`
    const out = execSync(`${npmCmd} root -g`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000, env }).trim()
    if (out) {
      const bin = path.join(out, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (fs.existsSync(bin)) return bin
    }
  } catch { /* fall through to npx cache */ }

  // 2. Try npx cache — DSH may already be cached from a previous `npx @deepseek-ai/dsh`
  try {
    const npxCacheDir = path.join(os.homedir(), '.npm', '_npx')
    if (fs.existsSync(npxCacheDir)) {
      const entries = fs.readdirSync(npxCacheDir)
      for (const entry of entries) {
        const bin = path.join(npxCacheDir, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (fs.existsSync(bin)) return bin
      }
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
 * Small bridge script served at /__dsh_link_bridge.js inside the
 * DSH iframe. Intercepts external-link clicks and window.open(),
 * forwarding the URL to the parent page via postMessage.
 */
const LINK_BRIDGE_SCRIPT = `;(function () {
  if (window.__dshLinkBridgeInstalled) return
  window.__dshLinkBridgeInstalled = true
  var origin = window.location.origin

  function openExternal(url) {
    if (!url) return
    try {
      window.parent.postMessage({ type: 'dsh-open-external', url: String(url) }, '*')
    } catch (e) {}
  }

  // Capture clicks on <a> tags (capture phase, before the SPA handles them)
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null
    if (!a || !a.href) return
    var href = a.href
    var target = a.target || ''
    var external = href.indexOf(origin) !== 0 &&
      href.indexOf('about:') !== 0 &&
      href.indexOf('javascript:') !== 0 &&
      href.indexOf('data:') !== 0
    // target=_blank or links pointing outside the DSH origin → system browser
    if (target === '_blank' || target === '_new' || external) {
      e.preventDefault()
      e.stopPropagation()
      openExternal(href)
      return false
    }
  }, true)

  // window.open() calls (e.g. JS-driven popups) → system browser
  var nativeOpen = window.open
  if (nativeOpen) {
    window.open = function (url) {
      if (url && typeof url === 'string' && url.indexOf('about:') !== 0) {
        openExternal(url)
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
      // Serve the bridge script itself (same-origin with the DSH page)
      if (req.url === '/__dsh_link_bridge.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(LINK_BRIDGE_SCRIPT)
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
  return out
}

/**
 * Forward a normal HTTP request to the DSH server, injecting the
 * bridge script into text/html responses.
 */
function bridgeProxyRequest(req, res) {
  if (!bridgeTargetPort) {
    res.writeHead(502)
    res.end()
    return
  }
  const headers = rewriteBridgeHeaders(req.headers)

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: bridgeTargetPort,
    path: req.url,
    method: req.method,
    headers,
  }, (proxyRes) => {
    const ct = String(proxyRes.headers['content-type'] || '').toLowerCase()
    const isHtml = ct.includes('text/html')
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, rewriteBridgeResponseHeaders(proxyRes.headers))
      proxyRes.pipe(res)
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
        if (/<\/head>/i.test(html)) {
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
  })

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
   * @returns {{ installed: boolean, version: string|null, method: string|null }}
   */
  hasDshInstalled() {
    const nodeInfo = resolveNode()
    if (!nodeInfo.path) return { installed: false, version: null, method: null }

    // Build env with resolved node in PATH
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const systemPath = process.env.PATH || process.env.Path || ''
    const env = { ...process.env, PATH: path.dirname(nodeInfo.path) + pathSep + systemPath }

    // 1. Check npx cache first (fast — no network, no execSync timeout)
    const globalDshBin = resolveGlobalDshBin()
    if (globalDshBin) {
      try {
        const out = execSync(`"${nodeInfo.path}" "${globalDshBin}" --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
        return { installed: true, version: out.trim(), method: 'cache' }
      } catch { /* try other methods */ }
    }

    // 2. Check global install (dsh in PATH)
    try {
      const out = execSync('dsh --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, env })
      return { installed: true, version: out.trim(), method: 'global' }
    } catch { /* not global */ }

    // 3. Check via npx (slow — may download, 30s timeout)
    const npxInfo = resolveNpx()
    if (npxInfo && nodeInfo.path) {
      try {
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
      workspace = null,
      profile = DEFAULT_PROFILE,
      patches = [],
    } = options

    // Resolve workspace: use provided, or saved, or DSH home, or os.homedir()
    const resolvedWorkspace = workspace
      || this.getWorkspace()
      || getDshHome()
      || os.homedir()

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

    // If the configured port already has a healthy DSH service running
    // (e.g. a leftover process from a previous session, or an externally
    // started server), adopt it instead of spawning a new one — spawning
    // would fail with EADDRINUSE and leave the user with a confusing error.
    try {
      const probeHealthy = await this.probePort(port)
      if (probeHealthy) {
        console.log(`[dsh] port ${port} already serves DSH — adopting existing server`)
        await this.adoptExternal(port)
        return { success: true, url: this.getServerUrl() }
      }
    } catch {
      // probe failed — fall through to normal startup
    }

    // Determine the command to run — prefer the globally-installed DSH CLI
    // (fast: no npx registry round-trip), falling back to npx when missing.
    const globalDshBin = resolveGlobalDshBin()
    const npxInfo = resolveNpx()
    const nodeInfo = resolveNode()

    // Debug: log resolved paths to console for troubleshooting
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
    // to the DSH server on the configured port. The iframe connects to the
    // bridge URL (getServerUrl) so it receives the injected link
    // interceptor. The bridge is best-effort — if it fails to start, the
    // server still runs (links just won't auto-open in the system browser).
    try {
      await startBridge(0, port)
    } catch (err) {
      console.warn('[dsh] link bridge failed to start (non-fatal):', err.message)
    }

    // Build command arguments
    const cmdArgs = globalDshBin ? [globalDshBin] : [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh']
    if (profile === 'web') {
      cmdArgs.push('web')
    } else {
      cmdArgs.push('--profile', profile)
    }

    // DSH listens on the configured port; the bridge (random port) forwards to it
    cmdArgs.push('--port', String(port))

    for (const patch of patches) {
      cmdArgs.push('--patch', patch)
    }

    // Environment variables — prepend bundled node dir to PATH
    const env = { ...process.env }
    env.DSH_HOME = getDshHome()
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
    try {
      const polyfillPath = path.join(__dirname, 'polyfills', 'abort-signal-any.js')
      if (fs.existsSync(polyfillPath)) {
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
      port,
      dshPort: port,
      pid: dshProcess.pid,
      startTime: Date.now(),
      workspace: resolvedWorkspace,
      profile,
    }

    // Capture stdout for debugging
    dshProcess.stdout.on('data', (data) => {
      const text = data.toString()
      stdoutBuffer.push(text)
      if (stdoutBuffer.length > 2000) stdoutBuffer.shift()
    })

    // Capture stderr for debugging
    dshProcess.stderr.on('data', (data) => {
      const text = data.toString()
      stderrBuffer.push(text)
      if (stderrBuffer.length > 2000) stderrBuffer.shift()
    })

    // Handle process exit
    dshProcess.on('exit', (code) => {
      serverStatus.running = false
      serverStatus.pid = null
      stopBridge()
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
        env: { ...process.env, PATH: path.dirname(nodeInfo.path) + pathSep + systemPath },
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
   * Attach a window-open handler to a webContents.
   * Catches window.open(), target="_blank", and middle-click-new-tab
   * from the DSH iframe (which is cross-origin, so JS injection fails).
   */
  function hookWebContents(wc) {
    if (!wc || wc.__dshHooked) return
    wc.__dshHooked = true

    // Electron ≥ 15: setWindowOpenHandler
    if (typeof wc.setWindowOpenHandler === 'function') {
      wc.setWindowOpenHandler(({ url }) => {
        if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) {
          window.dsh.openExternal(url)
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
          window.dsh.openExternal(url)
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
      const nodeInfo = resolveNode()
      if (!npxInfo) { resolve(false); return }
      const env = { ...process.env }
      if (nodeInfo.path) {
        const pathSep = process.platform === 'win32' ? ';' : ':'
        env.PATH = path.dirname(nodeInfo.path) + pathSep + (process.env.PATH || process.env.Path || '')
      }
      // Use China-friendly registry by default (user can override via .npmrc)
      if (!env.npm_config_registry) {
        env.npm_config_registry = 'https://registry.npmmirror.com'
      }
      // Running npx with the package will trigger install
      const child = spawn(npxInfo.cmd, [...npxInfo.preArgs, '--yes', '@deepseek-ai/dsh', '--version'], {
        cwd: getDshHome(),
        env,
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
