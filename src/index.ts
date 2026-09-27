/**
 * dsh-auth — provider sign-in as LLM provider routes.
 *
 * One cordis plugin mounts pi-ai catalog and custom provider profiles as
 * `llm` registry routes, so
 * catalog models appear in every model picker after sign-in. `PiAiAdapter` runs with this
 * plugin's file-backed pi-ai `CredentialStore` injected
 * (`PiAiAuthInjection`): requests resolve stored credentials through the
 * provider's own auth or an explicit API key. Refreshes hold the store lock.
 * Login/logout run over the `userQuestions` seam, so they work on any
 * interactive surface and refuse cleanly where none exists (TUI-RUN-001).
 *
 * ```yaml
 * - id: dsh-auth
 *   name: 'dsh-auth'
 *   config:
 *     providers: [openai-codex, anthropic, xai]   # explicit subset; omitted mounts all supported routes
 *     # credentialsFile: /secure/path/credentials.json   # default $DSH_HOME/dsh-auth/
 *     # Per-provider catalog overrides, keyed by provider id then model id:
 *     # any optional field keeps the installed catalog's value. The example
 *     # below tunes the Codex `gpt-5.6-sol` context window to 1M tokens.
 *     # modelOverrides:
 *     #   openai-codex:
 *     #     gpt-5.6-sol:
 *     #       contextWindow: 1000000
 * ```
 *
 * Routes register individually: a route another adapter family already owns
 * (an llm-pi-ai settings profile for the same provider) is refused by the
 * registry — that refusal is logged and the remaining routes still mount.
 *
 * @module dsh-auth
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { LlmAdapter, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { CredentialFile, defaultCredentialsFile } from './credentials.js'
import { buildOAuthProfile, AUTH_PROVIDER_IDS, CATALOG_PROVIDER_IDS, OAUTH_PROVIDER_IDS, canonicalProvider, type ModelOverride } from './profiles.js'
import { createCustomProfile, CUSTOM_PROVIDER_IDS, type CustomProviderId } from './custom-profiles.js'
import { refreshNous } from './nous-oauth.js'
import type { AskFn } from './interaction.js'
import { createDshAuthApi, DshAuthService } from './service.js'
import { createAuthCommandHandler } from './command.js'
import type { PiAiAuthContext } from './pi-ai.js'

export const name = 'dsh-auth'
/**
 * Deliberately empty. A hard code-level inject would deadlock any
 * composition lacking the `llm`/`commands` services at boot ("pending
 * (waiting for service: …)") — the failure mode dsh-tui documented for its
 * own optional rows (#183). Both services resolve per call through
 * `ctx.get` in {@link apply}; compositions that guarantee them (the
 * dsh-tui patch row, this package's bundle patch) declare the inject at the
 * *entry* level, where a stale patch cannot deadlock a newer boot.
 */
export const inject: readonly string[] = []

/** The slice of the llm registry this plugin uses (structural, rc.6-stable). */
interface LlmRegistryLike {
  registerAdapter(providers: readonly string[], adapter: LlmAdapter): () => void
}

/** The slice of the commands registry this plugin uses (structural). */
interface CommandsLike {
  register(descriptor: {
    name: string
    description: string
    handler: (invocation: CommandInvocation) => Promise<CommandResult>
  }): () => void
}

/** Plugin configuration. */
export interface Config {
  /** Provider routes to mount; omitted mounts all supported routes. */
  providers?: string[]
  /** Credential file override; default `$DSH_HOME/dsh-auth/credentials.json`. */
  credentialsFile?: string
  /**
   * Per-provider catalog overrides, keyed by provider id then model id (see
   * {@link ModelOverride}). A provider key naming a provider that is not
   * among the mounted set — or a model id the provider's catalog does not
   * ship — is refused, never skipped, so a typo lands as a boot error.
   */
  modelOverrides?: Record<string, Record<string, ModelOverride>>
  nous?: { clientId?: string }
}

const modelOverride = z.object({
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  providers: z.array(z.string()).default([...AUTH_PROVIDER_IDS]),
  credentialsFile: z.string(),
  modelOverrides: z.dict(z.dict(modelOverride)),
  nous: z.object({ clientId: z.string() }),
})

export type { DshAuthApi, DshAuthLoginResult, DshAuthSignInStatus, DshAuthService } from './service.js'
export { createDshAuthApi } from './service.js'
export { QuestionBridge, describeEvent } from './interaction.js'
export type { AskFn, QuestionBridgeHelpers } from './interaction.js'
export { copyToClipboard, openInBrowser, openerFor } from './opener.js'
export { CredentialFile, defaultCredentialsFile } from './credentials.js'
export { OAUTH_PROVIDER_IDS, CATALOG_PROVIDER_IDS, AUTH_PROVIDER_IDS, canonicalProvider, buildOAuthProfile, type ModelOverride } from './profiles.js'

/**
 * The ambient auth context providers may consult while resolving their own
 * auth. `env()` answers from the process environment; `fileExists()` answers
 * about the host process's filesystem (the paths a provider asks about —
 * `~/.aws/credentials` and friends — are facts about where this process
 * runs, not about the project under edit).
 */
function hostAuthContext(): PiAiAuthContext {
  return {
    env: async name => process.env[name],
    fileExists: path => Promise.resolve(
      path.startsWith('~/') ? existsSync(join(homedir(), path.slice(2))) : existsSync(path),
    ),
  }
}

/**
 * The adapter the plugin registers: a {@link PiAiAdapter} whose *advisory
 * catalog* is credential-gated. A provider with no stored credential
 * lists no models — its rows never reach any model picker, which is the
 * whole point: picking a model that would only fail with "not signed in"
 * is noise. The gate only shapes `listModels`; `resolveModel` and requests
 * are untouched, so a model id already saved in a session (or named
 * explicitly) keeps resolving exactly as the registry contract promises
 * ("advisory and never changes routing").
 *
 * An expired-but-stored credential still lists: token refresh runs on the
 * next request, and a picker that hid a refreshable provider would look
 * signed-out when it is not.
 */
export class CredentialGatedAdapter extends PiAiAdapter {
  constructor(
    options: PiAiAdapterOptions,
    private readonly hasCredential: (provider: string) => Promise<boolean>,
  ) {
    super(options)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (!(await this.hasCredential(provider))) return []
    return super.listModels(provider)
  }
}

/** Mount the routes, the service, and the command. */
export function apply(ctx: Context, config: Config): void {
  const configured = (config.providers ?? [...AUTH_PROVIDER_IDS]).map(canonicalProvider)
  const unknown = configured.filter(id => !(AUTH_PROVIDER_IDS as readonly string[]).includes(id))
  if (unknown.length > 0 || configured.length === 0) {
    throw new Error(
      `dsh-auth: providers must be a non-empty subset of [${AUTH_PROVIDER_IDS.join(', ')}]; got [${configured.join(', ')}]`,
    )
  }
  // Overrides are provider-scoped: a provider key outside the mounted set is
  // refused, never skipped, so a typo lands at boot instead of silently
  // serving the installed catalog.
  const overrides = config.modelOverrides ?? {}
  const unknownOverridden = Object.keys(overrides).filter(id => !configured.includes(id))
  if (unknownOverridden.length > 0) {
    throw new Error(
      `dsh-auth: modelOverrides names provider "${unknownOverridden[0]}", which is not among the mounted providers [${configured.join(', ')}]`,
    )
  }
  // Profile construction validates the installed catalog loudly: a pi-ai
  // downgrade that dropped a provider fails the boot that asked for it, and
  // a per-model miss is refused per route (see buildOAuthProfile).
  const custom = new Map(CUSTOM_PROVIDER_IDS.filter(id => configured.includes(id))
    .map(id => [id, createCustomProfile(id, overrides[id])] as const))
  const profiles = new Map(configured.map(id => [id,
    custom.get(id as CustomProviderId)?.profile ?? buildOAuthProfile(id, overrides[id]),
  ] as const))
  const store = new CredentialFile(config.credentialsFile ?? defaultCredentialsFile())

  const credentialKey = async (provider: string): Promise<string | undefined> => {
    const current = await store.read(provider)
    if (current?.type === 'api_key') return current.key
    if (provider !== 'nous' || current?.type !== 'oauth') return undefined
    if (current.expires > Date.now() + 60_000) return current.access
    const refreshed = await store.modify('nous', async latest => {
      if (latest?.type !== 'oauth') return undefined
      if (latest.expires > Date.now() + 60_000) return latest
      return refreshNous(latest, config.nous?.clientId ?? 'hermes-cli')
    })
    if (refreshed?.type !== 'oauth') throw new Error('dsh-auth: Nous credential is missing; run /auth login nous')
    return refreshed.access
  }

  // Fail closed on store trouble: a credential file that cannot be read
  // must not surface forty models that would all fail at request time.
  const hasCredential = async (provider: string): Promise<boolean> => {
    try {
      return await store.read(provider) !== undefined
    } catch {
      return false
    }
  }

  const adapter = new CredentialGatedAdapter({
    // One immutable map for the plugin's lifetime: the snapshot memoizes on
    // identity, and route changes here always mean a plugin remount anyway.
    profiles: () => profiles,
    // Explicit API keys cover catalog routes too. OAuth catalog routes still
    // resolve their grants through pi-ai's injected credential store.
    resolveApiKey: credentialKey,
    auth: {
      credentials: store,
      authContext: hostAuthContext(),
    },
    resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`dsh-auth: replay state on assistant history for ${provider}/${model} degraded: ${reason}`)
    },
  }, hasCredential)

  // The service is a thin holder so UIs can find the api without importing
  // the plugin module; the defensive get-then-create matches how the TUI
  // mounts userQuestions.
  const service = (ctx.get('dshAuth') as DshAuthService | undefined) ?? new DshAuthService(ctx)
  const api = createDshAuthApi({
    profiles,
    store,
    resolveAsk: () => {
      const questions = ctx.get('userQuestions')
      return questions === undefined ? undefined : request => questions.ask(request)
    },
    logger: ctx.logger,
    nousClientId: config.nous?.clientId,
    credentialChanged: async (provider, credential) => {
      const entry = custom.get(provider as CustomProviderId)
      if (entry === undefined) return
      if (credential === undefined) { entry.clear(); return }
      entry.clear()
      const key = credential.type === 'api_key' ? credential.key
        : credential.type === 'oauth' ? credential.access : undefined
      if (key === undefined) throw new Error(`dsh-auth: ${provider} credential cannot be used for model discovery`)
      await entry.refresh(key)
    },
  })
  service.api = api

  for (const [provider, entry] of custom) {
    void credentialKey(provider).then(key => key === undefined ? undefined : entry.refresh(key))
      .then(count => { if (count !== undefined) api.notifyModelsChanged?.(provider) })
      .catch(error => ctx.logger.warn(`dsh-auth: ${provider} model discovery unavailable: ${error instanceof Error ? error.message : 'request failed'}`))
  }

  ctx.effect(function* () {
    const releases: (() => void)[] = []
    // Runtime service resolution (never a code-level inject — see `inject`):
    // absent services keep this plugin inert and logged, not the whole boot
    // tree deadlocked.
    const llm = ctx.get('llm') as LlmRegistryLike | undefined
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (llm === undefined) {
      ctx.logger.warn('dsh-auth: no llm service mounted — provider routes stay unregistered')
    } else {
      // Individual registrations: one conflicting route must not strand the
      // rest (the registry keeps the previous owner serving).
      for (const id of configured) {
        try {
          releases.push(llm.registerAdapter([id], adapter))
        } catch (error: unknown) {
          ctx.logger.error(
            `dsh-auth: route "${id}" was not registered: ${error instanceof Error ? error.message : String(error)} `
            + '(another adapter family may own it — check the llm-pi-ai settings section)',
          )
        }
      }
    }
    const active = new Set<Promise<unknown>>()
    if (commands === undefined) {
      ctx.logger.warn('dsh-auth: no commands service mounted — the /auth command stays unregistered')
    } else {
      const handler = createAuthCommandHandler(api)
      releases.push(commands.register({
        name: 'auth',
        description: 'Provider authentication: status, login, logout',
        handler: invocation => {
          const operation = handler(invocation)
          active.add(operation)
          void operation.then(() => active.delete(operation), () => active.delete(operation))
          return operation
        },
      }))
    }
    // Drain before releasing: LIFO composite teardown lets no new invocation
    // enter while already-started logins finish their final write.
    yield async () => { await Promise.allSettled([...active]) }
    yield () => {
      for (const release of releases) release()
    }
  }, 'dsh-auth lifecycle')
}
