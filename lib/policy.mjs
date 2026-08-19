/**
 * dsh-safety policy refinement layer.
 *
 * dsh-safety 策略细化层。
 *
 * Enhances the core policy with:
 *   - symbolic link detection and protection
 *   - hard link detection and protection
 *   - FUSE mount detection and exclusion
 *   - docker volume mount detection
 *   - WSL mount detection
 *   - read-only filesystem detection
 *
 * 增强核心策略，处理：
 *   - 符号链接检测与保护
 *   - 硬链接检测与保护
 *   - FUSE 挂载检测与排除
 *   - Docker 卷挂载检测
 *   - WSL 挂载检测
 *   - 只读文件系统检测
 *
 * This module is a standalone utility: it is exported from the package so it
 * can be used to inspect/refine a policy, but the enforcement path in
 * `safety-core.mjs` does not depend on it (auto-adding every FUSE mount to the
 * protected set would risk over-blocking legitimate work on user mounts).
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { isUnder } from './safety-core.mjs'

/**
 * Detect whether a path is a symbolic link.
 * Uses `lstat` — `stat` follows links, so it could never see the link itself.
 */
export async function isSymlink(p) {
  try {
    const st = await fsp.lstat(p)
    return st.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Detect whether a path is a hard link (has more than one name).
 */
export async function isHardlink(p) {
  try {
    const st = await fsp.stat(p)
    return st.nlink > 1
  } catch {
    return false
  }
}

/**
 * Get the real path of a symlink (follows all links).
 */
export async function realpath(p) {
  try {
    return await fsp.realpath(p)
  } catch {
    return p
  }
}

/** Parse `/proc/mounts`-style lines into { point, type, options }. */
function parseMountLines(text) {
  const mounts = []
  for (const line of String(text || '').split('\n')) {
    const parts = line.split(/\s+/)
    if (parts.length >= 4 && parts[1].startsWith('/')) {
      mounts.push({ point: parts[1], type: parts[2], options: parts[3] || '' })
    }
  }
  return mounts
}

/**
 * Detect FUSE mounts on the system.
 * Returns a Set of mount points.
 */
export async function detectFuseMounts() {
  const mounts = []
  try {
    if (process.platform === 'linux') {
      try {
        const raw = await fsp.readFile('/proc/mounts', 'utf8')
        for (const m of parseMountLines(raw)) {
          if (m.type.startsWith('fuse')) mounts.push(m.point)
        }
      } catch {}
    } else if (process.platform === 'darwin') {
      // macOS has no /proc/mounts; use the `mount` command output.
      try {
        const raw = execFileSync('mount', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        for (const line of raw.split('\n')) {
          const m = /^\S+\s+on\s+(.+?)\s+\(([^,]+)/.exec(line)
          if (m && String(m[2]).startsWith('fuse')) mounts.push(m[1])
        }
      } catch {}
    }
    // Windows: FUSE is not a native concept; nothing to detect.
  } catch {}
  return new Set(mounts)
}

/**
 * Detect Docker volume mounts.
 * Returns a Set of mount points.
 */
export async function detectDockerMounts() {
  const mounts = []
  try {
    if (process.platform === 'linux') {
      try {
        const raw = await fsp.readFile('/proc/mounts', 'utf8')
        for (const m of parseMountLines(raw)) {
          // Docker volumes appear as bind mounts under the docker storage root.
          if (m.point.startsWith('/var/lib/docker')) mounts.push(m.point)
        }
      } catch {}
    }
  } catch {}
  return new Set(mounts)
}

/**
 * Detect WSL mounts (9p / drvfs filesystems).
 * Returns a Set of mount points.
 */
export async function detectWslMounts() {
  const mounts = []
  try {
    if (process.platform === 'linux') {
      try {
        const raw = await fsp.readFile('/proc/mounts', 'utf8')
        for (const m of parseMountLines(raw)) {
          if (m.type === '9p' || m.type === 'drvfs') mounts.push(m.point)
        }
      } catch {}
    }
  } catch {}
  return new Set(mounts)
}

/**
 * Detect read-only filesystems.
 * Returns a Set of mount points.
 */
export async function detectReadOnlyMounts() {
  const mounts = []
  try {
    if (process.platform === 'linux') {
      try {
        const raw = await fsp.readFile('/proc/mounts', 'utf8')
        for (const m of parseMountLines(raw)) {
          if (m.options.split(',').includes('ro')) mounts.push(m.point)
        }
      } catch {}
    }
  } catch {}
  return new Set(mounts)
}

/**
 * Detect all special mounts (FUSE, Docker, WSL, read-only).
 * Returns a Set of mount points.
 */
export async function detectSpecialMounts() {
  const fuse = await detectFuseMounts()
  const docker = await detectDockerMounts()
  const wsl = await detectWslMounts()
  const readonly = await detectReadOnlyMounts()
  return new Set([...fuse, ...docker, ...wsl, ...readonly])
}

/**
 * Build a refined policy that keeps every base root protected and adds the
 * realpath of each root (so a symlinked root still matches the paths actually
 * used), plus the detected special mounts as additional write-protected paths.
 *
 * @param {object} basePolicy  - the base policy from safety-core
 * @param {object} options     - options
 * @returns {object}           - refined policy (async)
 */
export async function refinePolicy(basePolicy, options = {}) {
  const {
    excludeSymlinks = true,
    excludeHardlinks = false,
    excludeMounts = true,
  } = options

  const specialMounts = await detectSpecialMounts()

  const refined = {
    blockWriteRoots: [],
    confirmDeleteRoots: [],
    readOnlyPaths: [],
    excludePaths: [],
    specialMounts: Array.from(specialMounts),
  }

  // Process each root in the base policy. Never DROP a root: keep the literal
  // path AND its realpath, so protection holds whether the caller addresses
  // the symlink or the target.
  for (const root of basePolicy.blockWriteRoots || []) {
    refined.blockWriteRoots.push(root)
    const realRoot = await realpath(root)
    if (realRoot !== root && !refined.blockWriteRoots.includes(realRoot)) {
      refined.blockWriteRoots.push(realRoot)
    }
  }

  for (const root of basePolicy.confirmDeleteRoots || []) {
    refined.confirmDeleteRoots.push(root)
    const realRoot = await realpath(root)
    if (realRoot !== root && !refined.confirmDeleteRoots.includes(realRoot)) {
      refined.confirmDeleteRoots.push(realRoot)
    }
  }

  // Special mounts are read-only or otherwise off-limits: fold them into the
  // write-protected set so the plain `classify` (which only understands
  // blockWriteRoots/confirmDeleteRoots) treats them as protected.
  for (const mount of specialMounts) {
    refined.readOnlyPaths.push(mount)
    if (excludeMounts && !refined.blockWriteRoots.includes(mount)) {
      refined.blockWriteRoots.push(mount)
    }
  }

  return refined
}

/**
 * Classify a path using the refined policy.
 */
export function classifyRefined(p, refinedPolicy) {
  // First check if it's under a read-only mount
  for (const mount of refinedPolicy.readOnlyPaths) {
    if (isUnder(p, mount)) return 'readonly'
  }
  // Then check exclude paths
  for (const ep of refinedPolicy.excludePaths) {
    if (isUnder(p, ep)) return 'excluded'
  }
  // Then normal classification
  for (const root of refinedPolicy.blockWriteRoots) {
    if (isUnder(p, root)) return 'protected'
  }
  for (const root of refinedPolicy.confirmDeleteRoots) {
    if (isUnder(p, root)) return 'confirm'
  }
  return 'free'
}

/**
 * Check if a path is under a read-only mount.
 */
export async function isUnderReadOnly(p) {
  const specialMounts = await detectSpecialMounts()
  for (const mount of specialMounts) {
    if (isUnder(p, mount)) return true
  }
  return false
}
