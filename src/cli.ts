import { spawn } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { env } from './env.ts';
import { cartesiaPreview, listCartesiaVoices, resolveCartesiaVoice } from './cartesia.ts';
import { listVoices, remainingCredits, voiceProblems, voicePreview } from './elevenlabs.ts';
import { parseVoice, speak } from './speech.ts';
import { ffmpegInfo, REQUIRED_FILTERS } from './ffmpeg.ts';
import { listModels } from './gemini.ts';
import { fixShot, keepShot } from './images.ts';
import { loadScene } from './load.ts';
import { render } from './render.ts';
import { log, mapPool } from './util.ts';

const USAGE = `Usage:
  pnpm render <scene.yaml> [options]   Make the video
      --images-only      Stop after the images and contact sheet (review before paying for audio)
      --draft            Cheaper, faster voices (${env.draftVoiceModel}); images are kept for the final render
      --regen <ids>      Make new images for these shots (comma-separated ids, or "all")
      --no-check         Skip the image consistency check
      --mock             No API calls: placeholder images and tones, to test timing for free
      --yes              Allow runs that generate more than 25 images
  pnpm fix <scene.yaml> <shots> "..."  Change one thing in shots' images (comma-separated ids), keeping the rest
  pnpm keep <scene.yaml> <shots|all>   Lock the images you approved (from the last render) so they're never redrawn
  pnpm voices [--search <text>]        List the ElevenLabs voices your key can use
  pnpm voices --cartesia [--search x]  List Cartesia voices
  pnpm voices --play <voice>           Play a voice's preview sample (an id, or cartesia:Tanner)
  pnpm voices --play <voice> --say ".." Hear a voice read your line (uses credits; cached)
  pnpm preflight [scene.yaml]          Check ffmpeg, keys, models, credits and the scene's voices`;

async function preflightCheck(scenePath?: string): Promise<void> {
  const ok = (message: string): void => log(`✓ ${message}`);
  const bad = (message: string): void => log(`✗ ${message}`);

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}: needs 22.18 or newer (nvm install)`);

  try {
    const { version, filters } = await ffmpegInfo();
    const missing = REQUIRED_FILTERS.filter((name) => !filters.has(name));
    if (missing.length === 0) ok(version);
    else bad(`${version}: missing filters ${missing.join(', ')}. Run: brew install ffmpeg-full (it's found automatically)`);
  } catch (error) {
    bad((error as Error).message);
  }

  if (env.geminiKey === '') {
    bad('GEMINI_API_KEY not set in .env');
  } else {
    try {
      const models = await listModels();
      for (const [label, model] of [['image model', env.imageModel], ['check model', env.checkModel]] as const) {
        if (models.includes(model)) ok(`Gemini ${label}: ${model}`);
        else bad(`Gemini ${label} "${model}" isn't available to this key`);
      }
      const imageModels = models.filter((name) => name.includes('image'));
      log(`  Image models on this key: ${imageModels.join(', ') || 'none'}`);
    } catch (error) {
      bad((error as Error).message);
    }
  }

  if (env.elevenKey === '') {
    bad('ELEVENLABS_API_KEY not set in .env');
  } else {
    try {
      const credits = await remainingCredits();
      ok(`ElevenLabs ${credits.tier} plan: ${credits.remaining.toLocaleString()} of ${credits.limit.toLocaleString()} credits left`);
    } catch (error) {
      bad((error as Error).message);
    }
  }

  if (env.cartesiaKey !== '') {
    try {
      await listCartesiaVoices(undefined);
      ok('Cartesia key works');
    } catch (error) {
      bad((error as Error).message);
    }
  }

  if (scenePath !== undefined) {
    try {
      const scene = await loadScene(resolve(scenePath));
      ok(`Scene "${scene.title}": ${scene.shots.length} shots`);
      const voices = [...new Set(scene.shots.flatMap((shot) => shot.lines.map((line) => line.voice)))].map(parseVoice);

      const eleven = voices.filter((voice) => voice.provider === 'elevenlabs').map((voice) => voice.ref);
      if (eleven.length > 0 && env.elevenKey !== '') {
        const problems = await voiceProblems(eleven);
        if (problems.length === 0) ok(`ElevenLabs voices usable (${eleven.length})`);
        for (const problem of problems) bad(problem);
      }

      for (const voice of voices.filter((candidate) => candidate.provider === 'cartesia')) {
        if (env.cartesiaKey === '') {
          bad(`The scene uses cartesia:${voice.ref} but CARTESIA_API_KEY isn't set in .env`);
          break;
        }
        try {
          const found = await resolveCartesiaVoice(voice.ref);
          ok(`Cartesia voice "${voice.ref}": ${found.name} (${found.id})`);
        } catch (error) {
          bad((error as Error).message);
        }
      }
    } catch (error) {
      bad((error as Error).message);
    }
  }
}

function play(file: string): Promise<void> {
  if (process.platform !== 'darwin') {
    log(`Saved to ${file}`);
    return Promise.resolve();
  }
  return new Promise((done) => spawn('afplay', [file], { stdio: 'ignore' }).on('close', () => done()));
}

async function playVoice(voice: string, say?: string): Promise<void> {
  const { provider, ref } = parseVoice(voice);
  if (say === undefined) {
    const preview = provider === 'cartesia' ? await cartesiaPreview(ref) : await voicePreview(ref);
    log(`▶ ${preview.name} (preview sample)`);
    await play(preview.file);
    return;
  }
  // Same settings as a --draft render, so the line is reused there.
  const speech = await speak({ text: say, voice, draft: true, mock: false });
  const cost = speech.spentCharacters > 0 ? ` (${speech.spentCharacters} ElevenLabs credits)` : speech.fresh ? '' : ' (cached)';
  log(`▶ ${voice}: "${say}"${cost}`);
  await play(speech.file);
}

async function cartesiaVoices(search?: string): Promise<void> {
  const list = await listCartesiaVoices(search);
  if (list.length === 0) {
    log('No Cartesia voices found.');
    return;
  }
  for (const voice of list) {
    log(`cartesia:${voice.id}  ${voice.name}${voice.gender ? ` [${voice.gender}]` : ''}  ${voice.description.slice(0, 80)}`);
  }
}

async function voices(search?: string): Promise<void> {
  const list = await listVoices(search);
  if (list.length === 0) {
    log('No voices found. Add voices from the ElevenLabs Voice Library to your account, then run this again.');
    return;
  }
  for (const voice of list) {
    const labels = Object.values(voice.labels ?? {}).filter(Boolean).join(', ');
    log(`${voice.voice_id}  ${voice.name}${voice.category === undefined ? '' : ` [${voice.category}]`}${labels === '' ? '' : `  ${labels}`}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      draft: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      'no-check': { type: 'boolean', default: false },
      'images-only': { type: 'boolean', default: false },
      regen: { type: 'string' },
      yes: { type: 'boolean', default: false },
      search: { type: 'string' },
      play: { type: 'string' },
      say: { type: 'string' },
      cartesia: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || command === undefined) {
    log(USAGE);
    return;
  }

  switch (command) {
    case 'render': {
      const scenePath = positionals[0];
      if (scenePath === undefined) throw new Error(`Which scene?\n\n${USAGE}`);
      const regen = new Set((values.regen ?? '').split(',').map((id) => id.trim()).filter(Boolean));
      await render(resolve(scenePath), {
        draft: values.draft,
        mock: values.mock,
        check: !values['no-check'],
        regen,
        imagesOnly: values['images-only'],
        yes: values.yes,
      });
      return;
    }
    case 'fix': {
      const [scenePath, shotIds, instruction] = positionals;
      if (scenePath === undefined || shotIds === undefined || instruction === undefined) {
        throw new Error(`Usage: pnpm fix <scene.yaml> <shot id[,shot id...]> "what to change"`);
      }
      const scene = await loadScene(resolve(scenePath));
      const ids = shotIds.split(',').map((id) => id.trim()).filter(Boolean);
      const shots = ids.map((id) => {
        const shot = scene.shots.find((candidate) => candidate.id === id);
        if (shot === undefined) throw new Error(`No shot "${id}". Shots: ${scene.shots.map((s) => s.id).join(', ')}`);
        return shot;
      });
      log(`▸ Fixing ${ids.join(', ')}: ${instruction}`);
      await mapPool(shots, 3, async (shot) => {
        const file = await fixShot(scene, shot, instruction);
        log(`✓ ${shot.id}: ${relative(process.cwd(), file)}`);
      });
      log('  The next render uses them. Run with --images-only to refresh the contact sheet.');
      return;
    }
    case 'keep': {
      const [scenePath, ...ids] = positionals;
      if (scenePath === undefined || ids.length === 0) throw new Error('Usage: pnpm keep <scene.yaml> <shot ids...|all>');
      const scene = await loadScene(resolve(scenePath));
      const keepable = scene.shots.filter((shot) => shot.imageFile === undefined);
      const wanted = ids.includes('all') ? keepable : keepable.filter((shot) => ids.includes(shot.id));
      const unknown = ids.filter((id) => id !== 'all' && !scene.shots.some((shot) => shot.id === id));
      if (unknown.length > 0) throw new Error(`No shot with id ${unknown.join(', ')}`);
      // Keeps the image the next render would use, so a `pnpm fix` is kept even before the next render.
      for (const shot of wanted) {
        const result = await keepShot(scene, shot);
        if (result === 'no image') log(`✗ ${shot.id}: no image yet. Run: pnpm render ${scenePath} --images-only`);
        else log(`✓ ${shot.id}: ${result}`);
      }
      log(`  Kept images live in ${relative(process.cwd(), scene.keptDir)}. Prompt and cast changes won't redraw them; --regen <id> will.`);
      return;
    }
    case 'voices':
      if (values.play !== undefined) await playVoice(values.play, values.say);
      else if (values.cartesia) await cartesiaVoices(values.search);
      else await voices(values.search);
      return;
    case 'preflight':
      await preflightCheck(positionals[0]);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
