import { requireOptionalNativeModule } from "expo-modules-core";

interface CharonProverNative {
  warmup(): Promise<void>;
  prove(inputJson: string): Promise<string>;
}

/** Native arkworks prover, or null when the app was built without it. */
export const CharonProver = requireOptionalNativeModule<CharonProverNative>("CharonProver");
