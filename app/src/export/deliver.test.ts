import { describe, expect, it } from 'vitest';
import { exportFileName } from './deliver';

describe('exportFileName', () => {
  it.each([
    ['Box 3 – Rares', 'moxfield', 'csv', 'box-3-rares-moxfield.csv'],
    ['Séance', 'plain', 'txt', 'seance-plain.txt'],
    ['../../etc', 'markdown', 'md', 'etc-markdown.md'],
    ['カード', 'plain', 'txt', 'batch-plain.txt'],
  ])('%s gives a safe file name', (batch, format, extension, expected) => {
    expect(exportFileName(batch, format, extension)).toBe(expected);
  });
});
