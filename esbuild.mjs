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
