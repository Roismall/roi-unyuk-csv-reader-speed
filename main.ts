// main.ts — harness adapter for the csv-reader-speed entry.
// The competition kit was not available when this was written, so this
// adapter accepts every plausible harness protocol and NOTHING else in
// the program knows about files/argv/stdout:
//   * stdin JSON lines (one case per line)  -> one JSON result per line
//   * stdin single JSON object {text, header} -> one JSON result
//   * stdin JSON array of cases -> JSON array of results
//   * argv[2] = input file (JSON / NDJSON / raw CSV), argv[3] = output file
//   * argv[2] = directory -> every *.json/*.txt file in it, NDJSON out
//   * stdin raw CSV text (not JSON) -> one result, header=false
// A case may also carry its text as .csv/.data/.content, or be a bare
// string. Diagnostics go to stderr only; stdout is exactly the answers.
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./solve.js";

function toCase(v: unknown): { text: string; header: boolean } {
  if (typeof v === "string") return { text: v, header: false };
  const o = (v ?? {}) as Record<string, unknown>;
  const t = o.text ?? o.csv ?? o.data ?? o.content ?? "";
  return { text: typeof t === "string" ? t : String(t), header: !!o.header };
}

function parseInput(raw: string): { cases: unknown[]; ndjson: boolean; wasArray: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { cases: [], ndjson: false, wasArray: false };
  const lines = raw.split(/\n/).filter((l) => l.trim() !== "");
  if (lines.length > 1) {
    try {
      return { cases: lines.map((l) => JSON.parse(l)), ndjson: true, wasArray: false };
    } catch { /* fall through: whole input is one JSON value / raw text */ }
  }
  try {
    const v = JSON.parse(raw);
    return { cases: Array.isArray(v) ? v : [v], ndjson: false, wasArray: Array.isArray(v) };
  } catch {
    return { cases: [{ text: raw, header: false }], ndjson: false, wasArray: false };
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => { data += c; });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let raw = "";
  let ndjson = false;
  if (args[0]) {
    const target = args[0];
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const files = fs.readdirSync(target)
        .filter((f) => /\.(json|jsonl|txt|csv)$/i.test(f)).sort()
        .map((f) => path.join(target, f));
      const out: string[] = [];
      for (const f of files) {
        const p = parseInput(fs.readFileSync(f, "utf8"));
        for (const c of p.cases) out.push(JSON.stringify(run(toCase(c))));
      }
      const text = out.join("\n") + (out.length ? "\n" : "");
      process.stdout.write(text);
      if (args[1]) fs.writeFileSync(args[1], text, "utf8");
      return;
    }
    raw = fs.readFileSync(target, "utf8");
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    console.error("no input: pass an input file, or pipe JSON/NDJSON cases on stdin");
    process.exit(1);
  }
  const parsed = parseInput(raw);
  ndjson = parsed.ndjson;
  const results = parsed.cases.map((c) => run(toCase(c)));
  let out: string;
  if (ndjson) {
    out = results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "");
  } else if (parsed.wasArray || results.length !== 1) {
    out = JSON.stringify(results) + "\n";
  } else {
    out = JSON.stringify(results[0]) + "\n";
  }
  process.stdout.write(out);
  if (args[1]) fs.writeFileSync(args[1], out, "utf8");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
