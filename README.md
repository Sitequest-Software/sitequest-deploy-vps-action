# Sitequest Deploy VPS

Capistrano-style atomic deploy to a [Sitequest](https://site.quest) VPS, driven entirely through the REST API. No SSH keys to manage, no `known_hosts` shuffling.

## Layout produced on the VPS

```
<target-base>/
├── current               → releases/<latest-run-id>     (symlink, atomically swapped)
├── releases/
│   ├── 12345-1/
│   ├── 12346-1/
│   └── 12347-1/                                          (current N kept, default 5)
└── uploads/                                              (transient tarballs)
```

## Quick start

```yaml
name: Deploy
on:
  push: { branches: [main] }

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build

      - uses: sitequest/deploy-vps-action@v1
        with:
          api-key:         ${{ secrets.SITEQUEST_API_KEY }}
          vps-id:          ${{ vars.SITEQUEST_VPS_ID }}
          source:          dist
          target-base:     /var/www/myapp
          owner:           www-data:www-data
          restart-service: myapp.service
          keep-releases:   "10"
```

Your service should reference `/var/www/myapp/current/` so the symlink swap atomically points it at the new release.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `api-key` | yes | — | API key with `vps:manage` scope. |
| `vps-id` | yes | — | Target VPS ID. |
| `source` | no | `dist` | Local directory to deploy. |
| `target-base` | yes | — | Absolute path on the VPS (e.g. `/var/www/myapp`). |
| `keep-releases` | no | `5` | Old releases to retain. `0` = keep all. |
| `restart-service` | no | — | Comma-separated systemd units to restart after swap. |
| `owner` | no | — | `user[:group]` to chown the release to. |
| `api-base` | no | `https://hosting.site.quest` | Override for staging. |

## Outputs

| Name | Description |
|------|-------------|
| `release-path` | Absolute path of the new release directory. |
| `bytes-uploaded` | Tar.gz size in bytes. |
| `duration-ms` | End-to-end duration. |

## Limits

- Maximum archive size: **2 GB** (compressed). Larger archives are split client-side into 24 MB chunks and reassembled on the VPS, so the per-request 32 MB API cap is never an issue. The endpoint accepts raw octet-stream uploads, so no base64 inflation overhead.
- For larger payloads, upload the tarball via SFTP directly with an SSH key, then use [`sitequest/exec-action`](https://github.com/sitequest/exec-action) to run the extract+swap script.

## Rollback

Point `current` at a previous release and restart the service:

```yaml
- uses: sitequest/exec-action@v1
  with:
    api-key:  ${{ secrets.SITEQUEST_API_KEY }}
    resource: vps
    id:       ${{ vars.SITEQUEST_VPS_ID }}
    command: |
      cd /var/www/myapp
      ln -sfn releases/12346-1 current.next && mv -Tf current.next current
      systemctl restart myapp.service
```

## Composition

Run migrations *before* the swap by setting `keep-releases` to retain rollback targets, then deploy, then exec migrations against the new release path:

```yaml
- id: deploy
  uses: sitequest/deploy-vps-action@v1
  with:
    api-key:     ${{ secrets.SITEQUEST_API_KEY }}
    vps-id:      ${{ vars.SITEQUEST_VPS_ID }}
    source:      dist
    target-base: /var/www/myapp

- uses: sitequest/exec-action@v1
  with:
    api-key:  ${{ secrets.SITEQUEST_API_KEY }}
    resource: vps
    id:       ${{ vars.SITEQUEST_VPS_ID }}
    command:  /var/www/myapp/current/bin/migrate
```

## Security

- All commands run as **root** on the VPS — that's the VPS exec model. Treat the API key accordingly; restrict it to a single VPS in the dashboard.
- Every input is validated and shell-escaped before being concatenated into the deploy pipeline.
- The remote pipeline is invoked with `set -eu` — any step's failure aborts the deploy without partial state.
- Audited server-side as `SSH_EXEC` per call.

## License

MIT
