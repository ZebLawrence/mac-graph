import Docker from 'dockerode'
import { setTimeout as sleep } from 'node:timers/promises'

export async function waitHealthy(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not ready */ }
    await sleep(1000)
  }
  throw new Error(`timed out waiting for ${url}`)
}

export async function runContainer(opts: {
  image: string; repoDir: string; dataDir: string; wikiDir: string; port: number
}): Promise<Docker.Container> {
  const docker = new Docker()
  const container = await docker.createContainer({
    Image: opts.image,
    Env: ['BIND_ALL=1'],
    HostConfig: {
      Binds: [
        `${opts.repoDir}:/repo:ro`,
        `${opts.dataDir}:/data`,
        `${opts.wikiDir}:/wiki`
      ],
      PortBindings: { '3030/tcp': [{ HostIp: '127.0.0.1', HostPort: String(opts.port) }] }
    }
  })
  await container.start()
  return container
}
