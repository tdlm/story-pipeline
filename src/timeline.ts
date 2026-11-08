import type { Speech } from './speech.ts';
import type { Transition } from './schema.ts';

export const FPS = 30;

/** Frames of transition into a shot. A cut is a 2-frame blend: ffmpeg drops the rest of the video on a 1-frame one. */
const TRANSITION_FRAMES: Record<Transition, number> = { fade: 10, fadeblack: 15, cut: 2 };

const FIRST_LEAD = 0.25; // silence before the first line of the video
const AFTER_TRANSITION = 0.1; // lines start this long after a transition finishes
const GAP = 0.25; // between lines in the same shot
const TAIL = 0.5; // after the last line, before the next transition
const MIN_SHOT = 1.8;

export type TimedLine = { speech: Speech; start: number };

export type TimedShot = {
  start: number;
  duration: number;
  /** Length of the transition into this shot (0 for the first shot). */
  transitionIn: number;
  lines: TimedLine[];
};

export type ShotTiming = { transition: Transition; hold?: number; speeches: Speech[] };

/**
 * Lays the shots out end to end. Each shot lasts as long as its lines plus padding (or `hold`, if longer).
 * Shots overlap by their transition, and lines never play during a transition.
 * Everything is counted in whole frames, so the clips join exactly where the timeline says.
 */
export function buildTimeline(shots: ShotTiming[]): { shots: TimedShot[]; total: number } {
  const timed: TimedShot[] = [];
  let cursorFrames = 0;

  shots.forEach((shot, index) => {
    const transitionFrames = index === 0 ? 0 : TRANSITION_FRAMES[shot.transition];
    const startFrames = index === 0 ? 0 : cursorFrames - transitionFrames;
    const start = startFrames / FPS;
    const transitionIn = transitionFrames / FPS;
    const lead = index === 0 ? FIRST_LEAD : transitionIn + AFTER_TRANSITION;

    const lines: TimedLine[] = [];
    let time = start + lead;
    for (const speech of shot.speeches) {
      lines.push({ speech, start: time });
      time += speech.duration + GAP;
    }
    const spoken = shot.speeches.length > 0 ? time - GAP - start + TAIL : 0;
    const seconds = Math.max(shot.hold ?? MIN_SHOT, spoken, transitionIn + 0.5);
    const durationFrames = Math.ceil(seconds * FPS);

    timed.push({ start, duration: durationFrames / FPS, transitionIn, lines });
    cursorFrames = startFrames + durationFrames;
  });

  return { shots: timed, total: cursorFrames / FPS };
}
