# @askdkc/dsh-auth

[English](README.md) | 日本語

> [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) と
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 向けのプロバイダー認証

**ChatGPT、Claude、SuperGrok、OpenCode Zen/Go、OrcaRouter、OpenRouter、
Nous Portal、Infron** をモデルの提供元として利用できます。プロバイダーに応じて
OAuth、デバイスコード、API キーで認証します。dsh 本体のソース修正は不要です。
このプラグインは DeepSeek Harness のターミナル UI である
[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) とともに開発され、dsh-TUI に同梱されています。
任意の dsh プロファイルへ単独でインストールすることもできます。

```
dsh-tui → /provider → Provider authentication → sign in
          /auth login openai-codex                     ← the plugin command
          /model → OpenAI Codex → gpt-5.6-sol          ← routes & models
```

**現状は実験段階です。** カタログの OAuth フローには
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) に同梱された実装を使います。
デバイスコード認証とループバック・コールバックを使う認証も含まれます。
このプラグインが担うのは、認証情報の保存、トークンの自動更新、
アダプターの登録、`userQuestions` を通したログイン画面です。
TUI と Web クライアントで使えます。対話画面のないホストでは明示的に拒否します。

## インストール

**dsh-TUI と一緒に使う場合** — 追加作業は不要です。dsh-auth は dsh-tui パッケージに
依存関係として同梱されています。dsh-tui を更新すると、`/provider` のウィザードに
プロバイダー認証の項目が追加されます。

**任意の dsh プロファイルへ単独でインストールする場合：**

```sh
dsh plugin --profile <name> add @askdkc/dsh-auth
```

インストール後にホストを再起動してください。`/` に `auth` コマンドが表示され、
各モデル選択画面にはログイン済みプロバイダーのカタログが追加されます。
モデルの表示は認証情報の有無で制御されます（後述）。

## 主な機能

- pi-ai のカタログにあるプロバイダーを `llm` レジストリのルートとして登録します：
  `openai-codex`、`anthropic`、`xai`、`opencode`、`opencode-go`、`openrouter`。
  **モデル選択画面に表示されるのは、そのプロバイダーにログインした後だけです。**
  ログインするとカタログが現れ、ログアウトすると消えます。
  セッションに保存済みのモデル ID は、どちらの状態でも解決できます。
- Provider オブジェクトは、インストール済みの `dsh-llm-pi-ai` が使う
  **同じ pi-ai 依存関係**から読み込みます。これにより、rc 版や alpha 版のホストでも
  対応する pi-ai のバージョンを使え、別々のパッケージインスタンス間で
  Provider オブジェクトを受け渡さずに済みます。
- `/auth login [provider]` で選んだ認証方法を対話的に実行します。
  認証 URL は**ブラウザーで自動的に開きます**。URL は数百文字と長く、
  手でコピーすると折り返しによって `redirect_uri` が壊れるためです。
  待機画面には *Copy authorization link*、*Open browser again*、
  *Cancel sign-in* も表示されます。デバイスコード認証では検証ページを開き、
  短いコードをコピー対象にします。OpenAI Codex ではデバイスコード認証も選べます。
  localhost:1455 のコールバックを必要としないため、ヘッドレス環境や
  制限のある環境ではこの方法が最も確実です。
- OpenCode Zen/Go は API キーに対応します。OpenRouter では pi-ai の OAuth PKCE
  フローか API キーの手入力を選べます。`orcarouter`、`nous`、`infron` は
  Chat Completions を使います。各プロバイダーの `/models` 一覧に
  コンテキスト容量と価格のメタデータがなければ、モデルは選択できません。
  `nous` はデバイスコード OAuth に加え、明示的に選択する手入力の Bearer トークン
  互換経路にも対応します。後者は実際の Nous アカウントでは未検証です。
- 保存済みのアクセストークンは、リクエスト前に自動更新されます。
  更新は認証情報ストアのロックでプロバイダーごとに直列化されるため、
  並行するリクエストが更新済みトークンを重複して更新することはありません。
- `/auth status` と `/auth logout <provider>` を使えます。`ctx.dshAuth` サービスも
  UI 向けに同じ API を公開しており、dsh-tui の `/provider` ウィザードと
  `/login` はこのサービスを利用します。

## 使い方

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

`/auth login` には設定済みの全プロバイダーが表示され、ログイン済み・未ログイン・
トークン期限切れの状態も分かります。ログイン済みのプロバイダーを選ぶと
再ログインでき、成功時にその認証情報を置き換えます。キャンセルや認証失敗では
元の認証情報が残ります。`/auth login <provider>` は指定したプロバイダーへ
直接進みます。

未ログインのプロバイダーにモデルを要求すると、`/auth login <provider>` の案内を添えて
明示的に失敗します。

## 設定

```yaml
- id: dsh-auth
  name: '@askdkc/dsh-auth'
  config:
    providers: [openai-codex, anthropic, xai, opencode, opencode-go, orcarouter, openrouter, nous, infron]
    nous:
      clientId: hermes-cli
    # credentialsFile: /secure/path/credentials.json
```

- `credentialsFile` の既定値は `$DSH_HOME/dsh-auth/credentials.json`
  （`~/.dsh/dsh-auth/credentials.json`）です。`DSH_AUTH_CREDENTIALS` 環境変数で
  変更できます。ディレクトリは `0700`、ファイルは `0600` で作成します
  （Windows では可能な範囲で適用）。書き込みは毎回、一時ファイルを作ってから
  rename で置き換えるため、更新はアトミックです。
- `opencode-zen`、`hermes`、`infron.ai` は、それぞれ `opencode`、
  `nous`、`infron` の別名です。認証情報は正規の ID で保存します。
- Nous のクライアント ID の既定値は `hermes-cli` です。Nous が第三者による
  この ID の再利用を認めるとは限りません。独自の ID がある環境では
  `nous.clientId` を設定してください。
- 同じプロバイダーを別のアダプター群がすでに使っている場合
  （`llm-pi-ai` の設定プロファイルなど）、レジストリはそのルートの登録を拒否します。
  プラグインは拒否をログに記録し、残りのルートを登録します。
  1 つのプロバイダーには 1 つのアダプターを割り当ててください。

## セキュリティ上の注意

- 認証情報ファイルには**API キーと長期有効の更新トークン**が保存されます。
  内容をログやステータス画面に出すことはありません
  （`/auth status` に表示するのは有効期限の情報だけです）。
  ファイルが壊れている場合は、上書きせず明示的に失敗します。
- dsh-TUI は API キーの入力をマスクし、質問への回答の要約からも伏せます。
- 対話画面が登録されていない環境ではログインを拒否します。
  ブラウザーや GUI があるとは仮定しません。リモート環境やヘッドレス環境では
  明確なエラーを返します（エコシステム仕様のリモート決定性規則 TUI-RUN-001）。
- サブスクリプション認証と API キーによるアクセスは別の製品です。
  ChatGPT Codex と Claude Pro/Max は各サブスクリプションのバックエンドを使い、
  新しい API キーのルートは各サービスの API バックエンドを使います。

## 開発

```sh
pnpm install
pnpm verify     # build + headless smoke (credential store, refresh
                # serialization, prompt bridging, gating, service api)
```

smoke テストは cordis や Harness を起動せずに、純粋なモジュールを直接検査します。
実際のログインを通す E2E 確認には対話可能なホスト（dsh-tui）が必要で、
リリースごとに手動で検証します。このプラグインは
[dsh-TUI リポジトリ](https://github.com/ccch1mneyyy/dsh-TUI) の
`dsh-auth/` サブモジュールとして開発され、このリポジトリにも反映されます。

## ロードマップ

- **M2** *（実装済み）* — dsh-tui との連携：`/provider` の OAuth 項目、
  `/login` のアカウント欄、最近使ったモデルを固定表示するグループを備えた
  2 階層の `/model` 選択画面。
- **M3** — `dsh-ecosystem-spec` への準拠（マニフェストの検証、
  受け入れテスト用の fixture）、残る pi-ai の OAuth プロバイダー
  （GitHub Copilot、Kimi）への対応、コミュニティ一覧への登録。
- **M4** — Gemini：独自の Google デバイスコード認証フロー。
  pi-ai には実装がないため、この部分だけ独自に実装する予定です。

## ライセンス

MIT
