const esbuild = require("esbuild");
const path = require("path");
const __dirname_here = path.dirname(require.resolve("./package.json"));

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  format: "iife",
  target: ["safari16"],
  logLevel: "info",
  banner: {
    js: "if (typeof chrome === 'undefined' && typeof browser !== 'undefined') { var chrome = browser; }",
  },
};

const entryPoints = [
  {
    in:  "content/content-script.js",
    out: "content/content-script.bundle",
  },
  {
    in:  "content/page-bridge.js",
    out: "content/page-bridge.bundle",
  },
  {
    in:  "background/service-worker.js",
    out: "background/service-worker.bundle",
  },
  {
    in:  "popup/popup.js",
    out: "popup/popup.bundle",
  },
];

async function build() {
  const ctx = await esbuild.context({
    ...shared,
    entryPoints: entryPoints.map(e => ({ ...e, in: path.join(__dirname_here, e.in) })),
    outdir: __dirname_here,
  });

  if (watch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("Build complete → dist/");
  }
}

build().catch(e => {
  console.error(e);
  process.exit(1);
});
