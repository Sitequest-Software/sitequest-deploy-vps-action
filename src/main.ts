/**
 * Sitequest Deploy VPS — GitHub Action entry point.
 *
 * Capistrano-style atomic deploy:
 *   1. tar+gzip the source directory locally
 *   2. split the archive into <=24 MB chunks and PUT each one to
 *      /api/v1/vps/:id/sftp/write?path=<base>/uploads/<run-id>.tar.gz.partNN
 *      (32 MB per-request server cap, raw bytes)
 *   3. POST /api/v1/vps/:id/exec running:
 *        - mkdir <target-base>/{releases,uploads}
 *        - cat uploads/<run-id>.tar.gz.part* > uploads/<run-id>.tar.gz
 *        - tar -xzf the upload into releases/<run-id>/
 *        - optional chown
 *        - ln -sfn releases/<run-id> current   (atomic symlink swap)
 *        - prune old releases beyond keep-releases
 *        - optional systemctl restart <units>
 *
 * Layout produced on the VPS:
 *   <target-base>/
 *     ├─ current        → releases/<latest>
 *     ├─ releases/<run-id-1>/
 *     ├─ releases/<run-id-2>/
 *     └─ uploads/       (transient, tarballs cleaned up after extract)
 *
 * Rollback: just point `current` at a previous release and restart the service.
 */

import * as core from "@actions/core"
import { spawn } from "node:child_process"
import { open, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Per-request payload cap. Kept well under the 32 MB server cap because
// large single-shot PUTs from GitHub runners over slow uplinks frequently
// hit socket-level resets ("fetch failed"). 8 MB is a sweet spot.
const CHUNK_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB
const USER_AGENT = "sitequest-deploy-vps-action/1.0.0"

interface Inputs {
  apiKey:         string
  vpsId:          string
  source:         string
  targetBase:     string
  keepReleases:   number
  restartService: string
  owner:          string
  apiBase:        string
}

interface ApiError {
  error:  string
  code:   string
  status: number
}

interface ExecResult {
  stdout:    string
  stderr:    string
  exitCode:  number | null
}

interface ApiEnvelope<T> { data: T }

function readInputs(): Inputs {
  const apiKey         = core.getInput("api-key", { required: true })
  const vpsId          = core.getInput("vps-id", { required: true })
  const source         = core.getInput("source") || "dist"
  const targetBase     = (core.getInput("target-base", { required: true })).replace(/\/+$/, "")
  const keep           = Number.parseInt(core.getInput("keep-releases") || "5", 10)
  const restartService = (core.getInput("restart-service") || "").trim()
  const owner          = (core.getInput("owner") || "").trim()
  const apiBase        = (core.getInput("api-base") || "https://hosting.site.quest").replace(/\/+$/, "")

  if (!/^[A-Za-z0-9_-]+$/.test(vpsId)) {
    throw new Error(`Invalid vps-id: ${vpsId}`)
  }
  if (!targetBase.startsWith("/") || targetBase.includes("..")) {
    throw new Error(`target-base must be an absolute path without '..' (got ${targetBase})`)
  }
  if (!Number.isFinite(keep) || keep < 0 || keep > 1000) {
    throw new Error(`keep-releases must be 0..1000`)
  }
  if (owner && !/^[A-Za-z_][A-Za-z0-9_-]*(:[A-Za-z_][A-Za-z0-9_-]*)?$/.test(owner)) {
    throw new Error(`owner must look like 'user' or 'user:group' (got '${owner}')`)
  }
  if (restartService) {
    for (const unit of restartService.split(",").map((s) => s.trim())) {
      if (!/^[A-Za-z0-9_@.\-]+$/.test(unit)) {
        throw new Error(`Invalid systemd unit name: '${unit}'`)
      }
    }
  }
  return { apiKey, vpsId, source, targetBase, keepReleases: keep, restartService, owner, apiBase }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

async function tarArchive(sourceDir: string, outFile: string): Promise<void> {
  const s = await stat(sourceDir).catch(() => null)
  if (!s || !s.isDirectory()) {
    throw new Error(`Source directory not found: ${sourceDir}`)
  }
  await run("tar", ["-czf", outFile, "-C", sourceDir, "."])
}

function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts: string[] = [err.message]
  let cause: unknown = (err as { cause?: unknown }).cause
  while (cause) {
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code
      parts.push(code ? `${cause.message} [${code}]` : cause.message)
      const errors = (cause as { errors?: unknown[] }).errors
      if (Array.isArray(errors)) {
        for (const e of errors) {
          if (e instanceof Error) {
            const ec = (e as { code?: string }).code
            parts.push(ec ? `${e.message} [${ec}]` : e.message)
          }
        }
      }
      cause = (cause as { cause?: unknown }).cause
    } else {
      parts.push(String(cause))
      break
    }
  }
  return parts.join(" → ")
}

async function apiCall<T>(
  url:    string,
  init:   RequestInit,
  apiKey: string,
  opts:   { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 0
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent":  USER_AGENT,
          ...(init.headers ?? {}),
        },
      })
      const text = await res.text()
      if (!res.ok) {
        let parsed: ApiError | undefined
        try { parsed = JSON.parse(text) as ApiError } catch { /* not JSON */ }
        const code = parsed?.code  ?? `HTTP_${res.status}`
        const msg  = parsed?.error ?? (text.slice(0, 500) || res.statusText)
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`[${code}] ${msg}`)
        }
        lastErr = new Error(`[${code}] ${msg}`)
      } else {
        if (!text) return {} as T
        const parsedBody = JSON.parse(text) as { data?: T } & T
        // Sitequest API wraps successful payloads in `{ data: ... }`. Unwrap
        // so callers can read fields directly. Fall back to the raw body for
        // legacy endpoints that don't wrap.
        return (parsedBody && typeof parsedBody === "object" && "data" in parsedBody
          ? (parsedBody.data as T)
          : (parsedBody as T))
      }
    } catch (err) {
      lastErr = err instanceof Error && err.message === "fetch failed"
        ? new Error(`fetch failed: ${describeFetchError(err)}`)
        : err
      if (err instanceof Error && err.message.startsWith("[")) throw err
    }
    if (attempt < retries) {
      const delay = Math.min(30_000, 1000 * 2 ** attempt)
      core.warning(
        `Request failed (attempt ${attempt + 1}/${retries + 1}): ` +
          `${lastErr instanceof Error ? lastErr.message : String(lastErr)}. ` +
          `Retrying in ${delay}ms…`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Upload the archive in <=CHUNK_BYTES parts. Each chunk is PUT as a separate
 * file `<remotePath>.partNN`. The remote deploy script reassembles them with
 * `cat *.partNN > <remotePath>` before extracting.
 */
async function uploadArchive(
  inputs:      Inputs,
  archivePath: string,
  remotePath:  string,
): Promise<{ bytes: number; parts: number }> {
  const s = await stat(archivePath)
  const total = s.size
  if (total > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `Archive is ${(total / 1024 / 1024).toFixed(2)} MB, exceeds ` +
        `the ${MAX_ARCHIVE_BYTES / 1024 / 1024 / 1024} GB upload limit. ` +
        `Trim the build output, upload via SFTP directly, or open an issue.`,
    )
  }
  if (total === 0) {
    throw new Error(`Archive is empty (0 bytes) — nothing to deploy.`)
  }

  const parts = Math.ceil(total / CHUNK_BYTES)
  const padWidth = Math.max(2, String(parts - 1).length)
  core.info(
    `Archive ${(total / 1024 / 1024).toFixed(2)} MB → ${parts} part(s) of up to ` +
      `${CHUNK_BYTES / 1024 / 1024} MB`,
  )

  const fh = await open(archivePath, "r")
  try {
    for (let i = 0; i < parts; i++) {
      const offset = i * CHUNK_BYTES
      const size   = Math.min(CHUNK_BYTES, total - offset)
      const buf    = Buffer.allocUnsafe(size)
      const { bytesRead } = await fh.read(buf, 0, size, offset)
      if (bytesRead !== size) {
        throw new Error(
          `Short read at offset ${offset}: expected ${size}, got ${bytesRead}`,
        )
      }
      const partPath = `${remotePath}.part${String(i).padStart(padWidth, "0")}`
      const url = `${inputs.apiBase}/api/v1/vps/${inputs.vpsId}/sftp/write` +
                  `?path=${encodeURIComponent(partPath)}`
      core.info(
        `  part ${i + 1}/${parts}: ${(size / 1024 / 1024).toFixed(2)} MB → ${partPath}`,
      )
      await apiCall(
        url,
        {
          method:  "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body:    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        },
        inputs.apiKey,
        { retries: 3 },
      )
    }
  } finally {
    await fh.close()
  }
  return { bytes: total, parts }
}

/**
 * Build the extract+swap+prune+restart pipeline. Every interpolation point
 * is single-quote-escaped so user-controlled inputs cannot break out into
 * the surrounding shell.
 */
function buildDeployScript(inputs: Inputs, runId: string, archivePath: string): string {
  const sh           = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const base         = sh(inputs.targetBase)
  const releasesDir  = sh(`${inputs.targetBase}/releases`)
  const releasePath  = sh(`${inputs.targetBase}/releases/${runId}`)
  const releaseRel   = sh(`releases/${runId}`)
  const currentLink  = sh(`${inputs.targetBase}/current`)
  const upload       = sh(archivePath)
  // Wildcard MUST stay outside the single quotes so the shell expands it.
  // Quoting `'foo.part*'` would have the shell look for a literal file with
  // `*` in its name. Only the user-controlled prefix needs escaping.
  const uploadParts  = `${sh(`${archivePath}.part`)}*`

  const chownStep = inputs.owner
    ? `chown -R ${sh(inputs.owner)} ${releasePath}`
    : `true`

  // Atomic symlink swap: `mv -T` is atomic on the same filesystem. We create
  // the new symlink alongside, then `mv -T` it over `current`.
  const swapStep = [
    `ln -sfn ${releaseRel} ${sh(`${inputs.targetBase}/current.next`)}`,
    `mv -Tf ${sh(`${inputs.targetBase}/current.next`)} ${currentLink}`,
  ].join(" && ")

  const pruneStep = inputs.keepReleases > 0
    ? `ls -1t ${releasesDir} 2>/dev/null | tail -n +$((${inputs.keepReleases} + 1)) | ` +
      `xargs -I{} rm -rf -- ${releasesDir}/{}`
    : `true`

  const restartSteps = inputs.restartService
    ? inputs.restartService.split(",").map((u) => `systemctl restart ${sh(u.trim())}`).join(" && ")
    : `true`

  // `cat <file>.part*` relies on shell glob ordering being lexicographic,
  // which matches the zero-padded part suffix produced by uploadArchive().
  return [
    `set -eu`,
    `mkdir -p ${base} ${releasesDir} ${releasePath} ${sh(`${inputs.targetBase}/uploads`)}`,
    `cat ${uploadParts} > ${upload}`,
    `rm -f ${uploadParts}`,
    `tar -xzf ${upload} -C ${releasePath}`,
    chownStep,
    swapStep,
    pruneStep,
    restartSteps,
    `rm -f ${upload}`,
    `readlink ${currentLink}`, // last line of stdout = symlink target
  ].join(" && ")
}

async function execRemote(
  inputs: Inputs,
  script: string,
): Promise<ExecResult> {
  const url = `${inputs.apiBase}/api/v1/vps/${inputs.vpsId}/exec`
  core.info(`Running deploy pipeline on VPS`)
  const envelope = await apiCall<ApiEnvelope<ExecResult>>(
    url,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ command: script, timeout: 300 }),
    },
    inputs.apiKey,
  )
  return envelope.data
}

async function cleanupRemoteArchive(inputs: Inputs, archivePath: string): Promise<void> {
  const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const url = `${inputs.apiBase}/api/v1/vps/${inputs.vpsId}/exec`
  await apiCall(
    url,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        // Remove both the assembled archive and any orphaned chunk parts.
        command: `rm -f ${sh(archivePath)} ${sh(`${archivePath}.part`)}*`,
        timeout: 30,
      }),
    },
    inputs.apiKey,
  ).catch(() => undefined)
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  let inputs: Inputs
  try {
    inputs = readInputs()
  } catch (err) {
    core.setFailed((err as Error).message)
    return
  }
  core.setSecret(inputs.apiKey)

  const runId        = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`) +
                       "-" + (process.env.GITHUB_RUN_ATTEMPT ?? "1")
  const remoteUpload = `${inputs.targetBase}/uploads/${runId}.tar.gz`
  let workDir: string | null = null
  let uploaded = false

  try {
    workDir = await mkdtemp(join(tmpdir(), "sitequest-deploy-vps-"))
    const archivePath = join(workDir, "deploy.tar.gz")

    await core.group("Pack source directory", async () => {
      await tarArchive(inputs.source, archivePath)
      const s = await stat(archivePath)
      core.info(`Archive size: ${(s.size / 1024).toFixed(1)} KB`)
    })

    let bytes = 0
    let parts = 0
    await core.group("Upload archive", async () => {
      const r = await uploadArchive(inputs, archivePath, remoteUpload)
      bytes = r.bytes
      parts = r.parts
      uploaded = true
    })

    let releaseTarget = ""
    await core.group("Extract & swap on VPS", async () => {
      const script = buildDeployScript(inputs, runId, remoteUpload)
      const r = await execRemote(inputs, script)
      uploaded = false // server-side script removes the archive
      if (r.exitCode !== 0) {
        if (r.stderr) core.error(r.stderr.slice(-2000))
        throw new Error(`Deploy script exited with code ${r.exitCode}`)
      }
      releaseTarget = r.stdout.trim().split(/\r?\n/).pop() ?? ""
      core.info(`current → ${releaseTarget}`)
    })

    const duration = Date.now() - startedAt
    const releasePath = `${inputs.targetBase}/releases/${runId}`
    core.setOutput("release-path",   releasePath)
    core.setOutput("bytes-uploaded", bytes)
    core.setOutput("duration-ms",    duration)

    const mb = (bytes / 1024 / 1024).toFixed(2)
    const secs = (duration / 1000).toFixed(2)
    const restarted = inputs.restartService ? ` (restarted \`${inputs.restartService}\`)` : ""
    await core.summary
      .addRaw(`Deployed ${mb} MB in ${parts} chunk${parts === 1 ? "" : "s"} to \`${releasePath}\` in ${secs}s${restarted}.`)
      .write()

    core.info(`✓ Deployed in ${secs}s → ${releasePath}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    core.setFailed(message)
    if (uploaded) {
      core.warning(`Cleaning up orphaned remote archive ${remoteUpload}`)
      await cleanupRemoteArchive(inputs, remoteUpload)
    }
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

void main()
