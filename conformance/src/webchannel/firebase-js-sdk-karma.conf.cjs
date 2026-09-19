const { resolve } = require("node:path");

module.exports = function configureFirenookFirebaseSdkGate(config) {
  const sdkDirectory = process.env.FIREBASE_JS_SDK_DIR;
  if (!sdkDirectory) {
    throw new Error("FIREBASE_JS_SDK_DIR is required");
  }
  const integrationDirectory = resolve(sdkDirectory, "integration/firestore");
  const upstreamConfigure = require(
    resolve(integrationDirectory, "karma.conf.js"),
  );
  const upstreamSet = config.set.bind(config);
  config.set = (options) => {
    upstreamSet({
      ...options,
      basePath: integrationDirectory,
      client: {
        ...options.client,
        targetBackend: "emulator",
      },
    });
  };
  upstreamConfigure(config);
};
