import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { env } from '../../src/env.ts';
import { currentImage } from '../../src/images.ts';
import { loadScene, refsForShot, type Scene, type Shot } from '../../src/load.ts';
import { runAgent } from './agent.ts';
import type { ShotChat, ShotSuggestion, ShotTurnEvent } from './api-types.ts';
import { smallCopy } from './thumbs.ts';

const chatFile = (scene: Scene, shot: Shot): string => join(env.studioDir, 'shot-chats', scene.id, `${shot.id}.json`);
const running = new Set<string>();

export async function loadShotChat(scene: Scene, shot: Shot): Promise<ShotChat> {
  const file = chatFile(scene, shot);
  return existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as ShotChat) : { messages: [], suggestions: [] };
}

async function saveShotChat(scene: Scene, shot: Shot, chat: ShotChat): Promise<void> {
  const file = chatFile(scene, shot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(chat, null, 2));
  await rename(`${file}.tmp`, file);
}

function picture(scene: Scene, shot: Shot): Promise<string | undefined> {
  if (shot.imageFile !== undefined) return Promise.resolve(shot.imageFile);
  if (shot.keptFile !== undefined) return Promise.resolve(shot.keptFile);
  return currentImage(scene, shot);
}

function systemPrompt(scene: Scene, shot: Shot): string {
  const { cast } = scene;
  const describe = (kind: string, names: string[], table: Record<string, { description: string }>): string[] =>
    names.map((name) => `- ${kind} "${name}": ${table[name]?.description.trim().replace(/\s+/g, ' ') ?? '(not in cast.yaml)'}`);
  return [
    'You help fix one shot of an illustrated story video in Story Studio. Pictures come from an image model (Gemini) that gets',
    "the show's style, the shot prompt, the descriptions below, and the reference images.",
    '',
    'How you work:',
    '- Call view_picture to see the current picture next to its reference images before judging it.',
    '- You cannot change anything or spend money. Call suggest with a better prompt, a fix instruction, or new lines; the user',
    '  applies a suggestion with one click and decides whether to pay for a redraw or fix.',
    '- A fix edits the current picture and changes one thing ("make the hatch square", "remove the extra hand"): prefer it when',
    '  the picture is mostly right. A new prompt means a full redraw: prefer it when the composition or action is wrong, or a',
    '  fix already failed.',
    '- Write prompts as the existing ones are: plain description of what is in frame, using the cast names, no style words',
    '  (the style is added automatically). Image models can\'t do left and right reliably, so don\'t rely on sides.',
    '- Keep replies short: what is wrong, then the suggestion.',
    '',
    `Show style: ${cast.style.trim().replace(/\s+/g, ' ')}`,
    `Episode: ${scene.title}. Shot ${shot.index + 1} of ${scene.shots.length}, camera move: ${shot.move}.`,
    `Current prompt: ${shot.prompt?.trim() ?? '(this shot uses a picture file instead of a prompt)'}`,
    ...(shot.lines.length > 0 ? ['Lines over this shot:', ...shot.lines.map((l) => `- ${l.speaker}: ${l.text}`)] : ['No lines over this shot.']),
    ...describe('character', shot.cast, cast.characters),
    ...(shot.location === undefined ? [] : describe('location', [shot.location], cast.locations)),
    ...describe('prop', shot.props, cast.props),
    ...(shot.avoid.length > 0 ? [`Must not appear: ${shot.avoid.join('; ')}`] : []),
    `Its picture is ${shot.keptFile !== undefined ? 'kept (approved)' : 'not kept yet'}.`,
  ].join('\n');
}

/** One turn of the conversation about a shot. Claude sees the picture and suggests; it never changes or pays for anything. */
export async function askAboutShot(file: string, number: number, text: string, emit: (event: ShotTurnEvent) => void, signal: AbortSignal): Promise<void> {
  const scene = await loadScene(file);
  const shot = scene.shots[number - 1];
  if (shot === undefined) throw new Error(`No shot ${number}.`);
  const lock = `${scene.id}/${shot.id}`;
  if (running.has(lock)) throw new Error('Claude is already looking at this shot.');
  running.add(lock);
  try {
    const chat = await loadShotChat(scene, shot);
    chat.messages.push({ role: 'user', text, at: new Date().toISOString() });
    await saveShotChat(scene, shot, chat);

    const server = createSdkMcpServer({
      name: 'shot',
      tools: [
        tool('view_picture', "See the shot's current picture and its reference images.", {}, async () => {
          const current = await picture(scene, shot);
          const refs = refsForShot(scene, shot).filter((ref) => existsSync(ref.path));
          const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
          if (current === undefined) content.push({ type: 'text', text: 'This shot has no picture yet.' });
          else content.push({ type: 'text', text: 'CURRENT PICTURE:' }, { type: 'image', data: (await smallCopy(current)).toString('base64'), mimeType: 'image/jpeg' });
          for (const ref of refs.slice(0, 6)) {
            content.push({ type: 'text', text: `REFERENCE: ${ref.label} (${basename(ref.path)})` }, { type: 'image', data: (await smallCopy(ref.path, 768)).toString('base64'), mimeType: 'image/jpeg' });
          }
          return { content };
        }, { annotations: { readOnlyHint: true } }),
        tool(
          'suggest',
          'Offer the user a change to apply with one click. Give at least one of prompt, fix or lines.',
          {
            why: z.string().describe('One line: what this changes and why'),
            prompt: z.string().optional().describe('A full replacement picture prompt (means a redraw)'),
            fix: z.string().optional().describe('One instruction to edit the current picture'),
            lines: z.array(z.object({ speaker: z.string(), text: z.string() })).optional().describe('Replacement lines for the shot'),
          },
          async (input) => {
            if (input.prompt === undefined && input.fix === undefined && input.lines === undefined) {
              return { content: [{ type: 'text', text: 'Give a prompt, a fix or lines.' }], isError: true };
            }
            const suggestion: ShotSuggestion = { id: crypto.randomUUID(), at: new Date().toISOString(), ...input };
            chat.suggestions.push(suggestion);
            await saveShotChat(scene, shot, chat);
            emit({ type: 'suggestion', suggestion });
            return { content: [{ type: 'text', text: 'Shown to the user.' }] };
          },
        ),
      ],
    });

    const result = await runAgent({
      text,
      sessionId: chat.sessionId,
      systemPrompt: systemPrompt(scene, shot),
      tools: [],
      mcpServers: { shot: server },
      canUseTool: async (name, input) =>
        name === 'mcp__shot__view_picture' || name === 'mcp__shot__suggest'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `Not allowed here: ${name}` },
      describe: (name) => (name === 'mcp__shot__view_picture' ? 'Looked at the picture' : name === 'mcp__shot__suggest' ? 'Made a suggestion' : name),
      emit,
      signal,
    });
    chat.sessionId = result.sessionId;
    chat.messages.push({ role: 'assistant', text: result.reply, at: new Date().toISOString(), activity: result.activity });
    await saveShotChat(scene, shot, chat);
    emit({ type: 'done', chat });
  } finally {
    running.delete(lock);
  }
}

/** A canned assistant for working on the UI without using your Max limits (STUDIO_FAKE_CLAUDE=1). */
export async function askAboutShotFake(file: string, number: number, text: string, emit: (event: ShotTurnEvent) => void): Promise<void> {
  const scene = await loadScene(file);
  const shot = scene.shots[number - 1];
  if (shot === undefined) throw new Error(`No shot ${number}.`);
  const chat = await loadShotChat(scene, shot);
  chat.messages.push({ role: 'user', text, at: new Date().toISOString() });
  emit({ type: 'activity', note: 'Looked at the picture' });
  const reply = 'The hatch reads as round. A fix should do it. (Fake Claude.)';
  for (const word of reply.split(/(?<= )/)) {
    emit({ type: 'text', delta: word });
    await new Promise((done) => setTimeout(done, 15));
  }
  const suggestion: ShotSuggestion = {
    id: crypto.randomUUID(), at: new Date().toISOString(), why: 'The hatch should be square, as in the references.',
    fix: 'Make the hatch square with a hinged lid, keeping everything else.', prompt: `${shot.prompt?.trim() ?? ''} The hatch is square.`,
  };
  chat.suggestions.push(suggestion);
  emit({ type: 'suggestion', suggestion });
  chat.messages.push({ role: 'assistant', text: reply, at: new Date().toISOString(), activity: ['Looked at the picture', 'Made a suggestion'] });
  await saveShotChat(scene, shot, chat);
  emit({ type: 'done', chat });
}
