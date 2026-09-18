import { describe, expect, it } from "bun:test"
import { PublicKey, VersionedTransaction } from "@solana/web3.js"
import nacl from "tweetnacl"

import { PrivacyCashClient, type Signer } from "../src/client"
import {
  buildUnlockMessage,
  inferSiwsChainId,
  normalizeSiwsDomain,
  requireStableSiws,
  SIWS_STATEMENT,
  SIWS_VERSION,
  type SiwsUnlockInput,
} from "../src/constants"
import { EncryptionService } from "../src/crypto"

const WALLET = "Dz8MTy797RkN55JhgLCuKQ3sWDs4YHBipEoThADFFf58"

const base: SiwsUnlockInput = {
  domain: "127.0.0.1:5173",
  address: WALLET,
  uri: "http://127.0.0.1:5173",
  chainId: "localnet",
}

function dummySigner(pubkey = new PublicKey(WALLET)): Signer {
  return {
    publicKey: pubkey,
    signMessage: async () => new Uint8Array(64),
    signTransaction: async (tx: VersionedTransaction) => tx,
  }
}

describe("buildUnlockMessage (SIWS)", () => {
  it("matches the Wallet Standard createSignInMessageText layout", () => {
    const msg = buildUnlockMessage(base)
    expect(msg).toBe(
      [
        "127.0.0.1:5173 wants you to sign in with your Solana account:",
        WALLET,
        "",
        SIWS_STATEMENT,
        "",
        "URI: http://127.0.0.1:5173",
        `Version: ${SIWS_VERSION}`,
        "Chain ID: localnet",
      ].join("\n"),
    )
  })

  it("does not include nonce or issuedAt", () => {
    const msg = buildUnlockMessage(base)
    expect(msg).not.toMatch(/Nonce:/)
    expect(msg).not.toMatch(/Issued At:/)
    expect(buildUnlockMessage(base)).toBe(buildUnlockMessage(base))
  })

  it("changes when domain changes (phishing site cannot reuse the payload)", () => {
    const legit = buildUnlockMessage(base)
    const phish = buildUnlockMessage({ ...base, domain: "evil.example" })
    expect(phish).not.toBe(legit)
    expect(phish.startsWith("evil.example wants you to sign in")).toBe(true)
  })

  it("strips a full URL down to host", () => {
    expect(normalizeSiwsDomain("https://app.example/")).toBe("app.example")
  })

  it("rejects an empty address", () => {
    expect(() => buildUnlockMessage({ ...base, address: "  " })).toThrow(/address/)
  })

  it("different domains → different spend keys for the same wallet", () => {
    const kp = nacl.sign.keyPair()
    const address = new PublicKey(kp.publicKey).toBase58()
    const spendKey = (domain: string) => {
      const msg = buildUnlockMessage({ ...base, address, domain })
      const sig = nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)
      const enc = new EncryptionService()
      enc.deriveFromSignature(sig)
      return enc.utxoPrivateKey
    }
    expect(spendKey("127.0.0.1:5173")).not.toBe(spendKey("evil.example"))
    expect(spendKey("127.0.0.1:5173")).toBe(spendKey("127.0.0.1:5173"))
  })
})

describe("inferSiwsChainId", () => {
  it("maps common RPC hosts", () => {
    expect(inferSiwsChainId("http://127.0.0.1:8899")).toBe("localnet")
    expect(inferSiwsChainId("https://api.devnet.solana.com")).toBe("devnet")
    expect(inferSiwsChainId("https://api.mainnet-beta.solana.com")).toBe("mainnet")
  })
})

describe("PrivacyCashClient.unlockMessage", () => {
  it("builds SIWS for the signer address", () => {
    const pk = new PublicKey(WALLET)
    const client = new PrivacyCashClient(dummySigner(pk), undefined, {
      domain: "127.0.0.1:5173",
      uri: "http://127.0.0.1:5173",
      chainId: "localnet",
    })
    expect(client.unlockMessage()).toBe(
      buildUnlockMessage({
        ...base,
        address: pk.toBase58(),
      }),
    )
  })

  it("omits Chain ID unless UnlockOpts.chainId is set (Phantom custom RPC)", () => {
    const pk = new PublicKey(WALLET)
    const client = new PrivacyCashClient(dummySigner(pk), undefined, {
      domain: "127.0.0.1:5173",
      uri: "http://127.0.0.1:5173",
    })
    const msg = client.unlockMessage()
    expect(msg).not.toMatch(/Chain ID:/)
    expect(msg).toBe(
      buildUnlockMessage({
        domain: "127.0.0.1:5173",
        address: pk.toBase58(),
        uri: "http://127.0.0.1:5173",
      }),
    )
  })

  it("rejects a SIWS payload the wallet mutated (nonce/issuedAt)", () => {
    const expected = buildUnlockMessage(base)
    expect(() =>
      requireStableSiws(
        new TextEncoder().encode(expected + "\nNonce: abcdefgh"),
        expected,
      ),
    ).toThrow(/SIWS mismatch/)
    expect(() =>
      requireStableSiws(new TextEncoder().encode(expected), expected),
    ).not.toThrow()
  })

  it("unlock() refuses signMessage-only wallets", async () => {
    const client = new PrivacyCashClient(dummySigner())
    await expect(client.unlock()).rejects.toThrow(/signIn/)
  })
})
