const path = require("node:path");
const { rspack } = require("@rspack/core");
const { withZephyr } = require("zephyr-rspack-plugin");
const { getNormalizedRemoteName } = require("every-plugin/normalize");

const pkg = require("./package.json");
const { EveryPluginDevServer } = require("every-plugin/build/rspack");
const normalizedName = getNormalizedRemoteName(pkg.name);

module.exports = withZephyr({
  hooks: {
    onDeployComplete: (info) => {
      console.log("🚀 Deployment Complete!");
      console.log(`   URL: ${info.url}`);
    },
  },
})({
  entry: "./src/index",
  mode: process.env.NODE_ENV === "development" ? "development" : "production",
  target: "async-node",
  devtool: "source-map",
  output: {
    uniqueName: normalizedName,
    publicPath: "auto",
    path: path.resolve(__dirname, "dist"),
    clean: true,
    library: { type: "commonjs-module" },
  },
  devServer: {
    static: path.join(__dirname, "dist"),
    hot: true,
    port: 3014,
    devMiddleware: {
      writeToDisk: true,
    },
    setupMiddlewares: (middlewares, devServer) => {
      if (devServer?.app) {
        const blockManifest = (_req, res) => res.sendStatus(404);
        devServer.app.get("/remoteEntry.js/mf-manifest.json", blockManifest);
        devServer.app.head("/remoteEntry.js/mf-manifest.json", blockManifest);
      }
      return middlewares;
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "builtin:swc-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
  },
  plugins: [new EveryPluginDevServer({ exposes: { "./plugin": "./src/index.ts" } })],
});
