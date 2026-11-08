import { useQuery } from '@tanstack/react-query';
import type { EpisodeDetail, ShowSummary } from '../../server/api-types.ts';

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export const useShows = () => useQuery({ queryKey: ['shows'], queryFn: () => get<ShowSummary[]>('/api/shows') });

export const useEpisode = (show: string, episode: string) =>
  useQuery({
    queryKey: ['episode', show, episode],
    queryFn: () => get<EpisodeDetail>(`/api/shows/${encodeURIComponent(show)}/episodes/${encodeURIComponent(episode)}`),
  });
