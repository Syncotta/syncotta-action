// Where issue keys come from when the workflow does not pass them (DECISIONS 72): the pull request title and branch,
// the branch or tag name, and the commit messages of the build range. The range needs history: with the default
// shallow checkout (fetch-depth 1) git fails and the event payload's commit messages are used instead.

/** Runs git with the given arguments; resolves to stdout, or null when git fails. */
export type Git = (args: string[]) => Promise<string | null>;

export interface DiscoverContext {
  eventName: string;
  /** Parsed GITHUB_EVENT_PATH payload ({} when absent). */
  event: unknown;
  sha: string;
  /** GITHUB_REF, e.g. refs/heads/PAY-12-login or refs/tags/v1.4.2. */
  ref: string;
  git: Git;
}

export interface Text {
  source: "pull request title" | "branch" | "commits" | "head commit";
  text: string;
}

const MAX_COMMITS = "1000";
const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{7,64}$/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const field = (v: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), v);

async function log(git: Git, range: string): Promise<string | null> {
  return git(["log", "--format=%B", `--max-count=${MAX_COMMITS}`, range, "--"]);
}

async function headMessage(ctx: DiscoverContext): Promise<string | null> {
  if (!SHA.test(ctx.sha)) return null;
  return ctx.git(["log", "-1", "--format=%B", ctx.sha, "--"]);
}

/** Texts to scan for issue keys, most specific first. */
export async function discoverTexts(ctx: DiscoverContext): Promise<Text[]> {
  const out: Text[] = [];
  const add = (source: Text["source"], text: string | null | undefined) => {
    if (text) out.push({ source, text });
  };
  const e = ctx.event;

  if (ctx.eventName === "pull_request" || ctx.eventName === "pull_request_target") {
    add("pull request title", str(field(e, "pull_request", "title")));
    add("branch", str(field(e, "pull_request", "head", "ref")));
    const base = str(field(e, "pull_request", "base", "sha"));
    const head = str(field(e, "pull_request", "head", "sha"));
    if (base && head && SHA.test(base) && SHA.test(head)) add("commits", await log(ctx.git, `${base}..${head}`));
    return out;
  }

  if (ctx.ref.startsWith("refs/heads/")) add("branch", ctx.ref.slice("refs/heads/".length));

  if (ctx.ref.startsWith("refs/tags/") && SHA.test(ctx.sha)) {
    // Release builds: everything since the previous tag.
    const previous = (await ctx.git(["describe", "--tags", "--abbrev=0", `${ctx.sha}^`]))?.trim();
    // A tag name starting with "-" would reach git log as an option (M5.2), so such a tag is not used as a range.
    if (previous && !previous.startsWith("-")) {
      const commits = await log(ctx.git, `${previous}..${ctx.sha}`);
      if (commits !== null) {
        add("commits", commits);
        return out;
      }
    }
  }

  if (ctx.eventName === "push") {
    const before = str(field(e, "before"));
    const after = str(field(e, "after")) ?? ctx.sha;
    if (before && !ZERO_SHA.test(before) && SHA.test(before) && SHA.test(after)) {
      const commits = await log(ctx.git, `${before}..${after}`);
      if (commits !== null) {
        add("commits", commits);
        return out;
      }
    }
    // Shallow clone or new branch: the payload lists up to 20 commits.
    const commits = field(e, "commits");
    if (Array.isArray(commits)) {
      add("commits", commits.map((c) => str(field(c, "message")) ?? "").join("\n"));
    }
    add("head commit", str(field(e, "head_commit", "message")));
    return out;
  }

  add("head commit", await headMessage(ctx));
  return out;
}
