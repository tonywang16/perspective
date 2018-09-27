const path = require("path");
const nodeExternals = require('webpack-node-externals');

module.exports = {
  context: __dirname,
  devtool: "source-map",
  entry: "./src/perspective.node.js",
  externals: [nodeExternals({
    whitelist: [
      /.*jpmorganchase.*/
    ]
  })],
  output: {
    filename: "perspective.js",
    library: "perspective",
    libraryExport: "default",
    libraryTarget: "umd"
  },
  target: "node",
  module: {
    rules: [
      {
        test: /\.js$/,
        include: [
          path.join(__dirname, "src"),
          path.join(__dirname, "node_modules", "@jpmorganchase", "perspective-runtime"),
        ],
        loader: "babel-loader"
      },
      {
        test: /\.wasm$/,
        type: 'javascript/auto',
        loader: 'arraybuffer-loader',
      },
    ]
  }
};