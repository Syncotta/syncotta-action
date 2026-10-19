// The action: read inputs, find issue keys, send { image, tags, repository, commit, issueKeys } to /ci.
// Never prints the HMAC key or the events URL (both masked first) and never fails the build unless asked to.
import type { CiResult, CiRequest } from "./client.js";
import type { DiscoverContext } from "./discover.js";
import { discoverTexts } from "./discover.js";
import { extractIssueKeys, isIssueKey, MAX_ISSUE_KEYS, splitList } from "./issueKeys.js";
import type { Workflow } from "./workflow.js";

export interface RunDeps {
  wf: Workflow;
  env: Record<string, string | undefined>;
  readEvent: () => unknown;
  git: DiscoverContext["git"];
  post: (request: CiRequest) => Promise<CiResult>;
}

class InputError extends Error {}

const COMMIT = /^[0-9a-f]{7,64}$/i;
const HMAC_KEY = /^[0-9a-f]{64}$/i;
const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Base URL of the events trigger; accepts the admin page's .../events URL. */
export function ciUrl(eventsUrl: string): string {
  let url: URL;
  try {
    url = new URL(eventsUrl);
  } catch {
    throw new InputError("events-url is not a URL");
  }
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
    throw new InputError("events-url must be an https URL without query string");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(events|ci)$/, "");
  return `${url.origin}${path}/ci`;
}

function defaultRepository(env: RunDeps["env"]): string | null {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) return null;
  try {
    return `${new URL(env.GITHUB_SERVER_URL ?? "https://github.com").host}/${repo}`;
  } catch {
    return `github.com/${repo}`;
  }
}

/** Returns the process exit code. */
export async function run(deps: RunDeps): Promise<number> {
  const { wf, env } = deps;
  const failOnError = wf.input("fail-on-error").toLowerCase() === "true";
  const hmacKey = wf.input("hmac-key");
  const eventsUrl = wf.input("events-url");
  wf.mask(hmacKey);
  wf.mask(eventsUrl);

  const fail = (message: string): number => {
    wf.setOutput("status", "failed");
    if (failOnError) {
      wf.error(message);
      return 1;
    }
    wf.warning(`${message} (fail-on-error is false, the build continues)`);
    return 0;
  };

  let request: CiRequest;
  let keys: string[];
  try {
    const instanceId = wf.input("instance-id");
    const image = wf.input("image");
    if (!INSTANCE_ID.test(instanceId)) throw new InputError("instance-id is missing or malformed");
    if (!HMAC_KEY.test(hmacKey)) throw new InputError("hmac-key must be the 64 hex characters from the admin page");
    if (image === "") throw new InputError("image is required");
    const url = ciUrl(eventsUrl);

    const commit = wf.input("commit") || env.GITHUB_SHA || "";
    if (commit !== "" && !COMMIT.test(commit)) throw new InputError("commit must be a hex SHA");

    const given = splitList(wf.input("issue-keys"));
    const invalid = given.filter((k) => !isIssueKey(k));
    if (invalid.length > 0) throw new InputError(`issue-keys contains ${invalid.length} malformed key(s)`);
    if (given.length > 0) {
      keys = [...new Set(given)].slice(0, MAX_ISSUE_KEYS);
      wf.info(`Issue keys from the issue-keys input: ${keys.join(", ")}`);
    } else {
      const texts = await discoverTexts({
        eventName: env.GITHUB_EVENT_NAME ?? "",
        event: deps.readEvent(),
        sha: env.GITHUB_SHA ?? "",
        ref: env.GITHUB_REF ?? "",
        git: deps.git,
      });
      keys = extractIssueKeys(texts.map((t) => t.text));
      const sources = [...new Set(texts.map((t) => t.source))].join(", ") || "nothing";
      wf.info(`Issue keys found in ${sources}: ${keys.length > 0 ? keys.join(", ") : "none"}`);
    }

    if (!image.includes("@sha256:")) {
      wf.notice("image has no digest: Jira links then rely on the tag pointing to this build. Pass the digest for exact links.");
    }
    request = {
      url,
      instanceId,
      hmacKey,
      body: JSON.stringify({
        schema: 1,
        image,
        tags: splitList(wf.input("tags")),
        repository: wf.input("repository") || defaultRepository(env),
        commit: commit === "" ? null : commit,
        issueKeys: keys,
      }),
    };
  } catch (err) {
    if (err instanceof InputError) return fail(`Syncotta: ${err.message}`);
    throw err;
  }

  wf.setOutput("issue-keys", keys.join(","));
  if (keys.length === 0) {
    wf.setOutput("status", "skipped");
    wf.info("No issue keys found: nothing sent to Syncotta.");
    return 0;
  }

  const result = await deps.post(request);
  if (!result.ok) return fail(`Syncotta: ${result.reason} after ${result.attempts} attempt(s)`);
  wf.setOutput("status", "sent");
  wf.info(`Sent to Syncotta: ${keys.length} issue key(s) for this image.`);
  return 0;
}
