# Prerequisites — the Core Platform

The strict minimum to install **before** running the `.gitlab-ci.yml` pipeline.
All the host configuration (the Podman socket, registries.conf, the network, …)
is taken care of by the pipeline itself.

> **Check your machine in one command**:
> ```bash
> ./preflight.sh
> ```
> The script modifies nothing — it read-only checks the prerequisites below (plus the Bun app-builder toolchain)
> and exits with an error if a prerequisite is missing. To be used before the very first
> `gitlab-ci-local`.

## Required

### Podman ≥ 4

An OCI container runtime, rootless by default. It replaces Docker, compatible with
the `docker-compose.yml` format.

> **Windows or native Linux, at the participant's choice.** Both environments
> are supported and tested. Choose the one you are most comfortable with —
> the cloud target is Linux in both cases.

| OS | Installation |
|---|---|
| **Windows (through WSL2)** | WSL2 + Ubuntu 22.04+, then install Podman **inside the Linux distribution** (not through Podman Desktop). |
| **Ubuntu / Debian (native)** | `sudo apt update && sudo apt install -y podman podman-compose` |
| **RHEL / Fedora / CentOS Stream (native)** | `sudo dnf install -y podman podman-compose` |
| **macOS** *(not supported for the workshop)* | `brew install podman && podman machine init && podman machine start` — the stack may run, but `preflight.sh` (it uses `ss`) and the support assume WSL2 or native Linux |

The check:

```bash
podman --version          # >= 4.0
podman compose version    # the compose plugin is present
podman info | grep -i rootless   # has to report rootless
```

### `podman compose` (the subcommand)

The pipeline calls `podman compose -p core up -d`. Depending on the Podman
version, that subcommand is provided by:

- **Podman ≥ 5**: built in natively (it uses `podman-compose` or `docker-compose` as a backend if present).
- **Podman 4.x**: install `podman-compose` separately (the `podman-compose` package).

If `podman compose version` fails, install the package:

```bash
sudo apt install -y podman-compose      # Debian/Ubuntu
sudo dnf install -y podman-compose      # RHEL/Fedora
pip3 install --user podman-compose      # universal fallback
```

### gitlab-ci-local (serverless execution of the pipeline)

[`gitlab-ci-local`](https://github.com/firecow/gitlab-ci-local) runs a
`.gitlab-ci.yml` **with no GitLab Runner and no GitLab server** — just the
file and a CLI binary.

Installation (**Node.js ≥ 20 required** — the recent versions of
`gitlab-ci-local` depend on packages that require Node 20):

```bash
# Check the Node version
node --version    # has to be >= v20

# If Node < 20 (Ubuntu 24.04 ships Node 18 by default) — install through NodeSource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install gitlab-ci-local (sudo, because it is a global install)
sudo npm i -g gitlab-ci-local
```

The check:

```bash
gitlab-ci-local --version    # short alias: gcl --version
```

### python3 + openssl (seeding the LLM gateway, generating credentials)

`apisix/seed-and-deploy.sh` turns the JSON of the virtual keys into APISIX YAML
consumers through `python3`; `onboard-app.sh` and the apps' `bootstrap.sh`
generate their random keys with `openssl`. Both are present by default on most
Linux/WSL2 distributions and on macOS.

```bash
python3 --version    # >= 3.8
openssl version
```

## App-builder — building the application services

The platform runs without them, but the apps you build on it need:

| Tool | Status | Install | Check |
|---|---|---|---|
| **Bun ≥ 1.1** | **required** — the backend runtime + toolchain | `curl -fsSL https://bun.sh/install \| bash` | `bun --version` |
| Rust + the `x86_64-unknown-linux-musl` target + `musl-tools` | optional — only for a service under a measured hot-path waiver | `rustup target add x86_64-unknown-linux-musl` · `sudo apt install -y musl-tools` | `cargo --version` |
| A coding agent (`claude` or `vibe`) | reported, never blocking — the agent your harness drives | `npm i -g @anthropic-ai/claude-code`, or Mistral Vibe | `claude --version` |

`preflight.sh` checks these too, in its *App-builder* and *Coding agent* sections.

## Not required — the CLIs the containers ship

The platform used to require `vault` and `mc` on the workstation. **It no longer
does.** Every platform script (and every app `bootstrap.sh`) resolves its CLI as:

```
a host binary that ANSWERS   →   otherwise   podman exec <container>
```

The `openbao.internal`, `s3` and `temporal.internal` containers each ship their
own CLI (`bao`, `weed shell`, `temporal`), so a **bare machine runs the
platform**. That was a deliberate goal of the open-source swap: fewer things to
install before a workshop, and no vendor binary to fetch.

Installing them anyway is pure comfort for poking at the stack by hand:

| CLI | What it buys you | Install |
|---|---|---|
| `bao` | `bao kv get …` from the host instead of `podman exec openbao.internal bao …` | [openbao.org/downloads](https://openbao.org/downloads/) |
| `mc` | browsing/copying S3 objects from the shell | `curl -L https://dl.min.io/client/mc/release/linux-amd64/mc -o ~/.local/bin/mc && chmod +x ~/.local/bin/mc` |
| `temporal` | `temporal workflow list -n <app>` from the host | [github.com/temporalio/cli](https://github.com/temporalio/cli/releases) |

> ⚠ **A binary on the `$PATH` is not proof that it works.** A workstation set up
> before the OpenBao swap may carry a `~/.local/bin/vault` that is itself a
> `podman exec vault.internal vault …` shim — and `vault.internal` is now only a
> *network alias*, not a container name, so that shim fails on every call. The
> platform scripts **probe** each candidate rather than trusting `$PATH`, so they
> route around it; your own by-hand `vault …` calls will not. Replace the shim
> with `podman exec openbao.internal bao`, or delete it.

## Ports to free up

The stack exposes 12 ports on `localhost`. Check that they are free before
launching the pipeline. Note that the platform deliberately keeps **out of the
`8000-8999` range**, which is reserved for the apps
(README.md → [The ports convention](./README.md#the-ports-convention)).

| Port | Service |
|---|---|
| 5000 | Registry |
| 5432 | Postgres |
| 6379 | Valkey |
| 7233 | Temporal — the gRPC frontend |
| 8200 | OpenBao UI + API |
| 9000 | Object store — the S3 API |
| 9001 | Object store — the filer browser |
| 9080 | APISIX — gateway `llm.internal` |
| 9233 | Temporal — the web UI |
| 9300 | Casdoor — the IdP |
| 9400 | Umami — analytics |
| 9999 | Dozzle |

```bash
ss -ltn | grep -E ':(5000|5432|6379|7233|8200|9000|9001|9080|9233|9300|9400|9999)\b'   # has to print nothing
```

## The network

Outbound HTTPS access to fetch the images from `docker.io`. Any corporate proxy
is to be configured in
`~/.config/containers/registries.conf` and/or the `HTTP_PROXY` variables before
the first `podman pull`.

## The final check

```bash
./preflight.sh
```

An executable implementation of every check in this document. Exit 0 if all is
OK, 1 otherwise with the list of the missing items.
