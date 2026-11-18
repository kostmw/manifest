import { describe, expect, it } from 'vitest';
import { matchMtgCollector, mtgPrintingPrior, parseMtgCollectorLine, printedSetCodes, setCodeDistance } from './collector';

describe('parseMtgCollectorLine', () => {
  // Real Tesseract output on the eval's photos: spaces dropped, separators mangled.
  it.each([
    [['U0046 m&', 'EOE-EN&CartosParmaCaucnaca'], ['46'], ['EOE'], 'en'],
    [['083/261C', 'DMR*EN&GEORGEPRATT &'], ['83'], ['DMR'], 'en'],
    [['R0166 we cM', 'LTRaENlesemrErsinc W&'], ['166'], ['LTR'], 'en'],
    [['016/184R a &', 'OGWeENtYerinKEIGERMAN'], ['16'], ['OGW'], 'en'],
    [['023/332U', '2xm-ENCaccDescmames we'], ['23'], ['2XM'], 'en'],
    [['0S7/289U', 'TSR-EN&TsuTomuKawadt &'], ['57'], ['TSR'], 'en'],
    [['052/168R ww', '40KeENARTURNAKHODKIN IM&'], ['52'], ['40K'], 'en'],
    [['R 0005', 'REX • DE  INKOGNIT'], ['5'], ['REX'], 'de'],
    [['C0249', 'TLA-&N&leConseco'], ['249'], ['TLA'], 'en'],
    [['224/264R', 'WAR-*EN0RYANPANCOAST'], ['224'], ['WAR'], 'en'],
    [['R0166', 'LTRaENlesemrErsinc'], ['166'], ['LTR'], 'en'],
  ])('reads %j', (lines, numbers, sets, lang) => {
    const reading = parseMtgCollectorLine(lines)!;
    expect(reading.numbers).toEqual(numbers);
    expect(reading.sets[0]).toBe(sets[0]);
    expect(reading.lang).toBe(lang);
  });

  it('finds the set code when the separator was read as a letter or digit (round 11, Doctor Who)', () => {
    for (const [line, number] of [
      ['R0418 / WHOCENtyAtsranntaGraine.', '418'],
      ['R1066 / WHOPENfeLOGANFILICIANO', '1066'],
      ['ROS16 / WHOTENteNinois', '516'],
      ['RO395 / WWHOCENGfaisarnaSCTIawas', '395'],
      ['R0S46 / WHOPSEN&StrveMonats', '546'],
    ] as const) {
      const reading = parseMtgCollectorLine(line.split(' / '))!;
      expect(reading.sets).toContain('WHO');
      expect(reading.lang).toBe('en');
      expect(matchMtgCollector(reading, { set: 'who', number }).set).toBe('exact');
    }
    // The likelier readings still come first.
    expect(parseMtgCollectorLine(['C0249', 'TLA-&N&leConseco'])!.sets[0]).toBe('TLA');
    expect(parseMtgCollectorLine(['R0166', 'LTRaENlesemrErsinc'])!.sets[0]).toBe('LTR');
  });

  it('takes the number and set size from the copyright line of 2003–2014 frames', () => {
    const reading = parseMtgCollectorLine(['™&©1993–2010WizardsoftheCoastLLC36/249'])!;
    expect(reading.numbers).toEqual(['36']);
    expect(reading.total).toBe('249');
    expect(reading.sets).toEqual([]);
  });

  it('splits the digits of a copyright line that lost its slash every plausible way', () => {
    const reading = parseMtgCollectorLine(['B&2013WizardsoftheCoes2481'])!;
    expect(reading.numbers).toEqual(['24']); // Not 2 of 481: no set of that era was so big.
    expect(reading.looseNumbers).toBe(true);
    expect(parseMtgCollectorLine(['B.xO1993-2009WizardsoftheCuastInc.29145'])!.numbers).toEqual(['29']);
  });

  it('counts a loose guess as weaker evidence than a clean read', () => {
    const loose = matchMtgCollector({ numbers: ['24'], sets: [], looseNumbers: true, text: '' }, { set: 'ddl', number: '24' });
    const clean = matchMtgCollector({ numbers: ['24'], sets: [], text: '' }, { set: 'ddl', number: '24' });
    expect(loose.score).toBeLessThan(clean.score);
  });

  it('never takes the set size, or digits in the set code, for a number', () => {
    expect(parseMtgCollectorLine(['083/261C', 'M15•EN'])!.numbers).toEqual(['83']);
    expect(parseMtgCollectorLine(['M15•EN JOHN AVON'])!.numbers).toEqual([]);
  });

  it('reads a zero-padded number cleanly whatever OCR made of the rarity letter before it (round 7, TRK)', () => {
    for (const [line, number] of [['U0230', '230'], ['V0230', '230'], ['VU0230', '230'], ['J0108', '108'], ['0376', '376'], ['-0124', '124'], ['T0020', '20']] as const) {
      const reading = parseMtgCollectorLine([line, 'TRK•EN JOHN DOE'])!;
      expect(reading.numbers).toEqual([number]);
      expect(reading.looseNumbers).toBeUndefined();
    }
  });

  it('tries a loose number without its first digit, which may be the rarity read as a digit', () => {
    // "C 0428" read as "2428": TRK 428 must be among the numbers tried.
    expect(parseMtgCollectorLine(['2428'])).toMatchObject({ numbers: ['2428', '428'], looseNumbers: true });
    expect(parseMtgCollectorLine(['20428'])).toMatchObject({ numbers: ['428'], looseNumbers: true });
    // A copyright year is never mistaken for a zero-padded number.
    expect(parseMtgCollectorLine(['TM&©2026CBS'])).toMatchObject({ numbers: ['2026'], looseNumbers: true });
  });

  it('falls back to a bare number when the rarity or slash is lost', () => {
    expect(parseMtgCollectorLine(['0412 ~', 'XYZ'])!.numbers).toEqual(['412']);
  });

  it('returns null for junk', () => {
    expect(parseMtgCollectorLine(['~~ ..', ''])).toBeNull();
  });
});

describe('setCodeDistance', () => {
  it('charges less for characters OCR confuses', () => {
    expect(setCodeDistance('M15', 'M15')).toBe(0);
    expect(setCodeDistance('M1S', 'M15')).toBeLessThan(0.5);
    expect(setCodeDistance('OMR', 'DMR')).toBeLessThan(0.5);
    expect(setCodeDistance('KLD', 'AER')).toBeGreaterThanOrEqual(2);
  });
});

describe('matchMtgCollector', () => {
  const reading = (numbers: string[], sets: string[]) => ({ numbers, sets, text: '' });

  it('scores set and number agreement', () => {
    expect(matchMtgCollector(reading(['46'], ['EOE']), { set: 'eoe', number: '46' })).toMatchObject({ number: 'exact', set: 'exact' });
    expect(matchMtgCollector(reading(['46'], ['EOE']), { set: 'eoe', number: '47' })).toMatchObject({ number: 'conflict', set: 'exact' });
    expect(matchMtgCollector(reading(['46'], []), { set: 'eoe', number: '46' })).toMatchObject({ number: 'exact', set: 'unread' });
    expect(matchMtgCollector(reading([], []), { set: 'eoe', number: '46' }).score).toBe(0);
  });

  it('ranks a set\'s own printing above a promo or List card printed with its code', () => {
    const own = matchMtgCollector(reading(['166'], ['LTR']), { set: 'ltr', number: '166' });
    const promo = matchMtgCollector(reading(['166'], ['LTR']), { set: 'pltr', number: '166s' });
    expect(own.set).toBe('exact');
    expect(promo).toMatchObject({ number: 'exact', set: 'close' });
    expect(own.score).toBeGreaterThan(promo.score);
    expect(matchMtgCollector(reading(['70'], ['DOM']), { set: 'plst', number: 'DOM-70' })).toMatchObject({ number: 'exact' });
  });

  it('knows which codes each printing shows', () => {
    expect(printedSetCodes({ set: 'pltr', number: '166s' })).toEqual({ exact: ['PLTR'], derived: ['LTR'] });
    expect(printedSetCodes({ set: 'plst', number: 'DOM-70' }).exact).toEqual(['DOM']);
  });
});

describe('mtgPrintingPrior', () => {
  it('puts promos and List reprints a little behind the set\'s own printing', () => {
    expect(mtgPrintingPrior({ set: 'ltr', number: '166' })).toBe(0);
    expect(mtgPrintingPrior({ set: 'pltr', number: '166s' })).toBeLessThan(0);
    expect(mtgPrintingPrior({ set: 'plst', number: 'DOM-70' })).toBeLessThan(0);
  });
});
