// main.ts — harness driver for the csv-reader-speed entry.
// The harness runs `node main.ts`: it reads every case from
// /input/cases.json (MAKEFUN_INPUT_DIR outside a container), answers
// each case alone with run() from solve.js, and writes the answers in
// order to /output/answers.json (MAKEFUN_OUTPUT_DIR outside a
// container). Diagnostics go to stderr only; nothing is printed here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";

// V8's incremental marking off, set before solve.js is imported so all
// of its work runs under it (the house baseline runs with this flag on,
// and an entry may tune V8's flags the same way).
setFlagsFromString("--no-incremental-marking");

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL("./solve.js", import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(INPUT_DIR, "cases.json"), "utf8")) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, "answers.json"), JSON.stringify(answers));
