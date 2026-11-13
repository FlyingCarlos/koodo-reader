const { build } = require("../package.json");

module.exports = {
  ...build,
  appId: "com.carlosz.koodo-reader-custom",
  productName: "Koodo Reader Custom",
  protocols: [],
  publish: null,
  npmRebuild: false,
  asarUnpack: ["node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
  extraResources: [
    ...build.extraResources,
    {
      from: "dist/translation-runtime/koodo-translation",
      to: "translation-runtime",
    },
  ],
  mac: {
    ...build.mac,
    identity: null,
    hardenedRuntime: false,
    notarize: false,
  },
};
