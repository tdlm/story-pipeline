/**
 * Phase 2 spike: can the studio run Claude through the Agent SDK the way the plan needs?
 * Run on your Mac, signed in to Claude Code with your Max plan:  pnpm spike:agent
 * It changes no files and spends no generator money. Claude usage counts against your Max limits (a few turns).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSdkMcpServer, query, tool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ROOT = resolve(import.meta.dirname, '../..');
const CWD = join(ROOT, 'studio');
const SKILL = join(CWD, '.claude', 'skills', 'scottify');
const MODEL = process.env.STUDIO_MODEL ?? 'claude-opus-5-5';
const CODE_WORD = 'TEAPOT-42';

// Use the Claude login (Max plan), never an API key that happens to be in the shell.
const childEnv = { ...process.env };
delete childEnv.ANTHROPIC_API_KEY;

// The smallest kept picture, sent back from a tool so Claude has to look at it.
const keptDir = join(ROOT, 'stories', 'hatch', 'kept', 'ep01');
const picture = readdirSync(keptDir)
  .filter((name) => name.endsWith('.jpg'))
  .map((name) => join(keptDir, name))
  .sort((a, b) => statSync(a).size - statSync(b).size)[0];
if (picture === undefined) throw new Error(`No kept .jpg in ${keptDir}`);

const approvals: string[] = [];
const studio = createSdkMcpServer({
  name: 'studio',
  tools: [
    tool('view_image', 'Look at the test picture.', {}, async () => ({
      content: [{ type: 'image', data: readFileSync(picture).toString('base64'), mimeType: 'image/jpeg' }],
    }), { annotations: { readOnlyHint: true } }),
    tool('render_draft', 'Start a paid draft render of an episode. (Spike: does nothing.)', { episode: z.string() }, async ({ episode }) => ({
      content: [{ type: 'text', text: `Spike: would have rendered ${episode}.` }],
    }), { annotations: { destructiveHint: true } }),
  ],
});
// Paid tools always ask, even if a rule or mode would allow them.
const server = { ...studio, tools: [{ name: 'render_draft', permission_policy: 'always_ask' as const }] };

type Turn = { init?: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>; result?: Extract<SDKMessage, { type: 'result' }>; text: string };

async function turn(prompt: string, resume?: string): Promise<Turn> {
  const out: Turn = { text: '' };
  const messages = query({
    prompt,
    options: {
      cwd: CWD,
      model: MODEL,
      env: childEnv,
      // Isolation: only the studio's own settings and tools, none of your global setup or connectors.
      settingSources: ['project'],
      strictMcpConfig: true,
      tools: [],
      mcpServers: { studio: server },
      allowedTools: ['mcp__studio__view_image'],
      skills: existsSync(SKILL) ? ['scottify'] : [],
      canUseTool: async (name, input) => {
        approvals.push(name);
        return { behavior: 'allow', updatedInput: input };
      },
      ...(resume === undefined ? {} : { resume }),
    },
  });
  for await (const message of messages) {
    if (message.type === 'system' && message.subtype === 'init') out.init = message;
    if (message.type === 'assistant') {
      for (const block of message.message.content) if (block.type === 'text') out.text += block.text;
    }
    if (message.type === 'result') out.result = message;
  }
  return out;
}

const rows: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string): void => {
  rows.push([name, ok, detail]);
};

console.log(`Spike: Agent SDK with ${MODEL}. Three short turns…\n`);

// Turn 1: isolation, an image tool result, and an approval round trip.
const first = await turn(
  `Call view_image and describe the picture in one sentence. Then call render_draft for episode "spike". Then remember this code word for later: ${CODE_WORD}. Reply briefly.`,
);
const init = first.init;
const expectedTools = new Set(['mcp__studio__view_image', 'mcp__studio__render_draft', 'Skill']);
const extraTools = (init?.tools ?? []).filter((name) => !expectedTools.has(name));
const servers = (init?.mcp_servers ?? []).map((s) => s.name);

check('Uses your Claude login, not an API key', init?.apiKeySource === 'none', `apiKeySource: ${init?.apiKeySource}`);
check('Model', init?.model !== undefined, String(init?.model));
check('No tools beyond the studio\'s', extraTools.length === 0, extraTools.length === 0 ? (init?.tools ?? []).join(', ') : `extra: ${extraTools.join(', ')}`);
check('No MCP servers beyond the studio\'s (no connectors)', servers.length === 1 && servers[0] === 'studio', servers.join(', '));
check('Claude saw the picture from a tool', first.result?.subtype === 'success' && first.text.length > 20, first.text.slice(0, 160).replace(/\s+/g, ' '));
check('Paid tool asked for approval', approvals.includes('mcp__studio__render_draft'), `asked for: ${approvals.join(', ') || 'nothing'}`);
check('Read-only tool did not ask', !approvals.includes('mcp__studio__view_image'), '');

// Turn 2: resume the session and check caching.
const second = await turn('What was the code word? Reply with just the word.', first.result?.session_id);
const usage = second.result?.usage as { cache_read_input_tokens?: number; input_tokens?: number } | undefined;
check('Session resumes', second.text.includes(CODE_WORD), second.text.trim().slice(0, 60));
check('Prompt caching', (usage?.cache_read_input_tokens ?? 0) > 0, `cache reads: ${usage?.cache_read_input_tokens ?? 0}, new input: ${usage?.input_tokens ?? 0}`);

// Turn 3: the writing skill, invoked on purpose (it has disable-model-invocation).
if (!existsSync(SKILL)) {
  check('scottify skill loads', false, `link it first: mkdir -p ${join(CWD, '.claude', 'skills')} && ln -s ~/Dev/skills/scottify ${SKILL}`);
} else {
  const third = await turn('/scottify Write two sentences of narration: the survivor waits at the hatch while the dog watches him.');
  check('scottify skill loads', (third.init?.skills ?? []).includes('scottify'), `skills: ${(third.init?.skills ?? []).join(', ')}`);
  check('scottify runs when asked', third.result?.subtype === 'success' && third.text.length > 20, third.text.trim().slice(0, 300).replace(/\s+/g, ' '));
}

const cost = [first, second].reduce((sum, t) => sum + (t.result?.total_cost_usd ?? 0), 0);
console.log(rows.map(([name, ok, detail]) => `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `\n      ${detail}`}`).join('\n'));
console.log(`\nAPI-equivalent usage for the first two turns: ~$${cost.toFixed(3)} (not billed on your Max login).`);
process.exitCode = rows.every(([, ok]) => ok) ? 0 : 1;
