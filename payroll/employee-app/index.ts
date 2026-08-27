// Entry point. Polyfills MUST run before any Solana/SDK import.
import "./polyfill";

import { registerRootComponent } from "expo";
import App from "./src/App";

registerRootComponent(App);
