/** Shapes the studio server returns. The web app imports these as types only. */

export type EpisodeStage = 'not-started' | 'pictures' | 'voices' | 'draft' | 'final';

export type EpisodeSummary = {
  /** The scene file's name without .yaml, such as "ep01". Used in URLs. */
  id: string;
  title: string;
  header?: string;
  kind: 'episode' | 'asset';
  stage: EpisodeStage;
  /** One plain sentence saying where it stands or what to do next. */
  status: string;
  shots: number;
  /** Shots with a picture that isn't kept yet. */
  toReview: number;
  /** Shots whose picture is settled: kept, or a picture you supplied. */
  done: number;
  /** URL of the first shot's picture, if it has one. */
  cover?: string;
  /** Problems that stop the scene from loading. */
  error?: string;
};

export type ShowSummary = {
  id: string;
  name: string;
  episodes: EpisodeSummary[];
};

export type ShotState = 'kept' | 'to-review' | 'not-drawn' | 'own-picture';

export type ShotDetail = {
  number: number;
  id: string;
  state: ShotState;
  image?: string;
  prompt?: string;
  move: string;
  transition: string;
  cast: string[];
  location?: string;
  lines: { speaker: string; text: string }[];
};

export type EpisodeDetail = EpisodeSummary & {
  show: { id: string; name: string };
  aspect: string;
  width: number;
  height: number;
  shotList: ShotDetail[];
  video?: { kind: 'final' | 'draft'; url: string };
};
