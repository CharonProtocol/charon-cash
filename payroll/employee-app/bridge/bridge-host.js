/*
 * bridge-host.js -- runs INSIDE the hidden WebView. EMPLOYEE edition.
 *
 * Responsibilities:
 *   1. Read config injected by RN (window.__PCASH_CONFIG__).
 *   2. Install a fetch() override so relative "/circuit/*" + API calls reach the
 *      dev machine's LAN backend (the page itself has no real origin).
 *   3. Self-check window.crypto.subtle (Groth16/AES need a secure context).
 *   4. Build a PrivacyCashClient whose signer.signMessage round-trips to the
 *      native wallet (Mobile Wallet Adapter) via postMessage RPC.
 *   5. Employee-specific RPCs: registry check (fetchRecipientKeys), one-time
 *      enrollment (publishRecipientKeys, 3 wallet signatures), relayer fee
 *      schedule (fetchRelayerInfo) and the gasless claim (withdrawSOL relay).
 *   6. Expose window.__pcash.inject({...}) as the RN->bridge command channel and
 *      post results back via ReactNativeWebView.postMessage.
 *
 * Plain browser JS (inlined into bridge.html by build-bridge.mjs). Keep this
 * file 100% ASCII: hermesc drops string literals with non-ASCII chars.
 */
(function () {
  "use strict";

  var post = function (obj) {
    var RN = window.ReactNativeWebView;
    if (RN && typeof RN.postMessage === "function") {
      RN.postMessage(JSON.stringify(obj));
    } else {
      // dev: surface in console + a visible banner if no native hook
      console.log("[bridge:no-native]", JSON.stringify(obj).slice(0, 200));
    }
  };

  // ---- base64 <-> Uint8Array (messages/signatures are small) ----
  function bytesToB64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function cfg() {
    return window.__PCASH_CONFIG__ || {};
  }

  // ---- fetch override: route /circuit/* to the circuit host ----
  var nativeFetch = window.fetch.bind(window);
  function rewriteUrl(url) {
    if (typeof url !== "string") return url;
    var c = cfg();
    // circuit assets are referenced relatively ("/circuit/transaction2.wasm")
    if (url.indexOf("/circuit/") === 0 || /\/circuit\/transaction2\.(wasm|zkey)/.test(url)) {
      return (c.circuitBase || "").replace(/\/$/, "") + url;
    }
    return url;
  }
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string") input = rewriteUrl(input);
      else if (input && input.url) input = new Request(rewriteUrl(input.url), input);
    } catch (e) {}
    return nativeFetch(input, init);
  };

  // ---- bridged signer: signMessage round-trips to the native wallet ----
  var pendingSigns = {}; // signId -> {resolve, reject}
  var signCounter = 0;

  function bridgedSignMessage(message) {
    // message: Uint8Array (the SDK passes the SIGN_MESSAGE bytes)
    return new Promise(function (resolve, reject) {
      var signId = ++signCounter;
      pendingSigns[signId] = { resolve: resolve, reject: reject };
      post({ type: "signRequest", signId: signId, messageB64: bytesToB64(message) });
      // safety timeout: wallets can hang if backgrounded
      setTimeout(function () {
        if (pendingSigns[signId]) {
          pendingSigns[signId].reject(new Error("signMessage timed out (120s)"));
          delete pendingSigns[signId];
        }
      }, 120000);
    });
  }

  // signTransaction is kept for API compatibility (the SDK signer type wants
  // it). Employee flows are all relayed/gasless, so it should never fire; if it
  // does, we round-trip it to the native wallet exactly like the main app.
  function bridgedSignTransaction(tx) {
    var VT = window.PrivacyCashSDK && window.PrivacyCashSDK.VersionedTransaction;
    var unsignedB64 = bytesToB64(tx.serialize());
    return new Promise(function (resolve, reject) {
      var signId = ++signCounter;
      pendingSigns[signId] = { resolve: resolve, reject: reject };
      post({ type: "signTxRequest", signId: signId, txB64: unsignedB64 });
      setTimeout(function () {
        if (pendingSigns[signId]) {
          pendingSigns[signId].reject(new Error("signTransaction timed out (120s)"));
          delete pendingSigns[signId];
        }
      }, 120000);
    }).then(function (signedB64) {
      if (!VT) throw new Error("SDK bundle missing VersionedTransaction");
      return VT.deserialize(b64ToBytes(signedB64));
    });
  }

  // ---- SDK client (lazy) ----
  var client = null;
  var bridgeSigner = null; // {publicKey, signMessage, signTransaction}
  var SDK = window.PrivacyCashSDK;
  var PublicKey = SDK && SDK.PublicKey;

  function ensureClient() {
    if (client) return client;
    if (!SDK) throw new Error("SDK bundle missing (window.PrivacyCashSDK)");
    if (!PublicKey) throw new Error("SDK did not export PublicKey");
    var c = cfg();
    if (c.backendUrl && SDK.setBackendUrl) SDK.setBackendUrl(c.backendUrl);
    bridgeSigner = {
      publicKey: new PublicKey(c.walletPubkey),
      signMessage: bridgedSignMessage,
      signTransaction: bridgedSignTransaction,
    };
    client = new SDK.PrivacyCashClient(bridgeSigner);
    return client;
  }

  // ---- RPC dispatch ----
  function safeJson(v) {
    try {
      JSON.stringify(v);
      return v;
    } catch (e) {
      return String(v);
    }
  }

  function toPlain(o) {
    // BN objects etc. -- round-trip via JSON to drop class identity
    try {
      return JSON.parse(JSON.stringify(o, function (_k, val) {
        if (val && typeof val === "object" && typeof val.toString === "function" && val._isBigNumber) {
          return val.toString();
        }
        if (val && typeof val.toArrayLike === "function") {
          // BN (bn.js): render as decimal string
          return val.toString(10);
        }
        return val;
      }));
    } catch (e) {
      return o;
    }
  }

  async function handleCall(msg) {
    var c = ensureClient();
    switch (msg.method) {
      case "status": {
        return {
          webcrypto: !!(window.crypto && window.crypto.subtle),
          config: cfg(),
        };
      }
      case "diag": {
        // Reachability probe from inside the WebView (same network path the SDK
        // uses). Tells us: is the backend URL reachable, and how many notes are
        // on-chain -- so a flat 0 becomes an exact, actionable message.
        var d = {
          backendUrl: (cfg().backendUrl || "").slice(0, 80),
          reachable: false,
          treeNextLeaf: null,
          fetchError: null,
        };
        try {
          var tree = await nativeFetch(cfg().backendUrl + "/api/merkle/sol").then(function (r) {
            return r.json();
          });
          d.reachable = !!tree;
          d.treeNextLeaf =
            tree && typeof tree.next_leaf_index === "number" ? tree.next_leaf_index : null;
        } catch (e) {
          d.fetchError = String((e && e.message) || e).slice(0, 140);
        }
        return d;
      }
      case "unlock":
        await c.unlock();
        return { unlocked: true, pubkey: cfg().walletPubkey };
      case "refresh":
        return toPlain(await c.refreshNotes());
      case "getNotes":
        return toPlain(c.getNotes());
      case "balance": {
        var notes = c.getNotes().filter(function (n) {
          return !n.spent && n.mintAddress === SDK.WRAPPED_SOL_MINT;
        });
        var total = 0;
        for (var i = 0; i < notes.length; i++) total += Number(notes[i].amount || "0");
        return { lamports: total, sol: total / 1e9, noteCount: notes.length };
      }
      case "registered": {
        // Has this wallet published private receiving keys? 404 -> null -> not
        // enrolled; network/backend errors reject so RN can show them.
        var keys = await SDK.fetchRecipientKeys(cfg().walletPubkey);
        return { registered: !!keys };
      }
      case "enableReceiving": {
        // One-time enrollment: THREE wallet signature prompts (spending key,
        // receive key, registry binding). The wallet app shows them one by one.
        await SDK.publishRecipientKeys(bridgeSigner);
        return { registered: true };
      }
      case "relayerInfo": {
        // Fee schedule for the claim preview: bps of the gross + a lamport floor.
        var info = await SDK.fetchRelayerInfo();
        var minFee = Math.floor(Number(info && info.minTransferFee ? info.minTransferFee : 0));
        return {
          bps: Number(info && info.withdrawalFeeRateBps ? info.withdrawalFeeRateBps : 0),
          minFee: Number.isFinite(minFee) && minFee > 0 ? minFee : 0,
        };
      }
      case "withdraw": {
        // args: [grossLamports]. Claim: spend shielded notes back to the
        // employee's own wallet address, gasless via the relayer.
        var res = await c.withdrawSOL(msg.args[0], cfg().walletPubkey, { relay: true });
        return toPlain(res);
      }
      default:
        throw new Error("unknown method: " + msg.method);
    }
  }

  window.__pcash = {
    inject: function (raw) {
      var msg = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (msg.type === "signResponse") {
        var p = pendingSigns[msg.signId];
        if (p) {
          delete pendingSigns[msg.signId];
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(b64ToBytes(msg.signatureB64));
        }
        return;
      }
      if (msg.type === "signTxResponse") {
        // Wallet signed a tx; resolve with the signed base64 so
        // bridgedSignTransaction can deserialize it.
        var pt = pendingSigns[msg.signId];
        if (pt) {
          delete pendingSigns[msg.signId];
          if (msg.error) pt.reject(new Error(msg.error));
          else pt.resolve(msg.signedTxB64);
        }
        return;
      }
      if (msg.type !== "call") return;
      handleCall(msg)
        .then(function (data) {
          post({ id: msg.id, type: "result", ok: true, data: safeJson(data) });
        })
        .catch(function (err) {
          post({
            id: msg.id,
            type: "result",
            ok: false,
            error: (err && err.message) || String(err),
            stack: err && err.stack ? String(err.stack) : undefined,
          });
        });
    },
  };

  // announce readiness
  post({
    type: "ready",
    webcrypto: !!(window.crypto && window.crypto.subtle),
    hasSdk: !!SDK,
  });
})();
