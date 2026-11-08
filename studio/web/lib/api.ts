import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Draft, EpisodeDetail, ShowSummary, TurnEvent } from '../../server/api-types.ts';

export type DraftSummary = { id: string; kind: Draft['kind']; show: string; title: string; updatedAt: string; pending: number };

async function read<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
const get = async <T>(path: string): Promise<T> => read<T>(await fetch(path));
const post = async <T>(path: string, body?: BodyInit, json = false): Promise<T> =>
  read<T>(await fetch(path, { method: 'POST', body, headers: json ? { 'content-type': 'application/json' } : undefined }));

export const useShows = () => useQuery({ queryKey: ['shows'], queryFn: () => get<ShowSummary[]>('/api/shows') });
export const useDrafts = () => useQuery({ queryKey: ['drafts'], queryFn: () => get<DraftSummary[]>('/api/drafts') });

export const useEpisode = (show: string, episode: string) =>
  useQuery({
    queryKey: ['episode', show, episode],
    queryFn: () => get<EpisodeDetail>(`/api/shows/${encodeURIComponent(show)}/episodes/${encodeURIComponent(episode)}`),
  });

export const useDraft = (id: string) => useQuery({ queryKey: ['draft', id], queryFn: () => get<Draft>(`/api/drafts/${id}`) });

export const createDraft = (form: FormData) => post<{ id: string }>('/api/drafts', form);

export function useProposalAction(draftId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ proposal, action }: { proposal: string; action: 'accept' | 'dismiss' }) =>
      post<Draft>(`/api/drafts/${draftId}/proposals/${proposal}/${action}`),
    onSuccess: (draft) => {
      client.setQueryData(['draft', draftId], draft);
      void client.invalidateQueries({ queryKey: ['shows'] });
      void client.invalidateQueries({ queryKey: ['drafts'] });
    },
  });
}

export const uploadAttachments = (draftId: string, files: File[]) => {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return post<Draft>(`/api/drafts/${draftId}/attachments`, form);
};

/** Sends one message to Claude and calls onEvent for each streamed event until the turn ends. */
export async function sendTurn(draftId: string, text: string, onEvent: (event: TurnEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/drafts/${draftId}/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data !== '') onEvent(JSON.parse(data) as TurnEvent);
    }
  }
}
