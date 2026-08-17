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
];
