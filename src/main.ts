// Entry point (action.yml runs dist/main.js). Wires the real runner, git and network into run().
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { postCi } from "./client.js";
import { run } from "./run.js";
import { workflow } from "./workflow.js";

const env = process.env;
const wf = workflow({
  env,
  write: (line) => process.stdout.write(line),
  appendFile: (path, data) => appendFileSync(path, data, "utf8"),
});

function readEvent(): unknown {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {};
  }
}

// execFile, not a shell: arguments never pass through shell parsing.
const git = (args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("git", args, { maxBuffer: 16 * 1024 * 1024, cwd: env.GITHUB_WORKSPACE }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });

try {
  process.exitCode = await run({ wf, env, readEvent, git, post: (request) => postCi(request), fetch: (input, init) => fetch(input, init) });
} catch (err) {
  wf.error(`Syncotta: unexpected error (${err instanceof Error ? err.name : "unknown"})`);
  process.exitCode = env["INPUT_FAIL-ON-ERROR"]?.trim().toLowerCase() === "true" ? 1 : 0;
}
