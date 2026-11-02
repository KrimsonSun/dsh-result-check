import { describe, expect, it } from 'vitest'
import { extractClaims, isSourced, NumberIndex, unsourcedClaims } from '../../src/numbers.ts'

const raws = (text: string): string[] => extractClaims(text).map(c => c.raw)

function indexOf(...texts: string[]): NumberIndex {
  const index = new NumberIndex()
  for (const t of texts) index.add(t)
  return index
}

describe('extractClaims: what counts as a stated value', () => {
  it('reads decimals, grouped integers, percentages and Chinese context', () => {
    expect(raws('AUC was 0.873 on 1,708 cells; 12.5% failed QC.')).toEqual(['0.873', '1,708', '12.5%'])
    expect(raws('共1708个细胞，均值为7.12')).toEqual(['1708', '7.12'])
  })

  it('allows a short unit after the number', () => {
    expect(raws('took 1530ms and used 3.2GB, a 1.6x gap')).toEqual(['1530', '3.2', '1.6'])
  })

  it('skips small integers, years, and round figures', () => {
    expect(raws('3 files, 42 genes, in 2024, top 100 hits, 5000 rows, 50% done, 7% left')).toEqual([])
  })

  it('skips code, paths, URLs, versions, dates and times', () => {
    const text = [
      'Run `head -n 1708 data.csv` and see src/app.ts:120 or https://x.org/a/123.45',
      '```',
      'x = 0.873',
      '```',
      'Built with node 24.9.0 on 2026-11-02 at 12:30; fixed in #150.',
    ].join('\n')
    expect(raws(text)).toEqual([])
  })

  it('skips identifiers and references', () => {
    expect(raws('on an H100 with x86_64, see Section 3.2, step 12, port 8800, PR 150')).toEqual([])
  })

  it('skips hedged and bounded numbers', () => {
    expect(raws('about 1708 cells, ~0.87, p < 0.05, at least 250 reads, 约1500个, 300左右')).toEqual([])
  })

  it('skips list and heading numbering', () => {
    expect(raws('2.1 Results\n## 3.4 Methods\n1. first item')).toEqual([])
  })

  it('reports each written form once', () => {
    expect(raws('0.873 and again 0.873')).toEqual(['0.873'])
  })

  it('treats a sign as part of the text but compares magnitudes', () => {
    const [claim] = extractClaims('log2FC was -1.25')
    expect(claim).toMatchObject({ raw: '-1.25', value: 1.25 })
  })
})

describe('NumberIndex and isSourced: matching at the written precision', () => {
  it('accepts a claim that rounds from the source', () => {
    const index = indexOf('{"auc": 0.87312, "n": 1708}')
    expect(unsourcedClaims('AUC 0.873 over 1,708 cells', index)).toEqual([])
  })

  it('rejects a claim the source does not round to', () => {
    const index = indexOf('{"auc": 0.8712}')
    expect(unsourcedClaims('AUC 0.873', index).map(c => c.raw)).toEqual(['0.873'])
  })

  it('reads percentages against fractions and back', () => {
    expect(unsourcedClaims('12.5% of cells', indexOf('frac=0.125'))).toEqual([])
    expect(unsourcedClaims('a rate of 0.125', indexOf('rate: 12.5%'))).toEqual([])
  })

  it('reads scientific notation and grouped digits in sources', () => {
    expect(unsourcedClaims('p was 0.000312', indexOf('p=3.12e-4'))).toEqual([])
    expect(unsourcedClaims('15307 nuclei', indexOf('15,307 nuclei'))).toEqual([])
  })

  it('finds numbers inside identifiers and tables in sources', () => {
    expect(unsourcedClaims('1708 cells', indexOf('| AC | n_cells=1708 |'))).toEqual([])
  })

  it('flags a swapped count (the AiScientist case)', () => {
    const tool = '{"skipped_groups": [{"group": "Endothelial", "n_condition": 7, "n_reference": 27}], "AC": {"DDX41": 392, "WT": 258}}'
    const answer = '| Cell type | WT cells | DDX41 cells |\n|---|---|---|\n| AC | 469 | 181 |'
    expect(unsourcedClaims(answer, indexOf(tool)).map(c => c.raw)).toEqual(['469', '181'])
  })

  it('is empty-safe', () => {
    const index = new NumberIndex()
    expect(index.size).toBe(0)
    expect(isSourced({ raw: '0.5', value: 0.5, halfWidth: 0.05, percent: false }, index)).toBe(false)
  })
})
