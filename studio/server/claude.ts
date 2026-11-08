import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ROOT } from '../../src/env.ts';
import type { Draft, TurnEvent } from './api-types.ts';
import { attachmentsDir, propose, saveDraft, showDir } from './drafts.ts';
import { showContext } from './shows.ts';

/** The Claude model for writing. Settings will let you choose per step; the app never switches on its own. */
const MODEL = process.env.STUDIO_MODEL ?? 'claude-opus-5-5';
const STUDIO = join(ROOT, 'studio');
const running = new Set<string>();

/** Use the Claude login (Max plan), never an API key that happens to be in the environment. */
function childEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  delete copy.ANTHROPIC_API_KEY;
  return copy;
}

const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

async function setup(draft: Draft) {
  const dir = showDir(draft);
  const attachments = attachmentsDir(draft.id);
  const isNew = draft.kind === 'new-show';
  const context = isNew ? undefined : await showContext(draft.show);
  const skill = context?.skill ?? 'scottify';
  const skillDir = join(STUDIO, '.claude', 'skills', skill);
  const hasSkill = existsSync(skillDir);

  // Claude may read the show's folder, its listed context, this draft's attachments and the writing skill. Nothing else.
  const readable = {
    dirs: [real(dir), real(attachments), ...(hasSkill ? [real(skillDir)] : [])],
    files: (context?.files ?? []).filter((f) => f.exists).map((f) => real(f.path)),
  };
  const canRead = (path: string): boolean => {
    const full = real(resolve(path));
    return readable.files.includes(full) || readable.dirs.some((d) => inside(full, d));
  };

  const episodes = existsSync(dir) ? (await readdir(dir)).filter((f) => /^ep\d+\.ya?ml$/i.test(f)).sort() : [];
  const lines = [
    `You are the writing partner in Story Studio, a tool for making short narrated story videos for Instagram.`,
    isNew
      ? `You are helping create a new show, "${draft.title}". Its files go in stories/${draft.show}/.`
      : `You are helping write the next part of "${context?.name}". Its files are in stories/${draft.show}/.`,
    '',
    'How you work:',
    '- You cannot write files. To add or change a file, call propose_file with its full new content and a one-line summary. The user reviews every proposal and accepts it or not.',
    '- Read the context files before you write anything. Never contradict them; if something is unclear, ask.',
    '- Keep chat replies short and plain. For an outline, give numbered beats, not a script.',
    '- Episodes are YAML scene files. Match the recent episodes exactly: the same keys, header style, folded `image: >` prompts, cast and prop names from cast.yaml, and 2 to 4 seconds of narration per shot.',
    '- When you draft an episode, also propose the matching updates to ARC.md and VOTES.md as separate proposals.',
    `- When the user invokes /${skill}, follow it for narration and dialogue, in its fiction register.`,
    '',
  ];
  if (context !== undefined) {
    lines.push('Context files (read them with Read):', ...context.files.map((f) => `- ${f.path}${f.exists ? '' : ' (missing: tell the user)'}`));
    lines.push('', 'Most recent episodes, for format and continuity:', ...context.recentEpisodes.map((f) => `- ${f}`));
    lines.push('', `All episodes: ${episodes.join(', ') || 'none yet'}.`, `The next episode is stories/${draft.show}/${context.nextEpisodeFile}.`);
  } else {
    lines.push(
      'A new show needs, as separate proposals: README.md (the premise, look and sound), ARC.md (the spine the episodes hang on),',
      'cast.yaml (style, narrator and characters, in the same format as stories/hatch/cast.yaml), show.yaml (name and context list), and ep01.yaml.',
      `For the format, you may read stories/hatch/cast.yaml and stories/hatch/ep01.yaml.`,
    );
    readable.files.push(real(join(ROOT, 'stories', 'hatch', 'cast.yaml')), real(join(ROOT, 'stories', 'hatch', 'ep01.yaml')));
  }
  if (draft.attachments.length > 0) {
    lines.push('', 'Attachments from the user (read them with Read):', ...draft.attachments.map((a) => `- ${join(attachments, a.name)}`));
  }
  return { systemPrompt: lines.join('\n'), canRead, skill: hasSkill ? skill : undefined };
}

/**
 * Runs one turn of the conversation for a draft and streams what happens. Claude can read the show's files
 * and propose changes; it can't write anything, run commands or spend money.
 */
export async function runTurn(draft: Draft, text: string, emit: (event: TurnEvent) => void, signal: AbortSignal): Promise<void> {
  if (running.has(draft.id)) throw new Error('Claude is already working on this draft.');
  running.add(draft.id);
  const abort = new AbortController();
  signal.addEventListener('abort', () => abort.abort());
  try {
    const { systemPrompt, canRead, skill } = await setup(draft);
    draft.messages.push({ role: 'user', text, at: new Date().toISOString() });
    draft.updatedAt = new Date().toISOString();
    await saveDraft(draft);

    const writer = createSdkMcpServer({
      name: 'writer',
      tools: [
        tool(
          'propose_file',
          'Propose a new or changed file in the show folder, with its full content. Nothing is written until the user accepts it.',
          {
            path: z.string().describe('Path inside the show folder, such as ep12.yaml or ARC.md'),
            content: z.string().describe('The complete file content'),
            summary: z.string().describe('One line: what this file is or what changed'),
          },
          async ({ path, content, summary }) => {
            try {
              const proposal = await propose(draft, path, content, summary);
              await saveDraft(draft);
              emit({ type: 'proposal', proposal });
              return { content: [{ type: 'text', text: `Proposed ${proposal.path}. The user will review it.` }] };
            } catch (error) {
              return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
            }
          },
        ),
      ],
    });

    const messages = query({
      prompt: text,
      options: {
        cwd: STUDIO,
        model: MODEL,
        env: childEnv(),
        abortController: abort,
        systemPrompt,
        // Isolation: only the studio's own settings, tools and skill.
        settingSources: ['project'],
        strictMcpConfig: true,
        tools: ['Read'],
        mcpServers: { writer },
        skills: skill === undefined ? [] : [skill],
        includePartialMessages: true,
        ...(draft.sessionId === undefined ? {} : { resume: draft.sessionId }),
        // Every call is decided here: reads only inside the allowed folders, proposals always, nothing else.
        canUseTool: async (name, input) => {
          if (name === 'mcp__writer__propose_file') return { behavior: 'allow', updatedInput: input };
          if (name === 'Read' && typeof input.file_path === 'string' && canRead(input.file_path)) return { behavior: 'allow', updatedInput: input };
          if (name === 'Skill') return { behavior: 'allow', updatedInput: input };
          return { behavior: 'deny', message: `Not allowed in Story Studio: ${name}${typeof input.file_path === 'string' ? ` ${input.file_path}` : ''}` };
        },
      },
    });

    let reply = '';
    const activity: string[] = [];
    for await (const message of messages) {
      if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          reply += event.delta.text;
          emit({ type: 'text', delta: event.delta.text });
        }
        if (event.type === 'content_block_start' && event.content_block.type === 'text' && reply !== '' && !reply.endsWith('\n')) {
          reply += '\n\n';
          emit({ type: 'text', delta: '\n\n' });
        }
      }
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue;
          const input = block.input as { file_path?: string; path?: string };
          const note =
            block.name === 'Read' ? `Read ${basename(input.file_path ?? '')}`
            : block.name === 'mcp__writer__propose_file' ? `Proposed ${input.path ?? 'a file'}`
            : block.name === 'Skill' ? 'Used the writing skill'
            : block.name;
          activity.push(note);
          emit({ type: 'activity', note });
        }
      }
      if (message.type === 'system' && message.subtype === 'init') draft.sessionId = message.session_id;
      if (message.type === 'result') {
        draft.sessionId = message.session_id;
        if (message.subtype !== 'success') throw new Error(`Claude stopped: ${message.subtype}`);
      }
    }
    draft.messages.push({ role: 'assistant', text: reply.trim(), at: new Date().toISOString(), activity });
    draft.updatedAt = new Date().toISOString();
    await saveDraft(draft);
    emit({ type: 'done', draft });
  } finally {
    running.delete(draft.id);
  }
}

