import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Manifest } from './types.js'

const NAME = 'manifest.json'

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(dir, NAME), 'utf8')
    return JSON.parse(raw) as Manifest
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeManifest(dir: string, m: Manifest): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, NAME), JSON.stringify(m, null, 2), 'utf8')
}
