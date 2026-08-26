/**
 * Providers whose API key this extension manages end-to-end: stored in VS Code
 * Secret Storage, injected into the agent process as an env var, and editable
 * from the webview's setup card and the palette.
 *
 * Adding a provider = one row here plus one `contributes.commands` entry in
 * package.json. Env injection, keyStatus, the setup form, the ⚙ menu, the
 * dead-key (401) warning and the clear-key picker all render from this table.
 */
export interface KeyedProvider {
  /** Extension-facing id — webview `which`/`keys` field and command suffix. */
  id: string;
  /** omp CLI provider id — probe verdicts are keyed `${provider}/${model}`. */
  provider: string;
  /** Secret Storage key. */
  secret: string;
  /** Env var the omp CLI reads for this provider's credential. */
  envVar: string;
  /** Human label for UI. */
  label: string;
  /** Setup-form input placeholder. */
  placeholder: string;
  /** contributed palette command that prompts for the key. */
  commandId: string;
}

export const KEYED_PROVIDERS: readonly KeyedProvider[] = [
  {
    id: "anthropic",
    provider: "anthropic",
    secret: "ompcode.anthropicApiKey",
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    placeholder: "sk-ant-…",
    commandId: "ompcode.setAnthropicKey",
  },
  {
    id: "moonshot",
    provider: "moonshot",
    secret: "ompcode.moonshotApiKey",
    envVar: "MOONSHOT_API_KEY",
    label: "Kimi (Moonshot)",
    placeholder: "sk-…",
    commandId: "ompcode.setKimiKey",
  },
  {
    id: "zhipu",
    provider: "zhipu-coding-plan",
    secret: "ompcode.zhipuApiKey",
    envVar: "ZHIPU_API_KEY",
    label: "GLM (Zhipu BigModel)",
    placeholder: "…",
    commandId: "ompcode.setGlmKey",
  },
  {
    id: "openai",
    provider: "openai",
    secret: "ompcode.openaiApiKey",
    envVar: "OPENAI_API_KEY",
    label: "OpenAI (ChatGPT)",
    placeholder: "sk-…",
    commandId: "ompcode.setOpenAiKey",
  },
  {
    id: "alibaba",
    provider: "alibaba-coding-plan",
    secret: "ompcode.alibabaApiKey",
    envVar: "ALIBABA_CODING_PLAN_API_KEY",
    label: "Qwen (Alibaba Coding Plan)",
    placeholder: "sk-…",
    commandId: "ompcode.setQwenKey",
  },
];

/**
 * Providers this extension can start an interactive sign-in for.
 *
 * omp exposes a `login` flow for dozens of providers. These are the ones the UI
 * offers, and the host refuses every other id, so a webview bug cannot walk the
 * agent into an arbitrary provider's credential flow.
 *
 * `remote` marks the flows a phone can finish on its own — a URL and a code it
 * can read. The rest need a browser on the machine running the agent: Z.AI
 * answers on a loopback callback port, and Qwen hands back a token to paste.
 * Offering those to a phone would be offering a dead end.
 */
export interface LoginProvider {
  /** omp login provider id, passed straight to the `login` RPC. */
  id: string;
  /** Human label for the settings row. */
  label: string;
  /** What signing in actually gets you. */
  hint: string;
  /** Whether a paired phone may start this flow. */
  remote: boolean;
}

export const LOGIN_PROVIDERS: readonly LoginProvider[] = [
  {
    id: "anthropic",
    label: "Claude Pro/Max",
    hint: "Sign in with a subscription — no API key needed",
    remote: true,
  },
  {
    id: "kimi-code",
    label: "Kimi Code",
    hint: "Sign in with a Kimi Code subscription",
    remote: true,
  },
  {
    id: "zai-coding-plan",
    label: "GLM Coding Plan",
    hint: "Sign in with Z.AI — the browser opens on this computer",
    remote: false,
  },
  {
    id: "qwen-portal",
    label: "Qwen Portal",
    hint: "Sign in with Qwen — the browser opens on this computer",
    remote: false,
  },
  {
    id: "openai-codex",
    label: "ChatGPT Plus/Pro",
    hint: "Sign in with a Codex subscription — the browser opens on this computer",
    remote: false,
  },
];
