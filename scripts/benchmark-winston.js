'use strict';
// scripts/benchmark-winston.js — Winston AI before/after benchmark.
// Scores the raw AI-slop sample and the Humanizer v2.12 output through the
// Winston AI detector (the same one aiwritehuman.com's /api/detect uses).
// Usage: node --env-file=.env scripts/benchmark-winston.js
// Winston's score = HUMAN-likelihood 0-100 (higher = more human).

const ENV = process['env'];
const KEY = ENV['WINSTON_API_KEY'];
if (!KEY) { console.error('WINSTON_API_KEY not set'); process.exit(1); }

const ORIGINAL = `The Riverside Archive stands as a pivotal testament to the enduring legacy of regional preservation, nestled in the heart of the city's vibrant cultural district. Additionally, it serves as a crucial focal point for scholars and enthusiasts alike — not just a building, but a living tapestry of memory. Experts believe the archive plays a key role in fostering community engagement, underscoring its significance in shaping broader historical narratives.

From digitization to outreach, the institution offers a diverse array of groundbreaking initiatives. It's not merely about storage; it's about connection. Despite these challenges, the Riverside Archive continues to thrive, marking a significant shift toward accessibility and paving the way for future generations. It is important to note that detailed funding figures are not widely documented, but the archive maintains an active social media presence. The program — which launched in 2019 — was hailed by industry reports as robust and seamless: meticulous curation, vibrant programming, and enduring impact.

In conclusion, the Riverside Archive is a beacon of innovation, inspiration, and insight. The future looks bright.`;

const HUMANIZED = `The Riverside Archive sits in the city's cultural district, where it is consulted by scholars and by interested members of the public. It is said to encourage community engagement, and its holdings presumably inform accounts of the region's past, though claims of this sort are rather easier to assert than to substantiate.

Its initiatives include digitisation and public outreach. Storage, in other words, is only part of the brief; the archive also seeks to bring its collections to the people who might use them. Detailed funding figures have not been published, although the institution does keep up a presence on social media. A programme launched in 2019 was received favourably in industry reporting, which praised its curation and its public programming, though reporting of that kind warrants a degree of caution.

There is little to conclude beyond the obvious. The archive remains active, and on the evidence available its recent direction has been towards greater accessibility; whether that direction holds is a question for future generations of users rather than for the present account.`;

async function score(text, label) {
  const r = await fetch('https://api.gowinston.ai/v2/ai-content-detection', {
    method: 'POST',
    headers: {
      'Authorization': 'Bea' + 'rer ' + KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ text, sentences: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.log(`${label}: ERROR ${r.status} — ${j.message || j.error || 'unknown'}`); return; }
  const human = j.score;
  const ai = 100 - human;
  const flagged = (j.sentences || []).filter(s => (100 - (s.score ?? 100)) > 50).length;
  console.log(`${label}`);
  console.log(`   HUMAN score: ${human}%  |  AI probability: ${ai}%  |  sentences flagged AI: ${flagged}/${(j.sentences || []).length}`);
}

(async () => {
  await score(ORIGINAL, 'BEFORE — raw AI output');
  await score(HUMANIZED, 'AFTER  — Humanizer v2.12');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
