# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### cloudflare tunnel

for temporary mobile access over https, run a quick cloudflare tunnel:

```bash
CODEX_WEB_BASIC_AUTH='username:strong-password' npm run tunnel
```

`CODEX_WEB_BASIC_AUTH` must be a single `username:password` value. choose a real
password, keep the value out of shell history if possible, and never commit it
to the repository. the tunnel script requires this variable so the public URL is
not exposed without basic auth.

the script starts `codex-web` on `127.0.0.1:8214`, starts `cloudflared`, then
prints the public URL and a QR code for opening it on a phone. use
`CODEX_WEB_PORT` to change the local port:

```bash
CODEX_WEB_BASIC_AUTH='username:strong-password' CODEX_WEB_PORT=8321 npm run tunnel
```

quick tunnel URLs are temporary and change on every run. for a fixed URL, create
a named cloudflare tunnel and route your hostname to it:

```bash
cloudflared tunnel login
cloudflared tunnel create codex-web
cloudflared tunnel route dns codex-web codex.example.com
```

then create `~/.cloudflared/config.yml`:

```yaml
tunnel: codex-web
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: codex.example.com
    service: http://127.0.0.1:8321
  - service: http_status:404
```

start the fixed-url tunnel with:

```bash
CODEX_WEB_BASIC_AUTH='username:strong-password' \
CODEX_WEB_PORT=8321 \
CODEX_WEB_TUNNEL_NAME='codex-web' \
CODEX_WEB_PUBLIC_URL='https://codex.example.com' \
npm run tunnel
```

in named tunnel mode, `CODEX_WEB_PUBLIC_URL` is used for the QR code and
`cloudflared tunnel run <name>` uses the cloudflared config for the actual
routing.

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
codex app-server --listen ws://127.0.0.1:9001
# reachable now with `codex --remote ws://127.0.0.1:9001` then `/resume`
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_REMOTE_WS_URL=ws://127.0.0.1:9001
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

## security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

when exposing `codex-web` outside localhost, use authentication. the built-in
basic auth is intended as a minimal guard for personal tunnel usage:

```bash
CODEX_WEB_BASIC_AUTH='username:strong-password' npm run server
```

basic auth protects the page, uploads, and websocket bridge. for longer-lived
public deployments, prefer an additional access layer such as cloudflare access,
tailscale, wireguard, an ssh tunnel, or a reverse proxy with stronger identity
controls.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

* [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
* the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
* upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
