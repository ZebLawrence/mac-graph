import { describe, it, expect } from 'vitest'
import { extractCssSymbols } from '../../src/indexer/treesitter/css.js'

describe('extractCssSymbols', () => {
  it('finds class/id selectors and custom properties', () => {
    const css = `
:root { --primary: #000; }
.btn-primary { color: var(--primary); }
#sidebar { width: 200px; }
`
    const out = extractCssSymbols('a.css', css)
    const names = out.map(s => s.name).sort()
    expect(names).toContain('.btn-primary')
    expect(names).toContain('#sidebar')
    expect(names).toContain('--primary')
  })
})
