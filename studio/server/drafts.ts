import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { env } from '../../src/env.ts';
import { castSchema, sceneSchema } from '../../src/schema.ts';
import type { Draft, Proposal, ProposalPreview } from './api-types.ts';
import { STORIES } from './library.ts';

const DRAFTS = (): string => join(env.studioDir, 'drafts');
const draftFile = (id: string): string => join(DRAFTS(), id, 'draft.json');
export const attachmentsDir = (id: string): string => join(DRAFTS(), id, 'attachments');
const DRAFT_ID = /^[a-f0-9-]{36}$/;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export async function saveDraft(draft: Draft): Promise<void> {
  await mkdir(dirname(draftFile(draft.id)), { recursive: true });
  const temp = `${draftFile(draft.id)}.tmp`;
  await writeFile(temp, JSON.stringify(draft, null, 2));
  await rename(temp, draftFile(draft.id));
}

export async function loadDraft(id: string): Promise<Draft | undefined> {
  if (!DRAFT_ID.test(id) || !existsSync(draftFile(id))) return undefined;
  return JSON.parse(await readFile(draftFile(id), 'utf8')) as Draft;
}

export async function listDrafts(): Promise<Draft[]> {
  if (!existsSync(DRAFTS())) return [];
  const ids = (await readdir(DRAFTS())).filter((id) => DRAFT_ID.test(id));
  const drafts = await Promise.all(ids.map((id) => loadDraft(id)));
  return drafts.filter((d): d is Draft => d !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A safe file name for an upload: letters, numbers, dots and dashes, never a path. */
const safeName = (name: string): string => basename(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'file';

export async function createDraft(input: {
  kind: Draft['kind'];
  show: string;
  title: string;
  kickoff: string;
  skill?: string;
  files: File[];
}): Promise<Draft> {
  const now = new Date().toISOString();
  const draft: Draft = {
    id: randomUUID(),
    kind: input.kind,
    show: input.show,
    title: input.title,
    createdAt: now,
    updatedAt: now,
    kickoff: input.kickoff,
    skill: input.skill ?? 'scottify',
    messages: [],
    proposals: [],
    attachments: [],
  };
  await addAttachments(draft, input.files);
  await saveDraft(draft);
  return draft;
}

export async function addAttachments(draft: Draft, files: File[]): Promise<void> {
  const dir = attachmentsDir(draft.id);
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    let name = safeName(file.name);
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${basename(safeName(file.name), extname(file.name))}-${n}${extname(file.name)}`;
    await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
    draft.attachments.push({ name, size: file.size, type: file.type });
  }
}

/** The folder a draft may write into: its show's folder. */
export const showDir = (draft: Draft): string => join(STORIES, draft.show);

/** Resolves a path Claude proposes, relative to the show folder, and refuses anything outside it. */
export function proposalPath(draft: Draft, path: string): string {
  const dir = showDir(draft);
  const full = resolve(dir, path.replace(/^stories\/[^/]+\//, ''));
  if (!full.startsWith(dir + sep)) throw new Error(`Proposals can only change files in stories/${draft.show}/.`);
  if (/\.(jpe?g|png|webp|gif|mp3|wav|mp4)$/i.test(full)) throw new Error('Proposals are text files only.');
  return full;
}

/** Checks a proposed YAML file against the scene or cast schema. Returns problems, or an empty list. */
export function validate(full: string, content: string): { problems: string[]; preview?: ProposalPreview } {
  if (!/\.ya?ml$/i.test(full)) return { problems: [] };
  let data: unknown;
  try {
    data = parse(content);
  } catch (error) {
    return { problems: [`Not valid YAML: ${(error as Error).message}`] };
  }
  const name = basename(full);
  if (name === 'show.yaml') return { problems: [] };
  const schema = name === 'cast.yaml' ? castSchema : sceneSchema;
  const result = schema.safeParse(data);
  if (!result.success) return { problems: [z.prettifyError(result.error)] };
  if (name === 'cast.yaml') return { problems: [] };
  const scene = result.data as z.infer<typeof sceneSchema>;
  return {
    problems: [],
    preview: {
      title: scene.title,
      header: scene.header,
      shots: scene.shots.map((shot, i) => ({
        number: i + 1,
        id: shot.id ?? `shot-${i + 1}`,
        prompt: shot.image,
        imageFile: shot.image_file,
        lines: shot.lines.flatMap((line) => Object.entries(line).map(([speaker, text]) => ({ speaker, text }))),
      })),
    },
  };
}

/** Records a proposal. A newer proposal for the same file replaces a pending one. */
export async function propose(draft: Draft, path: string, content: string, summary: string): Promise<Proposal> {
  const full = proposalPath(draft, path);
  const { problems, preview } = validate(full, content);
  if (problems.length > 0) throw new Error(`The file has problems; fix them and propose it again:\n${problems.join('\n')}`);
  const current = existsSync(full) ? await readFile(full, 'utf8') : undefined;
  const proposal: Proposal = {
    id: randomUUID(),
    path: `stories/${draft.show}/${relative(showDir(draft), full)}`,
    summary,
    content,
    before: current,
    baseSha: current === undefined ? null : sha(current),
    status: 'pending',
    createdAt: new Date().toISOString(),
    preview,
  };
  draft.proposals = draft.proposals.map((p) => (p.path === proposal.path && p.status === 'pending' ? { ...p, status: 'replaced' } : p));
  draft.proposals.push(proposal);
  return proposal;
}

/**
 * Writes an accepted proposal. Refuses if the file changed since it was proposed, and keeps the old
 * content in .studio/versions/files/ first.
 */
export async function accept(draft: Draft, proposalId: string): Promise<Proposal> {
  const proposal = draft.proposals.find((p) => p.id === proposalId);
  if (proposal === undefined || proposal.status !== 'pending') throw new Error('That proposal is no longer pending.');
  const full = proposalPath(draft, proposal.path);
  const current = existsSync(full) ? await readFile(full, 'utf8') : undefined;
  if (proposal.baseSha === null && current !== undefined) throw new Error(`${proposal.path} was created since this was proposed. Ask Claude to propose it again.`);
  if (proposal.baseSha !== null && (current === undefined || sha(current) !== proposal.baseSha)) {
    throw new Error(`${proposal.path} changed since this was proposed. Ask Claude to propose it again.`);
  }
  if (current !== undefined) {
    const versions = join(env.studioDir, 'versions', 'files', proposal.path.replace(/[\\/]/g, '-'));
    await mkdir(versions, { recursive: true });
    await writeFile(join(versions, `${Date.now()}${extname(full)}`), current, { flag: 'wx' });
  }
  await mkdir(dirname(full), { recursive: true });
  const temp = `${full}.tmp`;
  await writeFile(temp, proposal.content);
  await rename(temp, full);
  proposal.status = 'accepted';
  return proposal;
}
