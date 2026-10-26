# Syncotta CI report (GitHub Action)

Tells Syncotta for Jira which issues a container image belongs to. When Argo CD later deploys that image, the
deployment shows up on those Jira work items, also for multi-source apps where Argo CD cannot read the commit
message.

The action sends `{ image, tags, repository, commit, issueKeys, pullRequest }` to the Syncotta `/ci` web trigger,
signed with the instance's HMAC key. It has no dependencies besides Node.js and `git`.

## Setup

1. In Jira, open the Syncotta admin page (Jira settings > Apps > Manage apps > Syncotta) and note the
   **Argo CD Notifications** URL and the instance id. Click **New HMAC key** for the instance and copy the key.
2. In the GitHub repository, add the secrets `SYNCOTTA_EVENTS_URL` (that URL) and `SYNCOTTA_HMAC_KEY` (the key),
   and the variable `SYNCOTTA_INSTANCE_ID`.
3. Add the step after the image is pushed:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read # audit trail: which pull request shipped the image and how many approvals it had
      packages: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history: issue keys from every commit of the push or since the last tag
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: push
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
      - uses: Syncotta/syncotta-action@v0 # or pin a release tag such as v0.2.0, or a commit SHA
        with:
          events-url: ${{ secrets.SYNCOTTA_EVENTS_URL }}
          instance-id: ${{ vars.SYNCOTTA_INSTANCE_ID }}
          hmac-key: ${{ secrets.SYNCOTTA_HMAC_KEY }}
          image: ghcr.io/${{ github.repository }}:${{ github.sha }}@${{ steps.push.outputs.digest }}
```

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `events-url` | yes | | Events URL from the admin page (`.../events`; the action calls `.../ci`) |
| `instance-id` | yes | | Instance id from the admin page |
| `hmac-key` | yes | | HMAC key of the instance (64 hex characters) |
| `image` | yes | | Pushed image. With `@sha256:` digest the link is exact; a tag alone links whatever later runs under that tag |
| `tags` | no | | More tags of the same image, comma or newline separated |
| `issue-keys` | no | | Use these keys instead of discovering them |
| `repository` | no | `github.com/<owner>/<repo>` | Source repository stored with the image |
| `commit` | no | `GITHUB_SHA` | Commit stored with the image |
| `github-token` | no | `${{ github.token }}` | Token to look up the pull request for the audit trail (needs `pull-requests: read` and `contents: read`). Empty skips the lookup |
| `fail-on-error` | no | `false` | `true` fails the step when Syncotta cannot be reached or refuses the request |

Outputs: `issue-keys` (comma separated) and `status` (`sent`, `skipped` when no keys were found, `failed`).

## Where the issue keys come from

Without `issue-keys`, the action scans, in this order:

| Event | Texts |
| --- | --- |
| `pull_request`, `pull_request_target` | PR title, head branch name, commit messages between base and head |
| `push` to a branch | branch name, commit messages between `before` and `after` |
| `push` of a tag | commit messages since the previous tag |
| anything else (`workflow_dispatch`, `release`, ...) | branch name, message of the built commit |

Keys look like `PAY-123` (same rules as the app). Commit ranges need history: with the default `fetch-depth: 1`
git cannot see the range and the action falls back to the commits listed in the push event (up to 20). No keys
means nothing is sent and the step still succeeds.

Mutable tags (`latest`, `main`, `master`, `dev`, `develop`, `stable`, `edge`, `nightly`) are ignored by Syncotta:
they would link later deployments to the wrong issues.

## Security

- The HMAC key and the events URL are masked in the log; the action never prints them.
- Each request carries a timestamp and a fresh nonce; Syncotta refuses requests older than 5 minutes and repeated
  nonces. A runner with a wrong clock gets "authentication failed".
- Failures only warn by default, so a Syncotta outage never breaks a build.

## Development

```bash
cd action
npm ci
npm run typecheck && npm test && npm run lint
npm run build   # writes dist/, which is committed; CI checks it is up to date
```

## Pull request audit trail

For the audit trail (which pull request shipped an image, how many approvals it had and when, when it was merged)
the action looks up the pull request with `github-token` and adds `pullRequest` to the request:

```json
"pullRequest": { "number": 12, "url": "https://github.com/acme/pay/pull/12", "mergedAt": "2026-10-19T10:00:00Z",
                 "approvals": 2, "approvedAt": "2026-10-19T09:30:00Z" }
```

- `push`, tag and other builds: the merged pull request whose merge commit is the built commit, else the first
  merged pull request that contains it (`GET /repos/{repo}/commits/{sha}/pulls`). None found: no `pullRequest`.
- `pull_request`, `pull_request_target`: the event's pull request (`mergedAt` is usually `null`).
- `approvals` counts reviewers whose latest review is an approval, as GitHub does: a later "changes requested"
  replaces an approval, a dismissed approval no longer counts, comments change nothing. `approvedAt` is the time of
  the newest of those approvals. At most 300 reviews are read.
- No reviewer logins, author names or titles are sent or printed; logins are only used in memory to count
  distinct reviewers.
- The workflow needs `permissions: pull-requests: read` (and `contents: read`). Without them, or on rate limits and
  network errors, the action warns once and sends the rest without `pullRequest`; the build never fails for this,
  even with `fail-on-error: true`. On GitHub Enterprise Server the API URL comes from `GITHUB_API_URL`.

## Issues and support

The [issues](https://github.com/Syncotta/syncotta-action/issues) of this repository are the public tracker for all of
Syncotta: the Jira app, the Helm chart, the gate client and this action. Never post tokens, HMAC keys, web trigger URLs
or your Jira site URL. Private support: contact@syncotta.com ([support terms](https://syncotta.com/support/));
vulnerabilities: security@syncotta.com ([security page](https://syncotta.com/security/#vulnerabilities)).
