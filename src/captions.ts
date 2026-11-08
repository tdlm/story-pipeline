import type { Word } from './speech.ts';

export type CaptionLine = { start: number; words: Word[] };

const MAX_WORDS = 3;
const MAX_CHARS = 16;
const HIGHLIGHT = '&H00D7FF&'; // yellow, in ASS's BGR order

const assTime = (seconds: number): string => {
  const centis = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(centis / 360000);
  const m = Math.floor((centis % 360000) / 6000);
  const s = Math.floor((centis % 6000) / 100);
  const cs = centis % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};

const clean = (text: string): string => text.replace(/[{}\\]/g, '').toUpperCase();

/** Splits a line into short caption chunks: up to 3 words, breaking after punctuation. */
function chunk(words: Word[]): Word[][] {
  const chunks: Word[][] = [];
  let current: Word[] = [];
  words.forEach((word, index) => {
    const length = current.reduce((sum, w) => sum + w.text.length + 1, 0) + word.text.length;
    // Let a line's last word join the chunk before it rather than sit alone ("ARE WE GOING UP?").
    const isLast = index === words.length - 1;
    const maxWords = isLast ? MAX_WORDS + 1 : MAX_WORDS;
    const maxChars = isLast ? MAX_CHARS + 6 : MAX_CHARS;
    if (current.length > 0 && (current.length >= maxWords || length > maxChars)) {
      chunks.push(current);
      current = [];
    }
    current.push(word);
    if (/[.,!?;:…]$/.test(word.text)) {
      chunks.push(current);
      current = [];
    }
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Builds an ASS subtitle file: bold caps, white with a dark outline, highlighted words in yellow,
 * plus an optional series header at the top for the whole video.
 */
export function buildCaptions(
  lines: CaptionLine[],
  options: {
    width: number;
    height: number;
    font: string;
    total: number;
    header?: string;
    /** Text cards over still frames (the end card): upper middle, in a dark box. */
    cards?: { start: number; end: number; text: string }[];
  },
): string {
  const { width, height, font } = options;
  const fontSize = Math.round(height * (width < height ? 0.056 : 0.07));
  // Vertical video: keep captions in the safe band between 61% and 75% of the height.
  const marginV = Math.round(height * (width < height ? 0.25 : 0.1));
  const marginH = Math.round(width * 0.11);

  const headerSize = Math.round(fontSize * 0.55);
  // Below the top 14% that the app's own controls cover.
  const headerMargin = Math.round(height * (width < height ? 0.155 : 0.06));

  const events: string[] = [];
  const cards = options.cards ?? [];
  if (options.header !== undefined) {
    // The header stops where the end card starts.
    const headerEnd = cards[0]?.start ?? options.total;
    events.push(`Dialogue: 1,${assTime(0)},${assTime(headerEnd)},Header,,0,0,0,,${clean(options.header)}`);
  }
  // End card: first line large (the title), the rest smaller, no wrapping, over a dimmed picture.
  const cardBody = Math.round(height * (width < height ? 0.03 : 0.045));
  for (const card of cards) {
    const text = card.text
      .trim()
      .replace(/[{}\\]/g, '')
      .replace(/\*([^*]+)\*/g, `{\\c${HIGHLIGHT}}$1{\\c&HFFFFFF&}`)
      .split(/\r?\n/)
      .map((line, i) => (i === 0 ? `{\\fs${cardBody * 2.4}}${line}{\\fs${cardBody}}` : line))
      .join('\\N');
    events.push(`Dialogue: 2,${assTime(card.start)},${assTime(card.end)},Card,,0,0,0,,{\\q2\\fad(250,0)}${text}`);
  }
  for (const line of lines) {
    const chunks = chunk(line.words);
    chunks.forEach((words, i) => {
      const first = words[0];
      const last = words.at(-1);
      if (first === undefined || last === undefined) return;
      const next = chunks[i + 1]?.[0];
      const start = line.start + first.start;
      const end = line.start + (next === undefined ? last.end + 0.2 : next.start);
      const text = words
        .map((word) => (word.highlight ? `{\\c${HIGHLIGHT}}${clean(word.text)}{\\c&HFFFFFF&}` : clean(word.text)))
        .join(' ');
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)}${text}`,
      );
    });
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${font},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,${Math.round(fontSize * 0.08)},${Math.round(fontSize * 0.04)},2,${marginH},${marginH},${marginV},1`,
    `Style: Header,${font},${headerSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,3,0,1,${Math.round(headerSize * 0.1)},${Math.round(headerSize * 0.05)},8,${marginH},${marginH},${headerMargin},1`,
    `Style: Card,${font},${cardBody},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,${Math.round(cardBody * 0.09)},${Math.round(cardBody * 0.05)},8,${marginH},${marginH},${Math.round(height * 0.2)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
