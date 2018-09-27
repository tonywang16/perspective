const path = require("path");

const OUTPUT = {
  path: path.resolve(__dirname, "umd")
}

const BASE = {
  context: __dirname,
  devtool: "source-map",
  module: {
    rules: [
      {
        test: /\.js$/,
        include: [
          path.join(__dirname, "src"),
          path.join(__dirname, "node_modules", "@jpmorganchase", "perspective-runtime"),
        ],
        loader: "babel-loader"
      }
    ]
  }
};

const createConfig = (entry, output) => Object.assign({}, BASE, {
  entry,
  output: Object.assign({}, OUTPUT, output)
});

module.exports = [
  // Create the ASMJS WORKER
  createConfig("./src/workers/perspective.asmjs.js", {
    filename: "perspective.worker.asmjs.js"
  }),
  // Create the WASM WORKER
  createConfig("./src/workers/perspective.wasm.js", {
    filename: "perspective.worker.async.js"
  }),
  // Create the Parallel Entrypoint
  createConfig("./src/perspective.parallel.js", {
    filename: "perspective.js",
    library: "perspective",
    libraryExport: "default",
    libraryTarget: "umd",
  })
]