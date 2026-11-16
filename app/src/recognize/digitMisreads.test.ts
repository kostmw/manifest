import { describe, expect, it } from 'vitest';
import { numberMisreadCost } from './digitMisreads';

describe('numberMisreadCost', () => {
  it("charges half for the swaps OCR makes in small fonts, and in full for any other (round 11's Doctor Who cards)", () => {
    expect(numberMisreadCost('557', '557')).toBe(0);
    expect(numberMisreadCost('587', '557')).toBe(0.5);
    expect(numberMisreadCost('860', '560')).toBe(0.5);
    expect(numberMisreadCost('546', '548')).toBe(0.5);
    expect(numberMisreadCost('390', '399')).toBe(1);
    expect(numberMisreadCost('617', '307')).toBe(2);
    expect(numberMisreadCost('1474', '474')).toBe(1);
  });
});
