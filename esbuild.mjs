import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  // Pinned, not left to the default: the vendored files carry their MIT
  // attribution in `/*! … */` banners, and a later `minify: true` would drop
  // them silently under the default policy.
  legalComments: "eof",
  logLevel: "info",
};

try {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching src/extension.ts → dist/extension.js ...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] built dist/extension.js");
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
