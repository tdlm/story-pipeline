import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { requireKey } from './env.ts';
import { paidRequest, type Spend } from './ledger.ts';
import { request } from './util.ts';

export type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

type ResponsePart = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } };

export type GeminiResponse = {
  candidates?: { content?: { parts?: ResponsePart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export async function imagePart(path: string): Promise<Part> {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (mime === undefined) throw new Error(`Unsupported image type (use png, jpg or webp): ${path}`);
  return { inline_data: { mime_type: mime, data: (await readFile(path)).toString('base64') } };
}

export const bufferPart = (data: Buffer, mime: string): Part => ({
  inline_data: { mime_type: mime, data: data.toString('base64') },
});

export async function generateContent(
  model: string,
  parts: Part[],
  generationConfig: Record<string, unknown>,
  label: string,
  spend: Spend,
): Promise<GeminiResponse> {
  const response = await paidRequest(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': requireKey('geminiKey'), 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    },
    label,
    spend,
  );
  return (await response.json()) as GeminiResponse;
}

export const responseParts = (response: GeminiResponse): ResponsePart[] =>
  response.candidates?.[0]?.content?.parts ?? [];

export const responseText = (response: GeminiResponse): string =>
  responseParts(response)
    .filter((part) => part.thought !== true && part.text !== undefined)
    .map((part) => part.text)
    .join('')
    .trim();

export async function listModels(): Promise<string[]> {
  const response = await request(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    { headers: { 'x-goog-api-key': requireKey('geminiKey') } },
    'Gemini model list',
  );
  const body = (await response.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((model) => model.name.replace(/^models\//, ''));
}
