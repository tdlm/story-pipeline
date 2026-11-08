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

export type ProposalPreview = {
  title: string;
  header?: string;
  shots: { number: number; id: string; prompt?: string; imageFile?: string; lines: { speaker: string; text: string }[] }[];
};

/** A file Claude wants to add or change. Nothing is written until you accept it. */
export type Proposal = {
  id: string;
  /** The file, as stories/<show>/<file>, such as stories/hatch/ep12.yaml. */
  path: string;
  summary: string;
  content: string;
  /** The file as it was when proposed; absent for a new file. */
  before?: string;
  /** Hash of `before`, checked again on accept; null for a new file. */
  baseSha: string | null;
  status: 'pending' | 'accepted' | 'dismissed' | 'replaced';
  createdAt: string;
  /** For episodes: the shots, for a readable preview. */
  preview?: ProposalPreview;
};

export type DraftMessage = {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Short notes on what Claude did during the turn, such as "Read ARC.md". */
  activity?: string[];
};

export type Draft = {
  id: string;
  kind: 'next-part' | 'new-show';
  show: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The writing skill to invoke when drafting, such as scottify. */
  skill: string;
  /** The first message, sent when the draft opens. */
  kickoff?: string;
  sessionId?: string;
  messages: DraftMessage[];
  proposals: Proposal[];
  attachments: { name: string; size: number; type: string }[];
};

/** Streamed to the page while Claude works on a turn. */
export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'activity'; note: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'done'; draft: Draft }
  | { type: 'error'; message: string };
