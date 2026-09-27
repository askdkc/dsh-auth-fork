/**
 * The `AuthInteraction` bridge: pi-ai OAuth flows speak prompts and events;
 * every interactive surface in this ecosystem speaks `ctx.userQuestions`.
 *
 * `prompt()` maps one pi-ai prompt onto one question — `select` prompts carry
 * their options, text/secret/manual-code prompts expect the custom-answer
 * input row.
 *
 * `notify()` restores the host contract pi-ai's browser flows assume: the
 * `auth_url` / `device_code` events expect the *host* to open the browser
 * (their authorize URLs run hundreds of characters — wrapped across panel
 * lines they are unclickable, and hand-copying picks up wrap artifacts that
 * corrupt the encoded `redirect_uri`, which the provider then rejects). So
 * the bridge opens the URL itself, then shows one waiting panel carrying
 * copy / reopen / cancel actions until the flow settles. The device-code
 * path gets the same treatment: its short code is the thing to copy, and
 * the verification page is auto-opened too.
 *
 * One `AbortController` owns the whole run: pi-ai reads `interaction.signal`
 * to abort the flow, every ask request carries it so surfaces close their
 * panels, and the waiting panel's cancel action fires it.
 *
 * Nothing here assumes a browser or GUI *exists* (TUI-RUN-001): when no
 * opener or clipboard helper is available the panel degrades to showing the
 * URL / code verbatim with a clear note, and where no question provider is
 * registered at all, `ask` rejects and the login command turns that into a
 * clear refusal.
 *
 * @module dsh-auth/interaction
 */

import type { AskUserQuestionItem, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { copyToClipboard, openInBrowser } from './opener.js'
import type { PiAiAuthEvent, PiAiAuthInteraction, PiAiAuthPrompt } from './pi-ai.js'

/** The ask surface this bridge drives (usually `ctx.userQuestions.ask`). */
export type AskFn = (request: {
  questions: AskUserQuestionItem[]
  signal?: AbortSignal
}) => Promise<AskUserQuestionAnswer>

/** Injectable host conveniences (tests substitute recorders). */
export interface QuestionBridgeHelpers {
  openUrl?: (url: string) => boolean
  copyText?: (text: string) => Promise<boolean>
}

/** Human-readable copy for one notify event. */
export function describeEvent(event: PiAiAuthEvent): string {
  switch (event.type) {
    case 'auth_url':
      return `Open this URL to authorize (a local callback completes sign-in):\n${event.url}`
    case 'device_code':
      return `Visit ${event.verificationUri} and enter this code:\n  ${event.userCode}`
    case 'info':
    case 'progress':
      return event.message
  }
}

const CANCEL = 'Cancel sign-in'
const OPEN_AGAIN = 'Open browser again'
const COPY_LINK = 'Copy authorization link'
const COPY_CODE = 'Copy code'

/** One answer row, or a thrown error when the surface returned nothing usable. */
function singleAnswer(answer: AskUserQuestionAnswer): { selected: string | undefined; custom: string | undefined } {
  const row = answer.answers[0]
  if (row === undefined) throw new Error('dsh-auth: the question surface returned no answer')
  return { selected: row.selected[0], custom: row.custom }
}

/** The waiting panel one event kind renders: body plus copy/reopen targets. */
interface WaitingView {
  /** Base body, shown below the standing question line. */
  body: string
  /** What a copy action copies; also its action label. */
  copyLabel: string
  copyText: string
  /** What a reopen action opens, when this view offers one. */
  reopenUrl: string | undefined
}

function authUrlView(url: string, instructions: string | undefined, opened: boolean): WaitingView {
  const lead = opened
    ? 'Authorization page opened in your browser — complete the sign-in there.\n'
      + 'If it did not open, copy the link below and open it by hand.'
    : `Open this URL to authorize${instructions === undefined ? '' : ` — ${instructions}`}\n`
      + 'Copy the link below (it is too long to select reliably once wrapped):'
  return { body: `${lead}\n${url}`, copyLabel: COPY_LINK, copyText: url, reopenUrl: url }
}

function deviceCodeView(userCode: string, verificationUri: string, opened: boolean): WaitingView {
  const lead = opened
    ? `Enter this code on the page opened in your browser (${verificationUri}):`
    : `Visit ${verificationUri} and enter this code:`
  return { body: `${lead}\n  ${userCode}`, copyLabel: COPY_CODE, copyText: userCode, reopenUrl: verificationUri }
}

/**
 * The bridge for one login run. At most one waiting panel exists at a time;
 * `settle()` retires it when the flow ends (any outcome), so a completed or
 * failed login never leaves an interactive dead end on screen.
 */
export class QuestionBridge implements PiAiAuthInteraction {
  readonly signal: AbortSignal
  private readonly openUrl: (url: string) => boolean
  private readonly copy: (text: string) => Promise<boolean>
  private waiting: { controller: AbortController; answer: Promise<string | undefined> } | undefined
  private waitingClosed = false

  constructor(
    private readonly ask: AskFn,
    private readonly runAbort: AbortController,
    helpers: QuestionBridgeHelpers = {},
  ) {
    this.signal = runAbort.signal
    this.openUrl = helpers.openUrl ?? openInBrowser
    this.copy = helpers.copyText ?? copyToClipboard
  }

  async prompt(prompt: PiAiAuthPrompt): Promise<string> {
    const question: AskUserQuestionItem = prompt.type === 'select'
      ? {
        id: 'dsh-auth-prompt',
        header: 'dsh-auth',
        question: prompt.message,
        options: prompt.options.map(option => ({
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      }
      : {
        id: prompt.type === 'secret' ? 'dsh-auth-secret' : 'dsh-auth-prompt',
        header: 'dsh-auth',
        question: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { detail: prompt.placeholder }),
      }
    const answer = singleAnswer(await this.ask({
      questions: [question],
      signal: prompt.signal === undefined ? this.signal : AbortSignal.any([prompt.signal, this.signal]),
    }))
    if (prompt.type === 'select') {
      const label = answer.selected
      const option = label === undefined ? undefined : prompt.options.find(candidate => candidate.label === label)
      if (option === undefined) {
        if (answer.custom !== undefined && answer.custom !== '') return answer.custom
        throw new Error('dsh-auth: the selection answer did not match an offered option')
      }
      return option.id
    }
    const custom = answer.custom?.trim()
    if (custom === undefined || custom === '') throw new Error('dsh-auth: the text answer was empty')
    return custom
  }

  notify(event: PiAiAuthEvent): void {
    if (event.type === 'auth_url') {
      if (this.waiting !== undefined) return
      const opened = this.openUrl(event.url)
      void this.runWaitingPanel(authUrlView(event.url, event.instructions, opened))
      return
    }
    if (event.type === 'device_code') {
      if (this.waiting !== undefined) return
      const opened = this.openUrl(event.verificationUri)
      void this.runWaitingPanel(deviceCodeView(event.userCode, event.verificationUri, opened))
    }
    // info / progress lines are transient; the waiting panel already tells
    // the user what to do, and the flow's next prompt carries its own copy.
  }

  /** Close the waiting panel (if any) and stop answering for this run. */
  async settle(): Promise<void> {
    this.waitingClosed = true
    this.waiting?.controller.abort()
    await this.waiting?.answer
    this.waiting = undefined
  }

  /**
   * Show the waiting panel until the flow settles or the user cancels,
   * re-asking after a copy/reopen action with a one-line status prefix.
   */
  private async runWaitingPanel(view: WaitingView): Promise<void> {
    let body = view.body
    while (!this.waitingClosed) {
      const controller = new AbortController()
      const answer = this.ask({
        questions: [{
          id: 'dsh-auth-waiting',
          header: 'dsh-auth',
          question: 'Waiting for authorization…',
          detail: body,
          options: [
            { label: view.copyLabel },
            ...(view.reopenUrl === undefined ? [] : [{ label: OPEN_AGAIN }]),
            { label: CANCEL },
          ],
        }],
        signal: controller.signal,
      })
        .then(response => singleAnswer(response).selected)
        .catch(() => undefined)
      this.waiting = { controller, answer }
      const picked = await answer
      this.waiting = undefined
      if (picked === undefined || this.waitingClosed) return
      if (picked === CANCEL) {
        this.runAbort.abort('user cancelled sign-in')
        return
      }
      if (picked === view.copyLabel) {
        const copied = await this.copy(view.copyText)
        body = `${copied ? 'Copied — paste it where you need it.' : 'Copy failed — no clipboard helper answered; select the text manually.'}\n${view.body}`
        continue
      }
      if (picked === OPEN_AGAIN && view.reopenUrl !== undefined) {
        this.openUrl(view.reopenUrl)
        body = `Reopened in your browser.\n${view.body}`
      }
    }
  }
}
