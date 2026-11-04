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

  it('skips line references, phone numbers and named standards (seen in real answers)', () => {
    expect(raws([
      'See scrna_pack.py:562-566 and research_lab.py:4985-5172, app:2655-2661 and (js:3656-3663, 4971-4975).',
      'It skips shared folders (891-894) and `_push_staged` (2867) and `pushToSession` (4949, 4995-5003).',
      'Routes are at lines 9319–9338, called at 2623; close codes 4400–4499 stop reconnecting.',
      'Call +1 650-555-0142. ISBN 92-4-154542-9. Timestamps are ISO-8601; the lab needs ISO 15189.',
      'The link will return HTTP 404 and the job exits with code 137.',
    ].join('\n'))).toEqual([])
  })

  it('still reads values next to these patterns', () => {
    expect(raws('AC (469 cells) vs WT 181; log2FC -1.25 in 1,708 cells')).toEqual(['469', '181', '-1.25', '1,708'])
  })

  it('records a convertible unit', () => {
    expect(extractClaims('Sizes: 15.6 GB, 1530ms, 2.7 hours, 1.63M tokens, 42.7万句').map(c => c.unit))
      .toEqual(['GB', 'ms', 'hours', 'M', '万'])
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

  it('accepts a change of unit (sizes, scale words, time)', () => {
    expect(unsourcedClaims('the report is 13.9 KB', indexOf('-rw-r--r-- 1 u g 13917 report.md'))).toEqual([])
    expect(unsourcedClaims('the archive is 125 MB', indexOf('124763103 bytes'))).toEqual([])
    expect(unsourcedClaims('the BAM is 15.6 GiB', indexOf('size=16750372454'))).toEqual([])
    expect(unsourcedClaims('KV pool of 1.63M tokens', indexOf('kv_tokens: 1630412'))).toEqual([])
    expect(unsourcedClaims('语料共 42.7 万句', indexOf('sentences=427113'))).toEqual([])
    expect(unsourcedClaims('the upload needs 2.7 hours', indexOf('eta_s: 9731'))).toEqual([])
  })

  it('does not convert a number without a unit', () => {
    expect(unsourcedClaims('469 cells', indexOf('469000 reads')).map(c => c.raw)).toEqual(['469'])
  })

  it('accepts one arithmetic step on the answer\'s other numbers', () => {
    expect(unsourcedClaims('One node has 4×96 = 384GB, too little.', new NumberIndex())).toEqual([])
    expect(unsourcedClaims('282.33 vs 89.8 tok/s is a 3.14× speedup', indexOf('282.33 89.8'))).toEqual([])
    expect(unsourcedClaims('594.28 of 600 TiB used, so 5.72 TiB left', indexOf('594.28/600.00 TiB'))).toEqual([])
  })

  it('takes operands from inline code and lets the step change unit', () => {
    expect(unsourcedClaims('Quota is `590.11 TiB / 600 TiB`, so 9.9 TiB is left.', new NumberIndex())).toEqual([])
    expect(unsourcedClaims('8 runs × 605 s each = 80.7 min of waiting.', indexOf('preflight_s=605'))).toEqual([])
  })

  it('chains steps: a derived number can derive the next', () => {
    // 600 - 594.28 = 5.72; 5.72 / 2 = 2.86
    expect(unsourcedClaims('600 TiB, 594.28 used, 5.72 left, 2.86 per lab for 2 labs', indexOf('594.28'))).toEqual([])
  })

  it('does not let made-up numbers vouch for each other', () => {
    const tool = '{"AC": {"DDX41": 392, "WT": 258}}'
    const answer = '| AC | WT 469 | DDX41 181 | total 650 |'
    expect(unsourcedClaims(answer, indexOf(tool)).map(c => c.raw)).toEqual(['469', '181', '650'])
  })

  it('takes operands from the claim\'s paragraph unless told to use the whole answer', () => {
    const answer = 'Node: 4 cards of 96 GB.\n\nSo one node holds 384 GB.'
    expect(unsourcedClaims(answer, new NumberIndex()).map(c => c.raw)).toEqual(['384'])
    expect(unsourcedClaims(answer, new NumberIndex(), { derivedScope: 'answer' })).toEqual([])
    expect(unsourcedClaims('| GPU | 4 | 96 GB |\n| total | | 384 GB |', new NumberIndex())).toEqual([])
  })

  it('accepts column totals, means and shares of a table, also cited outside it (seen with DeepSeek)', () => {
    const counts = indexOf('{"groups": [{"n_condition": 4210, "n_reference": 3987}, {"n_condition": 1532, "n_reference": 1764}]}')
    const table = '| Cell type | WT | DDX41 |\n|---|---|---|\n| Rod | 3,987 | 4,210 |\n| Muller glia | 1,764 | 1,532 |\n| **Total** | **5,751** | **5,742** |'
    expect(unsourcedClaims(table, counts)).toEqual([])
    const services = indexOf('{"requests": 18234511} {"requests": 9876104} {"requests": 2345678}')
    const report = '| 服务 | 请求数 |\n|---|---|\n| auth | 18,234,511 |\n| search | 9,876,104 |\n| billing | 数据缺失 |\n| payments | 2,345,678 |\n\n'
      + '- 三个可用服务合计：30,456,293 次请求\n  - auth 占 59.9%，search 占 32.4%'
    expect(unsourcedClaims(report, services)).toEqual([])
    const survey = '| 选项 | 人数 | 占比 |\n|---|---|---|\n| 地铁 | 612 | 33.2% |\n| 公交 | 401 | 21.7% |\n| 其他 | 833 | 45.1% |\n\n选择地铁或公交的人合计 1013 人，地铁领先公交 11.5 个百分点。'
    expect(unsourcedClaims(survey, indexOf('{"地铁": 612, "公交": 401, "其他": 833}'))).toEqual([])
    const runs = '| run | best |\n|---|---|\n| r1 | 0.8712 |\n| r2 | 0.8834 |\n| r3 | 0.8521 |\n| r5 | 0.8907 |\n\nMean best accuracy: 0.87435.'
    expect(unsourcedClaims(runs, indexOf('0.8712 0.8834 0.8521 0.8907'))).toEqual([])
  })

  it('checks working the answer writes out', () => {
    expect(unsourcedClaims('WT: 3,987 + 1,764 + 258 + 2,655 = **8,664** cells', indexOf('3987 1764 258 2655'))).toEqual([])
    expect(unsourcedClaims('Mean: (0.8712 + 0.8834 + 0.8521 + 0.8907) / 4 = 0.87435', indexOf('0.8712 0.8834 0.8521 0.8907'))).toEqual([])
    expect(unsourcedClaims('| `/api/cart` | **1** | 1.3% (1/80) |', indexOf('cart 1 of 80'))).toEqual([])
    // Wrong working is still flagged: 412,876,543,210 / 541,382,714,793 is 0.7626334.
    expect(unsourcedClaims('Cross-check: 412,876,543,210 / 541,382,714,793 = 0.76264', indexOf('412876543210 541382714793')).map(c => c.raw))
      .toEqual(['0.76264'])
  })

  it('accepts relative changes, complements and percentage points', () => {
    expect(unsourcedClaims('p95 is 9.5% worse (97.1 vs 88.7 ms)', indexOf('97.1 88.7'))).toEqual([])
    expect(unsourcedClaims('data takes 76.3% of the volume; the other five take 23.7%', indexOf('0.763'))).toEqual([])
    expect(unsourcedClaims('difference +17.73 pp (95% CI +9.0 to +26.4 pp)', indexOf('17.73 0.0904 0.2643'))).toEqual([])
  })

  it('accepts a scale word over a table kept in thousands, and skips examples', () => {
    expect(unsourcedClaims('Revenue: 18,324.1 (USD thousands) = $18.32M', indexOf('18324.1'))).toEqual([])
    expect(unsourcedClaims('pick b if your p95 SLO is looser (e.g. 150 ms)', indexOf('88.7 97.1'))).toEqual([])
  })

  it('still flags made-up numbers in tables and in written-out working', () => {
    const tool = '{"AC": {"DDX41": 392, "WT": 258}, "MG": {"DDX41": 1532, "WT": 1764}}'
    const table = '| Cell type | WT | DDX41 |\n|---|---|---|\n| AC | 469 | 181 |\n| MG | 1,764 | 1,532 |\n| **Total** | **2,233** | **1,713** |'
    expect(unsourcedClaims(table, indexOf(tool)).map(c => c.raw)).toEqual(['469', '181', '2,233', '1,713'])
    expect(unsourcedClaims('WT 469 + DDX41 181 = 650 cells', indexOf(tool)).map(c => c.raw)).toEqual(['469', '181', '650'])
  })

  it('can turn derivation off', () => {
    expect(unsourcedClaims('4×96 = 384GB', new NumberIndex(), { allowDerived: false }).map(c => c.raw)).toEqual(['384'])
  })

  it('is empty-safe', () => {
    const index = new NumberIndex()
    expect(index.size).toBe(0)
    expect(isSourced({ raw: '0.5', value: 0.5, halfWidth: 0.05, percent: false }, index)).toBe(false)
  })
})
