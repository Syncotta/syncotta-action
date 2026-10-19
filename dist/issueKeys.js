// Issue key rules, identical to the app's (app/src/mapping/issueKeys.ts, DECISIONS 85); test/issueKeys.test.ts
// compares both on the same inputs.
/** Jira's deployment associations and the /ci route accept at most 500 keys. */
export const MAX_ISSUE_KEYS = 500;
const KEY = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]+-[1-9]\d{0,9})(?![A-Za-z0-9_])/g;
const EXACT_KEY = /^[A-Z][A-Z0-9_]+-[1-9]\d{0,9}$/;
export function isIssueKey(value) {
    return EXACT_KEY.test(value);
}
/** Keys from several texts, in order of first appearance, deduplicated, capped at MAX_ISSUE_KEYS. */
export function extractIssueKeys(texts) {
    const seen = new Set();
    for (const text of texts) {
        for (const match of text.matchAll(KEY)) {
            seen.add(match[1]);
            if (seen.size >= MAX_ISSUE_KEYS)
                return [...seen];
        }
    }
    return [...seen];
}
/** Splits a comma or newline separated input into trimmed, non-empty items. */
export function splitList(value) {
    return value
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s !== "");
}
