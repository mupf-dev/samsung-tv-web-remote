// Checks every language file against the English reference:
// missing keys, unknown keys and mismatched {placeholders}. Exit code 1 on problems.
import { LOCALES, FALLBACK } from '../public/i18n/locales/index.js';

const load = async (code) => (await import(`../public/i18n/locales/${code}.js`)).default;
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

const reference = await load(FALLBACK);
let problems = 0;

for (const { code, name } of LOCALES) {
  if (code === FALLBACK) continue;
  let dict;
  try {
    dict = await load(code);
  } catch (err) {
    console.log(`✗ ${code} (${name}): cannot load ./locales/${code}.js – ${err.message}`);
    problems++;
    continue;
  }
  const missing = Object.keys(reference).filter((k) => !(k in dict));
  const unknown = Object.keys(dict).filter((k) => !(k in reference));
  const mismatched = Object.keys(dict).filter((k) => k in reference && placeholders(dict[k]) !== placeholders(reference[k]));

  if (!missing.length && !unknown.length && !mismatched.length) {
    console.log(`✓ ${code} (${name}): ${Object.keys(dict).length} keys, complete`);
    continue;
  }
  problems += missing.length + unknown.length + mismatched.length;
  console.log(`✗ ${code} (${name})`);
  for (const k of missing) console.log(`    missing:      ${k}`);
  for (const k of unknown) console.log(`    unknown:      ${k}`);
  for (const k of mismatched) console.log(`    placeholders: ${k} (expected {${placeholders(reference[k])}})`);
}

process.exit(problems ? 1 : 0);
