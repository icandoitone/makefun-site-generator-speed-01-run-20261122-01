// FastSite — the harness entry point. The harness runs `node /bot/main.ts` (node22).
// It reads every case from /input/cases.json (a JSON array of {id, input}),
// answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
// Each answer is stringified as it is produced and its case's input dropped at once, so the run never holds the
// parsed cases, every answer object and the whole output string together: the same bytes as stringifying the
// answers array (an answer is always an object, never undefined), with less live memory behind it.
const parts: string[] = [];
for (const c of cases) {
  parts.push(JSON.stringify(run(c.input)));
  c.input = undefined;
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), `[${parts.join(',')}]`);
