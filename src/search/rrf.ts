export interface RrfResult { id: string; score: number }

export function reciprocalRankFusion(rankings: string[][], k = 60): RrfResult[] {
  const score = new Map<string, number>()
  for (const list of rankings) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1))
    }
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score)
}
