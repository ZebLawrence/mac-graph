import { z } from 'zod'

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(3030),
  BIND_ALL: z.string().transform(v => v === '1' || v === 'true').default('0'),
  DATA_DIR: z.string().default('/data'),
  REPO_DIR: z.string().default('/repo'),
  WIKI_DIR: z.string().default('/wiki'),
  EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
  LOG_LEVEL: z.string().default('info')
})

export type Env = z.infer<typeof Schema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  return Schema.parse(source)
}

export const env: Env = parseEnv(process.env)
