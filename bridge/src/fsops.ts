// File access on a machine, local or over SSH. images.ts, transcript.ts and media.ts only
// talk to this interface, so every image feature works the same on remote machines.
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { shScript, sshExec, sshSpawn, type SshTarget } from './ssh.ts'

export interface FileInfo {
  size: number
  mtimeMs: number
  isFile: boolean
  isDir: boolean
}

export interface FileEntry {
  path: string
  mtimeMs: number
}

export interface RecentQuery {
  root: string
  sinceMs: number
  maxDepth: number
  skipDirs: string[]
  /** A directory under root to leave out (the uploads folder has its own group). */
  excludeDir: string
  extensions: string[]
  limit: number
}

export interface MachineFs {
  readonly home: string
  readonly tmp: string
  realpath(path: string): Promise<string | null>
  stat(path: string): Promise<FileInfo | null>
  readHead(path: string, bytes: number): Promise<Buffer>
  readStream(path: string): Readable
  /** Creates the file; fails if it already exists. Parent folders are created. */
  writeNew(path: string, data: Buffer): Promise<void>
  /** Files directly inside `dir` (not recursive). */
  listFiles(dir: string): Promise<FileEntry[]>
  remove(path: string): Promise<void>
  /** Adds `.orca/` to the repo's local exclude list if `cwd` is a git repo. */
  excludeFromGit(cwd: string): Promise<void>
  recentFiles(query: RecentQuery): Promise<FileEntry[]>
  /** A file called `name` in any direct subfolder of `root`, or null. */
  findInSubdirs(root: string, name: string): Promise<string | null>
  /** Most recently modified `*.jsonl` directly in `dir`, or null. */
  newestJsonl(dir: string): Promise<string | null>
}

// ---------- local ----------

export class LocalFs implements MachineFs {
  readonly home = homedir()
  readonly tmp = tmpdir()

  realpath(path: string) {
    return realpath(path).catch(() => null)
  }

  async stat(path: string) {
    const s = await stat(path).catch(() => null)
    return s && { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDir: s.isDirectory() }
  }

  async readHead(path: string, bytes: number) {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buf, 0, bytes, 0)
      return buf.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  readStream(path: string) {
    return createReadStream(path)
  }

  async writeNew(path: string, data: Buffer) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, data, { flag: 'wx' })
  }

  async listFiles(dir: string) {
    const names = await readdir(dir).catch(() => [] as string[])
    const entries = await Promise.all(
      names.map(async (name) => {
        const s = await stat(join(dir, name)).catch(() => null)
        return s?.isFile() ? { path: join(dir, name), mtimeMs: s.mtimeMs } : null
      }),
    )
    return entries.filter((e): e is FileEntry => !!e)
  }

  async remove(path: string) {
    await unlink(path).catch(() => undefined)
  }

  async excludeFromGit(cwd: string) {
    const exclude = join(cwd, '.git', 'info', 'exclude')
    if (!(await this.stat(join(cwd, '.git')))?.isDir) return
    const current = await readFile(exclude, 'utf8').catch(() => '')
    if (current.split('\n').some((line) => line.trim() === '.orca/')) return
    await mkdir(join(cwd, '.git', 'info'), { recursive: true })
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.orca/\n`)
  }

  async recentFiles(q: RecentQuery) {
    const found: FileEntry[] = []
    const skip = new Set(q.skipDirs)
    let seen = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > q.maxDepth || seen >= 5000) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (++seen >= 5000) return
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && full !== q.excludeDir) await walk(full, depth + 1)
        } else if (entry.isFile() && q.extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
          const s = await stat(full).catch(() => null)
          if (s && s.mtimeMs >= q.sinceMs) found.push({ path: full, mtimeMs: s.mtimeMs })
        }
      }
    }
    await walk(q.root, 0)
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, q.limit)
  }

  async findInSubdirs(root: string, name: string) {
    for (const dir of await readdir(root).catch(() => [] as string[])) {
      const candidate = join(root, dir, name)
      if ((await this.stat(candidate))?.isFile) return candidate
    }
    return null
  }

  async newestJsonl(dir: string) {
    const files = (await this.listFiles(dir)).filter((f) => f.path.endsWith('.jsonl'))
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null
  }
}

// ---------- over SSH ----------

/**
 * The same operations as fixed POSIX shell snippets run over SSH (GNU coreutils/find, as on
 * any Linux or WSL). Paths are only ever passed as positional arguments, never spliced into
 * the script text.
 */
export class SshFs implements MachineFs {
  readonly tmp = '/tmp'
  readonly home: string
  private readonly target: SshTarget

  constructor(target: SshTarget, home: string) {
    this.target = target
    this.home = home
  }

  private run(script: string, args: string[], opts?: { input?: Buffer; maxBytes?: number; timeoutMs?: number }) {
    return sshExec(this.target, shScript(script, ...args), opts)
  }

  async realpath(path: string) {
    const out = await this.run('realpath -e -- "$1"', [path]).catch(() => null)
    return out ? out.toString('utf8').trim() || null : null
  }

  async stat(path: string) {
    const out = await this.run('stat -L -c "%s %Y %F" -- "$1"', [path]).catch(() => null)
    if (!out) return null
    const [size, mtime, ...type] = out.toString('utf8').trim().split(' ')
    const kind = type.join(' ')
    return { size: Number(size), mtimeMs: Number(mtime) * 1000, isFile: kind.startsWith('regular'), isDir: kind === 'directory' }
  }

  readHead(path: string, bytes: number) {
    return this.run('head -c "$2" -- "$1"', [path, String(bytes)], { maxBytes: bytes })
  }

  readStream(path: string) {
    const child = sshSpawn(this.target, shScript('cat -- "$1"', path))
    child.stdin!.end()
    return child.stdout!
  }

  async writeNew(path: string, data: Buffer) {
    // noclobber: refuse to overwrite, like the local 'wx' flag.
    await this.run('mkdir -p -- "$(dirname -- "$1")" && set -C && cat > "$1"', [path], { input: data, timeoutMs: 120_000 })
  }

  async listFiles(dir: string) {
    const out = await this.run('find "$1" -mindepth 1 -maxdepth 1 -type f -printf "%T@\\t%p\\n"', [dir]).catch(() => null)
    return out ? parseEntries(out) : []
  }

  async remove(path: string) {
    await this.run('rm -f -- "$1"', [path]).catch(() => undefined)
  }

  async excludeFromGit(cwd: string) {
    await this.run(
      '[ -d "$1/.git" ] || exit 0; f="$1/.git/info/exclude"; mkdir -p "$1/.git/info"; ' +
        'grep -qxF ".orca/" "$f" 2>/dev/null || { [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo >> "$f"; echo ".orca/" >> "$f"; }',
      [cwd],
    )
  }

  async recentFiles(q: RecentQuery) {
    // find "$1" \( -path excluded -o -name skip… \) -prune -o -type f \( -iname *.png … \) -newermt @since -printf …
    const args = [q.root, q.excludeDir, String(Math.floor(q.sinceMs / 1000)), String(q.maxDepth)]
    // Positional parameters past $9 need braces: "${10}".
    const param = (n: number) => `"\${${n}}"`
    const prune = q.skipDirs.map((_, i) => `-o -name ${param(args.length + i + 1)}`).join(' ')
    const names = q.extensions.map((_, i) => `-iname "*"${param(args.length + q.skipDirs.length + i + 1)}`).join(' -o ')
    const script =
      `find "$1" -maxdepth "$4" \\( -path "$2" ${prune} \\) -prune -o -type f \\( ${names} \\) ` +
      `-newermt "@$3" -printf "%T@\\t%p\\n" 2>/dev/null | sort -rn | head -n ${Number(q.limit)}`
    const out = await this.run(script, [...args, ...q.skipDirs, ...q.extensions], { timeoutMs: 20_000 }).catch(() => null)
    return out ? parseEntries(out) : []
  }

  async findInSubdirs(root: string, name: string) {
    const out = await this.run('find "$1" -mindepth 2 -maxdepth 2 -type f -name "$2" -print -quit', [root, name]).catch(() => null)
    return out?.toString('utf8').trim() || null
  }

  async newestJsonl(dir: string) {
    const files = (await this.listFiles(dir)).filter((f) => f.path.endsWith('.jsonl'))
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null
  }
}

function parseEntries(out: Buffer): FileEntry[] {
  return out
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return { mtimeMs: Number(line.slice(0, tab)) * 1000, path: line.slice(tab + 1) }
    })
}
