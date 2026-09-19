// The machines Orca drives: this one, plus every enabled herdr saved SSH machine
// (`herdr machine list --json`). A remote machine's herdr socket is forwarded over one SSH
// connection, so the rest of the bridge talks to every machine the same way.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { localSocketPath, rpc } from './herdr.ts'
import { SnapshotHub } from './hub.ts'
import { LocalFs, SshFs, type MachineFs } from './fsops.ts'
import { ORCA_CACHE, parseTarget, shScript, sshExec, sshOptions, sshSpawn, type SshTarget } from './ssh.ts'
import { herdrBin as localHerdrBin } from './terminal.ts'

const SOCKET_DIR = join(ORCA_CACHE, 'sockets')
mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 })

const REFRESH_MS = 60_000
const RETRY_MIN_MS = 500
const RETRY_MAX_MS = 30_000
const READY_TIMEOUT_MS = 15_000

export type MachineStatus = 'online' | 'offline' | 'attention'

export interface MachineInfo {
  id: string
  label: string
  kind: 'local' | 'ssh'
  status: MachineStatus
  error?: string
}

export abstract class Machine {
  abstract readonly kind: 'local' | 'ssh'
  abstract readonly fs: MachineFs
  readonly id: string
  readonly label: string
  readonly socketPath: string
  readonly hub: SnapshotHub
  protected linkError: string | undefined = 'connecting'
  private listeners = new Set<() => void>()

  constructor(id: string, label: string, socketPath: string) {
    this.id = id
    this.label = label
    this.socketPath = socketPath
    this.hub = new SnapshotHub(socketPath)
    this.hub.onChange(() => this.emit())
  }

  /** Runs a herdr CLI command on this machine with piped stdio. */
  abstract spawnHerdr(args: string[]): ChildProcess
  abstract start(): void
  abstract stop(): void

  info(): MachineInfo {
    const hubError = this.hub.state.online ? undefined : this.hub.state.error
    const error = this.linkError ?? hubError
    const status: MachineStatus = !error ? 'online' : this.needsAttention() ? 'attention' : 'offline'
    return { id: this.id, label: this.label, kind: this.kind, status, error }
  }

  protected needsAttention(): boolean {
    return false
  }

  onStatus(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected emit(): void {
    for (const l of this.listeners) l()
  }
}

export class LocalMachine extends Machine {
  readonly kind = 'local' as const
  readonly fs = new LocalFs()

  constructor() {
    super(hostname(), hostname(), localSocketPath)
    this.linkError = undefined
  }

  spawnHerdr(args: string[]) {
    return spawn(localHerdrBin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  start() {
    this.hub.start()
  }

  stop() {
    this.hub.stop()
  }
}

// ssh errors that retrying won't fix without the user (keys, host keys, DNS).
const ATTENTION = /permission denied|host key verification failed|could not resolve hostname|no route to host|connection refused/i

export class SshMachine extends Machine {
  readonly kind = 'ssh' as const
  fs: MachineFs
  private readonly target: SshTarget
  private herdrPath = 'herdr'
  private tunnel: ChildProcess | null = null
  private retryMs = RETRY_MIN_MS
  private retryTimer: NodeJS.Timeout | null = null
  private stopped = false
  private hubStarted = false
  readonly profileId: string
  readonly rawTarget: string
  private readonly session: string

  constructor(id: string, label: string, profileId: string, rawTarget: string, session: string) {
    super(id, label, join(SOCKET_DIR, `${id}.sock`))
    this.profileId = profileId
    this.rawTarget = rawTarget
    this.session = session
    this.target = parseTarget(rawTarget)
    this.fs = new SshFs(this.target, '/')
  }

  protected needsAttention() {
    return ATTENTION.test(this.linkError ?? '')
  }

  spawnHerdr(args: string[]) {
    return sshSpawn(this.target, [this.herdrPath, ...args])
  }

  start() {
    this.stopped = false
    void this.connect()
  }

  stop() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.tunnel?.kill('SIGTERM')
    this.hub.stop()
    try {
      unlinkSync(this.socketPath)
    } catch {
      // Already gone.
    }
  }

  private setLinkError(error: string | undefined) {
    if (this.linkError === error) return
    this.linkError = error
    this.emit()
  }

  private scheduleRetry(error: string) {
    this.setLinkError(error)
    if (this.stopped) return
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs)
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS)
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    // Where herdr lives on the remote (non-interactive shells often lack ~/.local/bin on PATH).
    let home: string
    try {
      const out = await sshExec(
        this.target,
        shScript('printf "%s\\n" "$HOME"; command -v herdr || printf "%s\\n" "$HOME/.local/bin/herdr"'),
        { timeoutMs: 20_000 },
      )
      ;[home, this.herdrPath] = out.toString('utf8').trim().split('\n')
    } catch (err) {
      return this.scheduleRetry((err as Error).message)
    }
    this.fs = new SshFs(this.target, home)
    const configDir = posix.join(home, '.config', 'herdr')
    const remoteSocket =
      this.session && this.session !== 'default'
        ? posix.join(configDir, 'sessions', this.session, 'herdr.sock')
        : posix.join(configDir, 'herdr.sock')

    try {
      unlinkSync(this.socketPath)
    } catch {
      // No stale socket.
    }
    // The tunnel is its own master connection; per-call ssh commands share it via ControlPath.
    // ssh keeps the first value of an option, so the overrides come before the shared ones.
    const tunnel = spawn(
      'ssh',
      [
        '-N',
        '-o', 'ControlMaster=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'StreamLocalBindUnlink=yes',
        ...sshOptions(this.target),
        '-L', `${this.socketPath}:${remoteSocket}`,
        this.target.host,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    this.tunnel = tunnel
    let stderr = ''
    tunnel.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1000)
    })
    tunnel.on('exit', (code) => {
      if (this.tunnel !== tunnel) return
      this.tunnel = null
      const reason = stderr.trim().split('\n').pop() || `ssh exited ${code}`
      this.scheduleRetry(reason)
    })

    // Ready once the forwarded socket answers herdr's ping.
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline && this.tunnel === tunnel) {
      const ok = await rpc(this.socketPath, 'ping', {}, 2000).then(
        () => true,
        () => false,
      )
      if (ok) {
        this.retryMs = RETRY_MIN_MS
        this.setLinkError(undefined)
        if (!this.hubStarted) {
          this.hubStarted = true
          this.hub.start()
        } else this.hub.invalidate()
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (this.tunnel === tunnel) tunnel.kill('SIGTERM') // exit handler schedules the retry
  }
}

interface Profile {
  id: string
  label: string
  target: string
  session: string
  enabled: boolean
}

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'machine'

/** Keeps the machine list in sync with herdr's saved machines and starts/stops their links. */
export class MachineRegistry {
  readonly local = new LocalMachine()
  private remotes = new Map<string, SshMachine>() // by herdr profile id
  private listeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null

  list(): Machine[] {
    return [this.local, ...this.remotes.values()]
  }

  get(id: string): Machine | undefined {
    return this.list().find((m) => m.id === id)
  }

  /** Fires after machines are added or removed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.local.start()
    await this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  private async refresh(): Promise<void> {
    let profiles: Profile[]
    try {
      const { stdout } = await promisify(execFile)(localHerdrBin, ['machine', 'list', '--json'], { timeout: 10_000 })
      profiles = (JSON.parse(stdout) as Profile[]).filter((p) => p.enabled)
    } catch (err) {
      console.warn(`[orca] could not read herdr machines: ${(err as Error).message}`)
      return
    }
    let changed = false
    for (const [profileId, machine] of this.remotes) {
      const profile = profiles.find((p) => p.id === profileId)
      if (!profile || profile.target !== machine.rawTarget || profile.label !== machine.label) {
        machine.stop()
        this.remotes.delete(profileId)
        changed = true
      }
    }
    for (const profile of profiles) {
      if (this.remotes.has(profile.id)) continue
      const taken = new Set(this.list().map((m) => m.id))
      const id = taken.has(slug(profile.label)) ? profile.id : slug(profile.label)
      const machine = new SshMachine(id, profile.label, profile.id, profile.target, profile.session)
      this.remotes.set(profile.id, machine)
      machine.start()
      changed = true
    }
    if (changed) for (const l of this.listeners) l()
  }
}
