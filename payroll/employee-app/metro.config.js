const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The SDK + snarkjs ship ESM. Metro needs to resolve & transform them.
config.resolver.sourceExts = [...config.resolver.sourceExts, "cjs", "mjs"];

module.exports = config;
