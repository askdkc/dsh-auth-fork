# @deepseek-harness-tui/dsh-auth

> Provider authentication for [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) and
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

Use **ChatGPT, Claude, SuperGrok, OpenCode Zen/Go, OrcaRouter, OpenRouter,
Nous Portal, and Infron** as model providers with OAuth, device code, or an
API key according to the provider. No dsh source patch is needed. This plugin is developed alongside (and
bundled into) [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI), the
Claude Code style terminal front door for DeepSeek Harness; it also installs
standalone into any dsh profile.

```
dsh-tui → /provider → Provider authentication → sign in
          /auth login openai-codex                     ← the plugin command
          /model → OpenAI Codex → gpt-5.6-sol          ← routes & models
```

**Status: experimental.** Catalog OAuth flows are
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)'s shipped
implementations (device-code and loopback callback included); this plugin
adds the hosting: credential storage, automatic token refresh, adapter
registration, and a login surface over the `userQuestions` seam that works in
the TUI, the web client, and refuses cleanly on headless hosts.

## Install

**With dsh-TUI** — nothing to do: dsh-auth ships inside the dsh-tui package
(bundled dependency). Update dsh-tui and the `/provider` wizard gains its
provider authentication branch automatically.

**Standalone, into any dsh profile:**

```sh
dsh plugin --profile <name> add @deepseek-harness-tui/dsh-auth
```

Then restart the host; `/` lists `auth`, and every model picker gains the
signed-in providers' catalogs (credential-gated — see below).

## What it does

- Mounts pi-ai catalog providers as `llm` registry routes:
  `openai-codex`, `anthropic`, `xai`, `opencode`, `opencode-go`, and `openrouter`.
  **Models appear in a picker
  only after that provider is signed in** (credential-gated listing) — sign
  in and the catalog appears, sign out and it disappears; model ids already
  saved in sessions stay resolvable either way.
- Loads those Provider objects from the exact pi-ai dependency owned by the
  installed `dsh-llm-pi-ai`. rc and alpha hosts therefore keep their supported
  pi-ai versions without passing Provider objects across package instances.
- `/auth login [provider]` runs the selected authentication method interactively. The
  waiting panel behaves the way pi's host does: the authorization URL is
  **opened in your browser automatically** (never hand-copied — the URL is
  hundreds of characters and wrap artifacts corrupt its `redirect_uri`),
  and the panel offers *Copy authorization link* / *Open browser again* /
  *Cancel sign-in*. Device-code flows open the verification page and make
  the short code the copy target. OpenAI Codex also offers a device-code
  login method — the most robust path on headless or locked-down machines
  (no localhost:1455 callback needed).
- OpenCode Zen/Go accept API keys. OpenRouter offers pi-ai's OAuth PKCE flow
  or a manual API key. `orcarouter`, `nous`, and `infron` use Chat Completions;
  their `/models` listings must provide capacity and pricing metadata before
  a model is selectable. `nous` offers device-code OAuth and an explicitly
  selected manual Bearer token compatibility path. The latter has not been
  validated against a real Nous account.
- Stored access tokens refresh automatically before each request, serialized
  per provider under the credential store's lock — concurrent requests never
  double-refresh a rotated token.
- `/auth status` / `/auth logout <provider>`; the `ctx.dshAuth` service
  exposes the same api for UIs (the dsh-tui `/provider` wizard and `/login`
  ride it).

## Usage

```
/auth                          # status: which providers are signed in
/auth login                    # pick a provider interactively
/auth login openai-codex       # ChatGPT (Plus/Pro)
/auth login anthropic          # Claude (Pro/Max)
/auth login xai                # SuperGrok / X Premium
/auth login opencode           # OpenCode Zen API key
/auth login opencode-go        # OpenCode Go API key
/auth login orcarouter         # OrcaRouter API key
/auth login openrouter         # OAuth PKCE or API key
/auth login nous               # device code or manual Bearer
/auth login infron             # Infron API key
/auth logout anthropic
```

Model requests against a provider you have not signed in to fail loudly with
the `/auth login <provider>` hint — never silently.

## Configuration

```yaml
- id: dsh-auth
  name: '@deepseek-harness-tui/dsh-auth'
  config:
    providers: [openai-codex, anthropic, xai, opencode, opencode-go, orcarouter, openrouter, nous, infron]
    nous:
      clientId: hermes-cli
    # credentialsFile: /secure/path/credentials.json
```

- `credentialsFile` defaults to `$DSH_HOME/dsh-auth/credentials.json`
  (`~/.dsh/dsh-auth/credentials.json`), overridable with the
  `DSH_AUTH_CREDENTIALS` environment variable. The directory is created
  `0700`, the file `0600` (best-effort on Windows), and every write is
  atomic (temp file + rename).
- Aliases `opencode-zen`, `hermes`, and `infron.ai` resolve to `opencode`,
  `nous`, and `infron`. Credentials are stored under canonical IDs.
- The Nous client ID defaults to `hermes-cli`; third-party reuse of this ID is
  not guaranteed by Nous. Set `nous.clientId` if your deployment has its own.
- A route another adapter family already owns — an `llm-pi-ai` settings
  profile naming the same provider — is refused by the registry; the plugin
  logs the refusal and mounts the remaining routes. Keep one provider on one
  adapter.

## Security notes

- The credential file holds **API keys and long-lived refresh tokens**. It is never
  logged, never echoed through status surfaces (`/auth status` shows expiry
  metadata only), and a corrupt file fails loudly instead of being
  overwritten.
- dsh-TUI masks API-key input and redacts it from questionnaire summaries.
- Login refuses to run where no interactive surface is registered (no
  browser/GUI assumptions — remote and headless hosts get a clear error,
  per the ecosystem spec's remote-determinism rule, TUI-RUN-001).
- Subscription authentication and API-key access are different products:
  ChatGPT Codex and Claude Pro/Max use their subscription backends; the new
  API-key routes use each service's API backend.

## Development

```sh
pnpm install
pnpm verify     # build + headless smoke (credential store, refresh
                # serialization, prompt bridging, gating, service api)
```

The smoke suite runs without cordis or a harness: the pure modules are
exercised directly. Real end-to-end login needs an interactive host
(dsh-tui) and is verified manually per release. The plugin is developed in
the [dsh-TUI repository](https://github.com/ccch1mneyyy/dsh-TUI) as the
`dsh-auth/` submodule and mirrors to this repository.

## Roadmap

- **M2** *(landed)* — dsh-tui integration: `/provider` OAuth branch, `/login`
  account section, two-level `/model` picker with a pinned recently-used
  group.
- **M3** — `dsh-ecosystem-spec` conformance (manifest validation, admission
  fixtures) plus the remaining pi-ai OAuth providers (GitHub Copilot,
  Kimi); community list entry.
- **M4** — Gemini: a custom Google device-code flow (pi-ai ships none; this
  is the one wheel this project plans to build itself).

## License

MIT
