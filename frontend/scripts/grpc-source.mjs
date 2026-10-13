// Yellowstone (Dragon's Mouth) gRPC feed for the fast indexer: confirmed
// program txs arrive with their full message and meta, and the tree
// accounts arrive whenever their root ring changes — the indexer applies
// leaves straight from the stream, no getSignatures/getTransaction round
// trips. The RPC poll in FastIndexer stays as backfill and safety net.
//
// Remote: any Yellowstone endpoint (Helius LaserStream, Triton) + x-token.
// Local: surfpool 1.6 loads the plugin (run.sh GEYSER_CONFIG) but emits no
// tx/slot/account notifications to it, so locally the ws + RPC path does the
// work. Plain @grpc/grpc-js over the plugin's own v15.1.0 protos (vendored in
// ./yellowstone-proto): the npm client builds were proto-incompatible with it.
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"
import { PublicKey } from "@solana/web3.js"
import bs58 from "bs58"

const PROTO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "yellowstone-proto")

/** Proto tx update -> the web3.js-like shape transactsOf() reads. */
export function toTxLike(info) {
  const msg = info.transaction?.message
  const meta = info.meta
  return {
    meta: {
      err: meta?.err ?? null,
      loadedAddresses: {
        writable: (meta?.loadedWritableAddresses ?? []).map((k) => new PublicKey(k)),
        readonly: (meta?.loadedReadonlyAddresses ?? []).map((k) => new PublicKey(k)),
      },
    },
    transaction: {
      message: {
        staticAccountKeys: (msg?.accountKeys ?? []).map((k) => new PublicKey(k)),
        compiledInstructions: (msg?.instructions ?? []).map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: Array.from(ix.accounts ?? []),
          data: Buffer.from(ix.data ?? []),
        })),
      },
    },
  }
}

/**
 * Stream into `indexer` until the process exits; reconnects with backoff.
 * `treeKeys` are the pools whose accounts to follow ("sol" + SPL mints).
 */
export async function startGrpcSource({ url, xToken, indexer, treeKeys = ["sol"], commitment = "confirmed", log = console.log }) {
  const pdaToTree = new Map(treeKeys.map((k) => [indexer.treePda(k).toBase58(), k]))
  const request = {
    accounts: { trees: { account: [...pdaToTree.keys()] } },
    transactions: { payroll: { vote: false, failed: true, accountInclude: [indexer.program.toBase58()] } },
    // surfpool emits no confirmed-slot statuses, so Yellowstone would hold
    // confirmed updates forever there; a single-node simnet is final at
    // processed anyway. Real clusters: confirmed.
    commitment: commitment === "processed" ? "PROCESSED" : "CONFIRMED",
  }

  const def = protoLoader.loadSync(path.join(PROTO_DIR, "geyser.proto"), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  })
  const Geyser = grpc.loadPackageDefinition(def).geyser.Geyser
  const target = url.replace(/^https?:\/\//, "")
  const creds = url.startsWith("https://") ? grpc.credentials.createSsl() : grpc.credentials.createInsecure()

  let backoff = 500
  for (;;) {
    try {
      const client = new Geyser(target, creds)
      const meta = new grpc.Metadata()
      if (xToken) meta.set("x-token", xToken)
      const stream = client.subscribe(meta)
      const ended = new Promise((resolve, reject) => {
        stream.on("error", reject)
        stream.on("end", resolve)
        stream.on("close", resolve)
      })
      stream.on("data", (u) => {
        if (u.transaction?.transaction) {
          const info = u.transaction.transaction
          indexer.stats.grpcTxs = (indexer.stats.grpcTxs ?? 0) + 1
          indexer.ingestStreamTx(bs58.encode(info.signature), Number(u.transaction.slot), toTxLike(info))
        } else if (u.account?.account) {
          const a = u.account.account
          const tree = pdaToTree.get(new PublicKey(a.pubkey).toBase58())
          if (tree) {
            indexer.stats.grpcAccounts = (indexer.stats.grpcAccounts ?? 0) + 1
            indexer.ingestStreamTree(tree, a.data)
          }
        }
      })
      stream.write(request)
      log(`grpc: streaming ${url} at ${commitment} (trees ${treeKeys.join(", ")})`)
      backoff = 500
      // a reconnect can skip updates: one RPC pass backfills the gap
      indexer.sync().catch(() => {})
      await ended
      log("grpc: stream ended, reconnecting")
    } catch (e) {
      log(`grpc: ${e?.message ?? e}; retry in ${backoff}ms`)
    }
    await new Promise((r) => setTimeout(r, backoff))
    backoff = Math.min(backoff * 2, 10_000)
  }
}
