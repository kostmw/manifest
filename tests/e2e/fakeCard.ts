/**
 * Draws a stand-in card in the page: an MTG-like layout (black border, frame,
 * title bar, art box, text box) with a real card name in a bold serif, tilted
 * on a textured table. No real card art, so it can live in the repo, and the
 * title is genuine text for OCR to read. Runs inside the browser.
 */
export interface FakeCardOptions {
  title: string;
  /** A modern collector line at the bottom left: "R 0410" over "CMM • EN  ARTIST". */
  collector?: { set: string; number: string; rarity?: string };
  /** Radians. */
  rotation?: number;
  /** Turn the card upside down. */
  flipped?: boolean;
  width?: number;
  height?: number;
  /** Card width as a multiple of 488 pixels. */
  scale?: number;
  /** Where the card's centre is, from the middle of the picture, in pixels. */
  offset?: { x: number; y: number };
  /** The artwork's two gradient colours: different art gives a different fingerprint. */
  art?: [string, string];
  /** Just the table, no card. */
  noCard?: boolean;
}

export async function drawFakeCard(options: FakeCardOptions): Promise<string> {
  const { title, collector, rotation = 0.06, flipped = false, width = 900, height = 1200, scale = 1.15, offset = { x: 0, y: 0 } } = options;
  const [artFrom, artTo] = options.art ?? ['#5a7aa0', '#2a3040'];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // A wood-ish table.
  ctx.fillStyle = '#7a5a3a';
  ctx.fillRect(0, 0, width, height);
  for (let y = 0; y < height; y += 6) {
    ctx.fillStyle = `rgba(40, 25, 10, ${0.08 + 0.08 * Math.sin(y / 23)})`;
    ctx.fillRect(0, y, width, 3);
  }

  if (options.noCard) return canvas.toDataURL('image/png');

  const cardW = 488 * scale;
  const cardH = 680 * scale;
  const s = cardW / 488;
  ctx.save();
  ctx.translate(width / 2 + offset.x, height / 2 + offset.y);
  ctx.rotate(rotation + (flipped ? Math.PI : 0));
  ctx.translate(-cardW / 2, -cardH / 2);

  const rounded = (x: number, y: number, w: number, h: number, r: number, fill: string) => {
    ctx.beginPath();
    ctx.roundRect(x * s, y * s, w * s, h * s, r * s);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  rounded(0, 0, 488, 680, 22, '#111111'); // border
  rounded(20, 20, 448, 620, 10, '#b9a37a'); // frame
  rounded(30, 34, 428, 38, 8, '#efe7d4'); // title bar
  rounded(38, 80, 412, 296, 2, '#3d4d63'); // art
  const art = ctx.createLinearGradient(38 * s, 80 * s, 450 * s, 376 * s);
  art.addColorStop(0, artFrom);
  art.addColorStop(1, artTo);
  ctx.fillStyle = art;
  ctx.fillRect(40 * s, 82 * s, 408 * s, 292 * s);
  rounded(30, 382, 428, 34, 8, '#efe7d4'); // type line
  rounded(38, 424, 412, 200, 4, '#f3eee2'); // text box

  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold ${Math.round(27 * s)}px Georgia, "DejaVu Serif", "Times New Roman", serif`;
  ctx.fillText(title, 42 * s, 62 * s);
  ctx.font = `bold ${Math.round(22 * s)}px Georgia, "DejaVu Serif", serif`;
  ctx.fillText('Artifact', 42 * s, 407 * s);
  ctx.font = `${Math.round(20 * s)}px Georgia, "DejaVu Serif", serif`;
  ctx.fillText('Tap: Add two mana of', 50 * s, 462 * s);
  ctx.fillText('any one colour.', 50 * s, 490 * s);
  if (collector) {
    ctx.fillStyle = '#f2f2f2';
    ctx.font = `bold ${Math.round(10 * s)}px Arial, "DejaVu Sans", Helvetica, sans-serif`;
    ctx.fillText(`${collector.rarity ?? 'R'} ${collector.number.padStart(4, '0')}`, 30 * s, 655 * s);
    ctx.fillText(`${collector.set} \u2022 EN   JANE DOE`, 30 * s, 668 * s);
  }
  // A mana symbol at the end of the title bar.
  ctx.beginPath();
  ctx.arc(436 * s, 53 * s, 12 * s, 0, Math.PI * 2);
  ctx.fillStyle = '#cbc2b8';
  ctx.fill();
  ctx.restore();

  return canvas.toDataURL('image/png');
}
