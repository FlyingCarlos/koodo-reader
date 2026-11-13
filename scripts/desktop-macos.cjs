const { build } = require("../package.json");

module.exports = {
  ...build,
  appId: "com.carlosz.koodo-reader-custom",
  productName: "Koodo Reader Custom",
  protocols: [],
  publish: null,
  npmRebuild: false,
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
