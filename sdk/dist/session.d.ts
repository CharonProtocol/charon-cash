import type { Signer } from "./client";
/**
 * Wrap a wallet signer so the two unlock signatures (note keys + receive key)
 * are kept for this browser tab (sessionStorage: gone when the tab closes): a
 * page reload unlocks without prompting again. Every other message (registry,
 * backup-key link) is always signed fresh. Outside a browser it is a no-op.
 */
export declare function rememberUnlockSigner(signer: Signer): Signer;
//# sourceMappingURL=session.d.ts.map