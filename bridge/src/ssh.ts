// SSH plumbing for remote machines. All calls share one ControlMaster connection per host,
// never prompt (BatchMode), and pass remote arguments single-quoted: ssh joins its arguments
// into one line for the remote shell, so unquoted paths would be re-parsed there.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PADDOCK_CACHE = join(homedir(), '.cache', 'paddock')
const CONTROL_DIR = join(PADDOCK_CACHE, 'ssh')
mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 })

export interface SshTarget {
  /** `user@host` (or a Host alias). */
  host: string
  port?: number
}

/** herdr saves targets as `ssh://user@host:port` or plain `user@host`. */
export function parseTarget(target: string): SshTarget {
  if (!target.startsWith('ssh://')) return { host: target }
  const url = new URL(target)
  const user = url.username ? `${decodeURIComponent(url.username)}@` : ''
  return { host: `${user}${url.hostname}`, port: url.port ? Number(url.port) : undefined }
}

export const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`

export function sshOptions(target: SshTarget): string[] {
  const opts = [
    ['BatchMode', 'yes'],
    ['ConnectTimeout', '10'],
    ['ServerAliveInterval', '15'],
    ['ServerAliveCountMax', '3'],
    ['ControlMaster', 'auto'],
    ['ControlPath', join(CONTROL_DIR, '%C')],
    ['ControlPersist', '120'],
  ].flatMap(([k, v]) => ['-o', `${k}=${v}`])
  return target.port ? [...opts, '-p', String(target.port)] : opts
}

/** Streams a remote command; stdio is piped. */
export function sshSpawn(target: SshTarget, argv: string[]): ChildProcess {
  return spawn('ssh', [...sshOptions(target), target.host, '--', argv.map(shellQuote).join(' ')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

export class SshError extends Error {
  code: number | null
  constructor(message: string, code: number | null) {
    super(message)
    this.code = code
  }
}

/** Runs a remote command to completion and returns its stdout. */
export function sshExec(
  target: SshTarget,
  argv: string[],
  { input, maxBytes = 64 * 1024 * 1024, timeoutMs = 30_000 }: { input?: Buffer; maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = sshSpawn(target, argv)
    const out: Buffer[] = []
    let size = 0
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new SshError('remote command timed out', null))
    }, timeoutMs)
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        child.kill('SIGTERM')
        return
      }
      out.push(chunk)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new SshError(err.message, null))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (size > maxBytes) return reject(new SshError('remote output too large', code))
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new SshError(stderr.trim() || `remote command exited ${code}`, code))
    })
    child.stdin!.on('error', () => undefined) // Remote may exit before reading all input.
    child.stdin!.end(input)
  })
}

/** `sh -c <script> sh <args…>`: the script is fixed text, user data only ever arrives as "$1", "$2"… */
export const shScript = (script: string, ...args: string[]) => ['sh', '-c', script, 'sh', ...args]
