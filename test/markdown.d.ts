declare module "*.mjs" {
  export function esc(s: unknown): string;
  export function renderInline(raw: string): string;
  export function renderBlocks(text: string): string;
  export function renderMarkdown(src: string): string;
}
