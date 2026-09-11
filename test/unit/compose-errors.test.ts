import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyComposeStartupError, ComposeManager, ComposeStartupError } from '../../packages/nvent/src/runtime/nitro/utils/compose'

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`)
}

describe('compose startup error mapping', () => {
  it('maps invalid namespace errors', () => {
    expect(classifyComposeStartupError('Invalid namespace: foo')).toBe('INVALID_NAMESPACE')
  })

  it('maps engine startup timeout errors', () => {
    expect(classifyComposeStartupError('engine startup timeout while waiting for worker-manager')).toBe('ENGINE_STARTUP_TIMEOUT')
  })

  it('maps managed endpoint mismatch errors', () => {
    expect(classifyComposeStartupError('managed engine endpoint mismatch')).toBe('MANAGED_ENGINE_ENDPOINT_MISMATCH')
  })

  it('maps generic startup timeout errors', () => {
    expect(classifyComposeStartupError('compose up timeout after 120000ms')).toBe('STARTUP_TIMEOUT')
  })

  it('maps port collisions to project did not start', () => {
    expect(classifyComposeStartupError('Address already in use (os error 98)')).toBe('PROJECT_DID_NOT_START')
  })

  it('maps package resolution failures explicitly', () => {
    expect(classifyComposeStartupError('up failed [PACKAGE_NOT_RESOLVED] after 1.6s')).toBe('PACKAGE_NOT_RESOLVED')
  })

  it('mentions registry outages for package resolution 503 errors', () => {
    const err = new ComposeStartupError(
      'PACKAGE_NOT_RESOLVED',
      'Compose startup failed.',
      'The iii registry returned HTTP 503 while resolving package workers. This is a registry or network outage, not a local compose config issue. Retry later or check registry access.',
      'up failed [PACKAGE_NOT_RESOLVED] no version of "queue" satisfies "0.21.11". HTTP 503: Service Temporarily Unavailable',
    )

    expect(err.message).toContain('[PACKAGE_NOT_RESOLVED]')
    expect(err.message).toContain('HTTP 503')
  })

  it('falls back to generic compose up failed', () => {
    expect(classifyComposeStartupError('something unexpected happened')).toBe('COMPOSE_UP_FAILED')
  })

  it('renders compose startup error message with code and hint', () => {
    const err = new ComposeStartupError('STARTUP_TIMEOUT', 'Compose startup failed.', 'Increase timeout.', 'compose up timeout')
    expect(err.message).toContain('[STARTUP_TIMEOUT]')
    expect(err.message).toContain('hint: Increase timeout.')
    expect(err.message).toContain('detail: compose up timeout')
  })

  it.skipIf(process.platform === 'win32')('sends Ctrl+C to the complete compose process group', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nvent-compose-stop-'))
    const binaryPath = join(fixtureDir, 'fake-compose')
    const composeFilePath = join(fixtureDir, 'worker-compose.yaml')
    const childPidPath = join(fixtureDir, 'child.pid')
    const signalPath = join(fixtureDir, 'signal')
    writeFileSync(binaryPath, `#!/bin/sh
sleep 30 &
child_pid=$!
printf '%s' "$child_pid" > "$III_COMPOSE_STATE_DIR/child.pid"
  trap 'printf SIGINT > "$III_COMPOSE_STATE_DIR/signal"; exit 0' INT
echo 'up: 1 of 1 changed'
wait "$child_pid"
`)
    chmodSync(binaryPath, 0o755)
    writeFileSync(composeFilePath, 'containers: {}\n')

    let manager: ComposeManager | undefined
    let childPid: number | undefined
    try {
      manager = new ComposeManager({
        binaryPath,
        composeFilePath,
        daemonNamespace: 'test',
        composeStateDir: fixtureDir,
        shutdownTimeoutMs: 200,
        logLevel: 'none',
      })

      await manager.start()
      childPid = Number(readFileSync(childPidPath, 'utf8'))
      expect(isProcessRunning(childPid)).toBe(true)

      await manager.stop()

      expect(readFileSync(signalPath, 'utf8')).toBe('SIGINT')
      expect(manager.isRunning()).toBe(false)
      expect(isProcessRunning(childPid)).toBe(false)
    }
    finally {
      await manager?.stop()
      if (childPid && isProcessRunning(childPid)) {
        try { process.kill(childPid, 'SIGKILL') } catch {}
      }
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('aborts compose when the Nuxt owner process exits immediately', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nvent-compose-parent-exit-'))
    const binaryPath = join(fixtureDir, 'fake-compose')
    const enginePath = join(fixtureDir, 'fake-engine')
    const composeFilePath = join(fixtureDir, 'worker-compose.yaml')
    const composeSignalPath = join(fixtureDir, 'compose-signal')
    const engineSignalPath = join(fixtureDir, 'engine-signal')
    const enginePidPath = join(fixtureDir, 'engine-pid')
    const readyPath = join(fixtureDir, 'ready')
    writeFileSync(enginePath, `#!${process.execPath}
import { writeFileSync } from 'node:fs'
const stateDir = process.env.III_COMPOSE_STATE_DIR
writeFileSync(\`${'${stateDir}'}/engine-pid\`, String(process.pid))
process.once('SIGINT', () => {
  writeFileSync(\`${'${stateDir}'}/engine-signal\`, 'SIGINT')
  process.exit(0)
})
setInterval(() => {}, 1000)
  `)
    writeFileSync(binaryPath, `#!/bin/sh
  setsid "$III_COMPOSE_STATE_DIR/fake-engine" &
  engine_pid=$!
  trap 'printf SIGINT > "$III_COMPOSE_STATE_DIR/compose-signal"; exit 0' INT
  echo 'engine started'
  echo "pid: $engine_pid"
echo 'up: 1 of 1 changed'
wait
`)
    chmodSync(enginePath, 0o755)
    chmodSync(binaryPath, 0o755)
    writeFileSync(composeFilePath, 'containers: {}\n')

    const script = `
      import { ComposeManager } from ${JSON.stringify(new URL('../../packages/nvent/src/runtime/nitro/utils/compose.ts', import.meta.url).href)}
      import { writeFileSync } from 'node:fs'
      const manager = new ComposeManager(${JSON.stringify({
        binaryPath,
        composeFilePath,
        daemonNamespace: 'test',
        composeStateDir: fixtureDir,
        shutdownTimeoutMs: 200,
        logLevel: 'none',
      })})
      await manager.start()
      writeFileSync(${JSON.stringify(readyPath)}, 'ready')
      process.exit(0)
    `

    let enginePid = 0
    try {
      const owner = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
      await new Promise<void>((resolve, reject) => {
        owner.once('exit', code => code === 0 ? resolve() : reject(new Error(`owner exited with ${code}`)))
        owner.once('error', reject)
      })
      await waitForFile(readyPath)
      await waitForFile(enginePidPath)
      enginePid = Number(readFileSync(enginePidPath, 'utf8'))
      await waitForFile(composeSignalPath)
      await waitForFile(engineSignalPath)
      expect(readFileSync(composeSignalPath, 'utf8')).toBe('SIGINT')
      expect(readFileSync(engineSignalPath, 'utf8')).toBe('SIGINT')
      expect(isProcessRunning(enginePid)).toBe(false)
    }
    finally {
      if (enginePid && isProcessRunning(enginePid)) {
        try { process.kill(-enginePid, 'SIGKILL') } catch {}
      }
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})
