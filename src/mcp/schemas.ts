import { z } from 'zod'

export const SymbolKindEnum = z.enum([
  'function','class','method','interface','type','variable',
  'html-id','css-class','css-id','css-var','json-key','custom-element'
])
export const LanguageEnum = z.enum(['ts','js','html','css','json','other'])

export const QueryInput = z.object({
  q: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  kinds: z.array(SymbolKindEnum).optional(),
  languages: z.array(LanguageEnum).optional()
})

export const ContextInput = z.object({
  symbol_id: z.string().optional(),
  name: z.string().optional(),
  kind: SymbolKindEnum.optional(),
  depth: z.number().int().min(1).max(3).optional()
}).refine(v => v.symbol_id || v.name, { message: 'symbol_id or name required' })

export const ImpactInput = z.object({
  symbol_id: z.string(),
  hops: z.number().int().min(1).max(4).optional()
})

export const DetectChangesInput = z.object({})

export const ReindexInput = z.object({
  mode: z.enum(['full','incremental']).optional(),
  paths: z.array(z.string()).optional()
}).refine(v => v.mode !== 'incremental' || (v.paths && v.paths.length > 0), {
  message: 'paths required when mode=incremental'
})
