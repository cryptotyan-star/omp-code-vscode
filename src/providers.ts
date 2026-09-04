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
  /**
   * Env var the omp CLI reads for this provider's credential.
   *
   * Omitted for providers omp has no env var for: their key is written into
   * `models.yml` instead (see CONFIG_PROVIDERS), so there is nothing to inject
   * into the process and nothing honest to name in the UI.
   */
  envVar?: string;
  /** Human label for UI. */
  label: string;
  /** Setup-form input placeholder. */
  placeholder: string;
  /** contributed palette command that prompts for the key. */
  commandId: string;
}

/**
 * Providers omp has no built-in id for, shipped as a `models.yml` block.
 *
 * omp resolves a credential from an env var only for providers it knows; a
 * provider defined in `models.yml` must carry its `apiKey` in the file itself
 * (validation: `"apiKey" is required when defining custom models unless auth is
 * "none"`, and the file is not env-interpolated). So the key lives in Secret
 * Storage and is written into the block at spawn — the same path
 * `ompcode.customProviders` entries already take.
 *
 * The block is written only while a key is stored, and removed when it is
 * cleared: a keyless block fails validation, and omp answers that by disabling
 * *every* custom provider in the file, the user's own included.
 *
 * Model rows carry ids and names only. omp fills context window, max tokens,
 * thinking levels and per-token cost from its own catalog, so prices are
 * whatever omp ships rather than a number this extension invents.
 */
export interface ConfigProvider {
  /** models.yml provider name — also the omp provider id in `provider/model`. */
  name: string;
  /** Secret Storage key holding the credential for it. */
  secret: string;
  /** The block merged into `~/.omp/agent/models.yml`, minus the apiKey. */
  def: Record<string, unknown>;
}

/** Endpoint of the BigModel open platform (pay-as-you-go, not the Coding Plan). */
export const BIGMODEL_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

export const CONFIG_PROVIDERS: readonly ConfigProvider[] = [
  {
    name: "bigmodel",
    secret: "ompcode.providerKey.bigmodel",
    def: {
      baseUrl: BIGMODEL_BASE_URL,
      api: "openai-completions",
      // The ids the platform's own /models endpoint serves. Discovery
      // (`discovery: openai-models-list`) would keep this list current by
      // itself, but it resolves every model against a free-tier catalog entry
      // and zeroes the prices — the one thing this provider exists to show.
      models: [
        { id: "glm-5.3", name: "GLM-5.3 (BigModel)" },
        { id: "glm-5.3-flash", name: "GLM-5.3-Flash (BigModel)" },
        { id: "glm-5.2", name: "GLM-5.2 (BigModel)" },
        { id: "glm-5.1", name: "GLM-5.1 (BigModel)" },
        { id: "glm-5-turbo", name: "GLM-5-Turbo (BigModel)" },
        { id: "glm-5", name: "GLM-5 (BigModel)" },
        { id: "glm-4.7", name: "GLM-4.7 (BigModel)" },
        { id: "glm-4.6", name: "GLM-4.6 (BigModel)" },
        { id: "glm-4.5-air", name: "GLM-4.5-Air (BigModel)" },
        { id: "glm-4.5", name: "GLM-4.5 (BigModel)" },
      ],
    },
  },
];

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
    // No env var: omp has no built-in id for BigModel's pay-as-you-go endpoint,
    // so this key reaches the agent through models.yml. The secret name is the
    // one `injectProviderKeys` looks up for a models.yml provider.
    id: "bigmodel",
    provider: "bigmodel",
    secret: "ompcode.providerKey.bigmodel",
    label: "GLM BigModel (pay-as-you-go)",
    placeholder: "xxxxxxxx.xxxxxxxx",
    commandId: "ompcode.setBigModelKey",
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
