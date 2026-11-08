import { join } from 'node:path';
import { query, type CanUseTool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { ROOT } from '../../src/env.ts';

/** The Claude model. Settings will let you choose per step; the app never switches on its own. */
const MODEL = process.env.STUDIO_MODEL ?? 'claude-opus-5-5';
const STUDIO = join(ROOT, 'studio');

export type AgentEvent = { type: 'text'; delta: string } | { type: 'activity'; note: string };

export type AgentTurn = {
  text: string;
  sessionId?: string;
  systemPrompt: string;
  /** Built-in tools Claude may use, such as ['Read']. Usually none. */
  tools: string[];
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  skills?: string[];
  /** Decides every tool call. Nothing is allowed by a list. */
  canUseTool: CanUseTool;
  /** A short note for a tool call, shown while Claude works. */
  describe: (name: string, input: Record<string, unknown>) => string;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
};

/** Use the Claude login (Max plan), never an API key that happens to be in the environment. */
function childEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  delete copy.ANTHROPIC_API_KEY;
  return copy;
}

/** Runs one turn with Claude, isolated to the studio's own settings and the given tools, and streams it. */
export async function runAgent(turn: AgentTurn): Promise<{ reply: string; activity: string[]; sessionId?: string }> {
  const abort = new AbortController();
  turn.signal.addEventListener('abort', () => abort.abort());
  const messages = query({
    prompt: turn.text,
    options: {
      cwd: STUDIO,
      model: MODEL,
      env: childEnv(),
      abortController: abort,
      systemPrompt: turn.systemPrompt,
      settingSources: ['project'],
      strictMcpConfig: true,
      tools: turn.tools,
      mcpServers: turn.mcpServers,
      skills: turn.skills ?? [],
      includePartialMessages: true,
      canUseTool: turn.canUseTool,
      ...(turn.sessionId === undefined ? {} : { resume: turn.sessionId }),
    },
  });

  let reply = '';
  let sessionId = turn.sessionId;
  const activity: string[] = [];
  for await (const message of messages) {
    if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
      const event = message.event;
      if (event.type === 'content_block_start' && event.content_block.type === 'text' && reply !== '' && !reply.endsWith('\n')) {
        reply += '\n\n';
        turn.emit({ type: 'text', delta: '\n\n' });
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        reply += event.delta.text;
        turn.emit({ type: 'text', delta: event.delta.text });
      }
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue;
        const note = turn.describe(block.name, block.input as Record<string, unknown>);
        activity.push(note);
        turn.emit({ type: 'activity', note });
      }
    }
    if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
    if (message.type === 'result') {
      sessionId = message.session_id;
      if (message.subtype !== 'success') throw new Error(`Claude stopped: ${message.subtype}`);
    }
  }
  return { reply: reply.trim(), activity, sessionId };
}
