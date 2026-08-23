

## Codely Structured Memories

### User

### Feedback
- [2026-08-29 19:09:56] Never use execSync with long timeouts (>5s) in uTools preload.js — it blocks the Electron renderer thread and freezes the entire UI on macOS. Use async `exec` instead, or skip the check entirely with a fast fallback. **Why:** macOS users reported uTools interface completely frozen when opening the plugin, caused by execSync('npx --yes @deepseek-ai/dsh --version') with 30s timeout running inside setTimeout (which is still synchronous). **How to apply:** All preload.js functions that might take >2s must use child_process.exec (async callback) not execSync. Cache execSync results when the same value is needed repeatedly.

### Project
- [2026-08-29 19:09:53] DeepSeek Harness uTools Plugin v1.1.0 — key architecture decisions: (1) Node.js runtime is NOT bundled — downloaded on-demand to utools.getPath('userData')/runtime/ on first launch (package size 0.4MB vs 86MB). (2) China mirror support: 4 mirrors for Node.js download (nodejs.org + npmmirror variants), npm registry defaults to registry.npmmirror.com. (3) Workspace selection removed from plugin UI — DSH Web UI manages workspaces natively. (4) execSync with long timeouts (npx --version, 30s) causes UI freeze on macOS — must use async exec or skip slow checks. (5) RPC wire format: POST /api/<namespace>/<method> with {type:"client-request", rpcId, method, payload:{args}} envelope.
### Reference

