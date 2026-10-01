type UpgradeServer = { upgrade: (...args: any[]) => unknown }

const guardedServers = new WeakSet<UpgradeServer>()

export function guardDevWebSocketUpgrade(server: UpgradeServer): void {
  if (guardedServers.has(server)) return
  guardedServers.add(server)

  const upgrade = server.upgrade.bind(server)
  server.upgrade = async (...args) => {
    try {
      await upgrade(...args)
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ECONNRESET' && code !== 'EPIPE') {
        console.error('[nvent] dev WebSocket upgrade failed:', error)
      }
    }
  }
}