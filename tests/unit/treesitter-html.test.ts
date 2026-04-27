import { describe, it, expect } from 'vitest'
import { extractHtmlSymbols } from '../../src/indexer/treesitter/html.js'

describe('extractHtmlSymbols', () => {
  it('finds ids and custom elements', () => {
    const html = `
<div id="login-form">
  <my-button></my-button>
  <script src="./app.js"></script>
</div>`
    const out = extractHtmlSymbols('a.html', html)
    const kinds = out.map(s => s.kind).sort()
    expect(kinds).toContain('html-id')
    expect(kinds).toContain('custom-element')
    expect(out.find(s => s.kind === 'html-id')?.name).toBe('#login-form')
  })
})
