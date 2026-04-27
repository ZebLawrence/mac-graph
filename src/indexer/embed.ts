import { pipeline } from '@xenova/transformers'
import { log } from '../log.js'

type FE = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>

export class Embedder {
  private fe: FE | null = null

  constructor(private modelId: string) {}

  async ready(): Promise<void> {
    if (this.fe) return
    log.info({ model: this.modelId }, 'loading embedding model')
    const fe = await pipeline('feature-extraction', this.modelId)
    this.fe = fe as unknown as FE
    log.info({ model: this.modelId }, 'embedding model ready')
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ready()
    if (texts.length === 0) return []
    const out = await this.fe!(texts, { pooling: 'mean', normalize: true })
    const dim = out.dims[1]!
    const result: number[][] = []
    for (let i = 0; i < texts.length; i++) {
      const start = i * dim
      result.push(Array.from(out.data.slice(start, start + dim)))
    }
    return result
  }
}
