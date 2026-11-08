import { z } from 'zod';

// ElevenLabs uses stability, similarity_boost, style, use_speaker_boost and speed (0.7 to 1.2).
// Cartesia uses speed (0.6 to 1.5), volume and emotion. Each ignores the others.
const voiceSettings = z.strictObject({
  stability: z.number().min(0).max(1).optional(),
  similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.6).max(1.5).optional(),
  use_speaker_boost: z.boolean().optional(),
  volume: z.number().min(0.5).max(2).optional(),
  emotion: z.string().min(1).optional(),
});
export type VoiceSettings = z.infer<typeof voiceSettings>;

const reference = z.strictObject({
  description: z.string().min(1),
  refs: z.array(z.string()).default([]),
});

export const VOICE_FX = ['radio'] as const;
export type VoiceFx = (typeof VOICE_FX)[number];

const character = z.strictObject({
  description: z.string().min(1),
  refs: z.array(z.string()).default([]),
  voice: z.string().min(1).optional(),
  settings: voiceSettings.optional(),
  /** `radio`: thin, band-limited, like a broadcast, intercom or tape. */
  fx: z.enum(VOICE_FX).optional(),
});

/**
 * A still frame added after the last shot, with text over it (e.g. where to play the game).
 * `text` keeps its line breaks and case; wrap words in *stars* to color them.
 */
const endCard = z.strictObject({
  image: z.string().min(1),
  text: z.string().min(1),
  seconds: z.number().min(1).max(10).default(3),
});

export const castSchema = z.strictObject({
  style: z.string().min(1),
  /** The series' end card, added to every episode. Paths are relative to cast.yaml. */
  end_card: endCard.optional(),
  narrator: z
    .strictObject({ voice: z.string().min(1), settings: voiceSettings.optional(), fx: z.enum(VOICE_FX).optional() })
    .optional(),
  characters: z.record(z.string(), character).default({}),
  locations: z.record(z.string(), reference).default({}),
  props: z.record(z.string(), reference).default({}),
});
export type Cast = z.infer<typeof castSchema>;

export const MOVES = ['push-in', 'pull-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'still'] as const;
export type Move = (typeof MOVES)[number];

export const TRANSITIONS = ['fade', 'cut', 'fadeblack'] as const;
export type Transition = (typeof TRANSITIONS)[number];

const line = z
  .record(z.string(), z.string().min(1))
  .refine((value) => Object.keys(value).length === 1, {
    message: 'Each line needs exactly one speaker, like `- narrator: "You wake up."`',
  });

/** One sound in a shot's sound bed. Layers with the same `sound` reuse one generated file. */
const sfxLayer = z.strictObject({
  sound: z.string().min(1),
  /** Seconds after the shot starts. */
  at: z.number().min(0).default(0),
  /** Length to generate; defaults to the rest of the shot. */
  seconds: z.number().min(0.5).max(22).optional(),
  /** Defaults to the shot's sfx_volume. */
  volume: z.number().min(0).max(2).optional(),
});

const shot = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/, 'Shot ids use lowercase letters, numbers and dashes')
      .optional(),
    image: z.string().min(1).optional(),
    image_file: z.string().min(1).optional(),
    location: z.string().optional(),
    cast: z.array(z.string()).default([]),
    props: z.array(z.string()).default([]),
    move: z.enum(MOVES).default('push-in'),
    transition: z.enum(TRANSITIONS).default('cut'),
    lines: z.array(line).default([]),
    /** One sound for the whole shot, or layers placed in time (e.g. three separate knocks). */
    sfx: z.union([z.string().min(1), z.array(sfxLayer).min(1)]).optional(),
    sfx_volume: z.number().min(0).max(2).default(0.5),
    hold: z.number().min(0.5).max(20).optional(),
    /** false: don't send reference images (for making the reference sheets themselves). */
    references: z.boolean().default(true),
    /**
     * An image of the set to edit this shot into, instead of drawing the room from scratch. Keeps the
     * layout fixed: the ladder and pipes stay where they are. A window of the shot's aspect is cut from it.
     */
    plate: z.string().min(1).optional(),
    /** Where the window is centred on the plate, as fractions: [0, 0] top left, [1, 1] bottom right. */
    plate_focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.5, 0.5]),
    /** 1 is the largest window that fits; 2 is half as wide (closer). */
    plate_zoom: z.number().min(1).max(4).default(1),
    /** true: the shot may change the plate's lighting (e.g. lights off). The layout still stays fixed. */
    relight: z.boolean().default(false),
    /** Things that must not be in the picture. Sent to the image model and failed by the checker. */
    avoid: z.array(z.string().min(1)).default([]),
  })
  .refine((value) => value.image !== undefined || value.image_file !== undefined, {
    message: 'Each shot needs `image` (a prompt) or `image_file` (a picture you already have)',
  });

export const ASPECTS = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
} as const;
export type Aspect = keyof typeof ASPECTS;

export const sceneSchema = z.strictObject({
  title: z.string().min(1),
  cast: z.string().default('cast.yaml'),
  aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).default('9:16'),
  captions: z.boolean().default(true),
  /** Shown at the top for the whole video, e.g. "HATCH · PART 1". */
  header: z.string().min(1).optional(),
  /** Overrides the series end card from cast.yaml for this episode; `false` turns it off. */
  end_card: z.union([endCard, z.literal(false)]).optional(),
  music: z.string().optional(),
  music_volume: z.number().min(0).max(1).default(0.12),
  shots: z.array(shot).min(1),
});
