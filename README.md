# Syncotta CI report (GitHub Action)

Tells Syncotta for Jira which issues a container image belongs to. When Argo CD later deploys that image, the
deployment shows up on those Jira work items, also for multi-source apps where Argo CD cannot read the commit
message.

The action sends `{ image, tags, repository, commit, issueKeys }` to the Syncotta `/ci` web trigger, signed with
the instance's HMAC key. It has no dependencies besides Node.js and `git`.

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
      - uses: Syncotta/syncotta-action@v0 # or pin a release tag such as v0.1.0, or a commit SHA
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
