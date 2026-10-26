/**
 * Child-process helpers for the VPN plugin.
 *
 * The plugin runs inside the Harness host process and may spawn `warp-cli`.
 * Every helper resolves (never rejects) so a missing or slow CLI turns into a
 * readable tool result instead of a failed tool call.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const WARP_CLI_NAME = 'warp-cli.exe'

/** Candidate `warp-cli` locations, most specific first. */
export function warpCliCandidates() {
  const candidates = []
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (programFiles) candidates.push(join(programFiles, 'Cloudflare', 'Cloudflare WARP', WARP_CLI_NAME))
  if (programFilesX86) candidates.push(join(programFilesX86, 'Cloudflare', 'Cloudflare WARP', WARP_CLI_NAME))
  return candidates
}

/**
 * Resolve the WARP CLI.
 *
 * @returns {{ command: string, explicit: boolean }} the executable to spawn and
 *   whether it was found at a known install path.
 */
export function findWarpCli() {
  for (const candidate of warpCliCandidates()) {
    if (existsSync(candidate)) return { command: candidate, explicit: true }
  }
  return { command: 'warp-cli', explicit: false }
}

/**
 * Run one command with bounded output and a hard timeout.
 *
 * @param {string} command - executable name or absolute path.
 * @param {string[]} args - arguments, never shell-interpolated.
 * @param {{ timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, error: string, timedOut?: boolean, spawnError?: boolean }>}
 */
export function run(command, args, options = {}) {
  const timeoutMs = clamp(options.timeoutMs ?? 8000, 1000, 120000)
  const maxBytes = clamp(options.maxBytes ?? 65536, 1024, 1048576)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: message, spawnError: true })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      finish({ ok: false, code: null, stdout, stderr, error: message, spawnError: true })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, error: '' })
    })

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // The process may already have exited.
      }
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: `command timed out after ${timeoutMs}ms`,
        timedOut: true,
      })
    }, timeoutMs)
  })
}

export function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
