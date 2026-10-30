#!/usr/bin/env node
// The speech runtime and models come with the install: npm install and
// npm run build download the pinned audio.cpp build for this computer and the
// Qwen3-ASR and VibeVoice GGUFs (about 6.7 GB with the CUDA build) into the
// SF Agents folder, checked against their SHA-256. Files already there are
// kept, so later builds download nothing. Runs after the TypeScript build
// (it uses web/dist/dictation.js).
//
// A failed download does not stop the build: SF Agents downloads what is
// missing when it starts. SFAGENTS_SKIP_SPEECH=1 (and CI) skip this step.
if (process.env.SFAGENTS_SKIP_SPEECH === '1' || process.env.CI) {
  console.log('Speech models: skipped (SFAGENTS_SKIP_SPEECH or CI).');
} else {
  try {
    const { Dictation } = await import('../web/dist/dictation.js');
    let shown = '';
    const show = (p) => {
      if (!p) return;
      const pct = p.total ? Math.floor((100 * p.done) / p.total / 5) * 5 : 0;
      const line = `Speech models: ${p.label} ${pct}% of ${(p.total / 1e9).toFixed(2)} GB`;
      if (line !== shown) console.log((shown = line));
    };
    const d = new Dictation({
      log: (line) => console.log(line),
      onChange: (s) => show(s.state === 'installing' ? s.progress : s.voice.state === 'installing' ? s.voice.progress : undefined),
    });
    const before = d.status();
    if (before.downloadSize + before.voice.downloadSize > 0) {
      console.log(`Speech models: downloading ${((before.downloadSize + before.voice.downloadSize) / 1e9).toFixed(1)} GB into ${d.dir} (once).`);
    }
    await d.install();
    await d.installVoice();
    d.close();
    console.log(`Speech models: ready in ${d.dir}.`);
  } catch (error) {
    console.warn(`warning: the speech models were not downloaded (${error instanceof Error ? error.message : error}). SF Agents downloads what is missing when it starts; run "npm run build:speech" to try again.`);
  }
}
