// The pull request that shipped the build, for the audit trail (M11, DECISIONS 136): number, link, merge time and
// how many reviewers approved it, and when. Read from the GitHub REST API with the workflow token. Reviewer logins
// stay in memory to count distinct reviewers; they are never returned, sent or printed (no personal data, human
// decision 2026-10-20). Any failure yields an error result: the caller warns and sends the body without the field.
const TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
const MAX_REVIEW_PAGES = 3;
const MAX_NUMBER = 1_000_000_000;
const MAX_URL = 500;
const MAX_APPROVALS = 100;
// owner/repo; "." and ".." segments would change the API path.
const REPOSITORY = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);
class ApiError extends Error {
}
/** ISO time as given, or null when absent or not a time. */
function time(v) {
    const s = str(v);
    return s !== undefined && !Number.isNaN(Date.parse(s)) ? s : null;
}
function prNumber(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_NUMBER ? v : null;
}
function prUrl(v) {
    const s = str(v);
    if (s === undefined || s.length > MAX_URL)
        return null;
    try {
        return new URL(s).protocol === "https:" ? s : null;
    }
    catch {
        return null;
    }
}
function describe(status) {
    if (status === 401)
        return "the github-token was refused (HTTP 401)";
    if (status === 403 || status === 429)
        return `access denied or rate limited (HTTP ${status})`;
    if (status === 404)
        return "not found (HTTP 404; a private repository needs read access for the token)";
    return `HTTP ${status}`;
}
async function getJson(ctx, path) {
    const base = (ctx.apiUrl || "https://api.github.com").replace(/\/+$/, "");
    let response;
    try {
        response = await ctx.fetch(`${base}${path}`, {
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${ctx.token}`,
                "x-github-api-version": "2022-11-28",
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }
    catch (err) {
        throw new ApiError(`network error (${err instanceof Error ? err.name : "unknown"})`);
    }
    if (!response.ok)
        throw new ApiError(describe(response.status));
    try {
        return await response.json();
    }
    catch {
        throw new ApiError("the response was not JSON");
    }
}
/** The PR merged as this commit, else the first merged PR containing it; null when there is none. */
async function prForCommit(ctx) {
    const list = await getJson(ctx, `/repos/${ctx.repository}/commits/${ctx.sha}/pulls`);
    if (!Array.isArray(list))
        throw new ApiError("unexpected response for the commit's pull requests");
    const merged = list.filter((p) => isRecord(p) && time(p.merged_at) !== null);
    const sha = ctx.sha.toLowerCase();
    return merged.find((p) => str(p.merge_commit_sha)?.toLowerCase() === sha) ?? merged[0] ?? null;
}
// GitHub's rule: a reviewer's latest APPROVED, CHANGES_REQUESTED or DISMISSED review is their state; COMMENTED and
// PENDING reviews do not change it. A dismissed approval arrives with state DISMISSED, so it no longer counts.
const DECIDING = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
async function approvals(ctx, number) {
    const latest = new Map();
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
        const reviews = await getJson(ctx, `/repos/${ctx.repository}/pulls/${number}/reviews?per_page=${PER_PAGE}&page=${page}`);
        if (!Array.isArray(reviews))
            throw new ApiError("unexpected response for the pull request's reviews");
        for (const r of reviews) {
            if (!isRecord(r) || !isRecord(r.user))
                continue;
            const state = str(r.state);
            const at = time(r.submitted_at);
            const reviewer = typeof r.user.id === "number" ? `id:${r.user.id}` : str(r.user.login);
            if (state === undefined || !DECIDING.has(state) || at === null || reviewer === undefined)
                continue;
            const ms = Date.parse(at);
            const prev = latest.get(reviewer);
            if (prev === undefined || ms >= prev.ms)
                latest.set(reviewer, { state, at, ms });
        }
        if (reviews.length < PER_PAGE)
            break;
    }
    const approved = [...latest.values()].filter((v) => v.state === "APPROVED");
    const newest = approved.reduce((acc, v) => (acc === null || v.ms > acc.ms ? v : acc), null);
    return { approvals: Math.min(approved.length, MAX_APPROVALS), approvedAt: newest?.at ?? null };
}
export async function findPullRequest(ctx) {
    try {
        if (!REPOSITORY.test(ctx.repository))
            throw new ApiError("GITHUB_REPOSITORY is missing or malformed");
        let pr;
        if (ctx.eventName === "pull_request" || ctx.eventName === "pull_request_target") {
            const p = isRecord(ctx.event) ? ctx.event.pull_request : undefined;
            if (!isRecord(p))
                throw new ApiError("the event has no pull request");
            pr = p;
        }
        else {
            if (!SHA.test(ctx.sha))
                return { ok: true, pullRequest: null };
            pr = await prForCommit(ctx);
        }
        if (pr === null)
            return { ok: true, pullRequest: null };
        const number = prNumber(pr.number);
        const url = prUrl(pr.html_url);
        if (number === null || url === null)
            throw new ApiError("the pull request has no valid number or link");
        return { ok: true, pullRequest: { number, url, mergedAt: time(pr.merged_at), ...(await approvals(ctx, number)) } };
    }
    catch (err) {
        return { ok: false, reason: err instanceof ApiError ? err.message : `unexpected error (${err instanceof Error ? err.name : "unknown"})` };
    }
}
