/*
 * bridge-host.js — runs INSIDE the hidden WebView.
 *
 * Responsibilities:
 *   1. Read config injected by RN (window.__PCASH_CONFIG__).
 *   2. Install a fetch() override so relative "/circuit/*" + API calls reach the
 *      dev machine's LAN backend (the page itself has no real origin).
 *   3. Self-check window.crypto.subtle (Groth16/AES need a secure context).
 *   4. Build a PrivacyCashClient whose signer.signMessage round-trips to the
 *      native wallet (Mobile Wallet Adapter) via postMessage RPC.
 *   5. Expose window.__pcash.inject({...}) as the RN→bridge command channel and
 *      post results back via ReactNativeWebView.postMessage.
 *
 * Plain browser JS (inlined into bridge.html by build-bridge.mjs).
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

  // ---- fetch override: route /circuit/* and bare API paths to the LAN host ----
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

  // signTransaction is needed for DEPOSITS (depositSOL/depositSPL, which run
  // inside sendPrivateSOL/sendPrivateSPL). The SDK builds an unsigned V0 tx; we
  // serialize it, route it to the native wallet (MWA signTransactions) to sign,
  // then rehydrate the signed tx so the SDK can submit it to the relayer. The
  // SDK never signs locally -- it expects signer.signTransaction(tx) to return
  // the signed tx, then calls submitTransaction(signed.serialize()).
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
  var SDK = window.PrivacyCashSDK;
  var PublicKey = SDK && SDK.PublicKey;

  function ensureClient() {
    if (client) return client;
    if (!SDK) throw new Error("SDK bundle missing (window.PrivacyCashSDK)");
    if (!PublicKey) throw new Error("SDK did not export PublicKey");
    var c = cfg();
    if (c.backendUrl && SDK.setBackendUrl) SDK.setBackendUrl(c.backendUrl);
    var signer = {
      publicKey: new PublicKey(c.walletPubkey),
      signMessage: bridgedSignMessage,
      signTransaction: bridgedSignTransaction,
    };
    client = new SDK.PrivacyCashClient(signer);
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
    // BN objects etc. — round-trip via JSON to drop class identity
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

  // ---- note consolidation ----
  // The circuit accepts at most 2 input notes per proof, so a wallet whose
  // total balance covers a send can still fail once fragments shrink past
  // any note-or-pair fit. solveMergeNet sizes a self-transfer so the merged
  // output note keeps the whole value minus the relayer fee (no dust change).
  function solveMergeNet(totalBn, bps, floorBn) {
    var net = totalBn;
    for (var i = 0; i < 4; i++) {
      var f = (net * bps + 9999n) / 10000n;
      if (f < floorBn) f = floorBn;
      net = totalBn - f;
    }
    var f2 = (net * bps + 9999n) / 10000n;
    if (f2 < floorBn) f2 = floorBn;
    if (net + f2 > totalBn) net = totalBn - f2;
    return net;
  }

  // Merge the two largest free notes repeatedly (relayed, so gasless) until a
  // single note or a pair covers targetBn. Returns true when covered.
  async function mergeNotesFor(c, targetBn, mintAddress) {
    var self = cfg().walletPubkey;
    var bps = 25;
    var floorBn = 10000n;
    try {
      var info = await nativeFetch(cfg().backendUrl + "/api/relayer/info").then(function (r) {
        return r.json();
      });
      if (info && typeof info.fee_rate_bps === "number") bps = info.fee_rate_bps;
      if (info && typeof info.min_transfer_fee === "number") floorBn = BigInt(info.min_transfer_fee);
    } catch (e) {
      // defaults above match the prod relayer
    }
    for (var m = 0; m < 8; m++) {
      var notes = c
        .getNotes()
        .filter(function (n) {
          return !n.spent && n.mintAddress === mintAddress;
        })
        .map(function (n) {
          return { amount: BigInt(n.amount || "0"), blinding: n.blinding };
        })
        .sort(function (a, b) {
          return a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0;
        });
      if (notes[0] && notes[0].amount >= targetBn) return true;
      if (notes[0] && notes[1] && notes[0].amount + notes[1].amount >= targetBn) return true;
      if (notes.length < 2) return false;
      var merged = notes[0].amount + notes[1].amount;
      var net = solveMergeNet(merged, BigInt(bps), floorBn);
      if (net <= 0n) return false;
      await c.transferNoteSOL(self, Number(net), {
        relay: true,
        inputNotes: [{ blinding: notes[0].blinding }, { blinding: notes[1].blinding }],
      });
      await c.refreshNotes();
    }
    return false;
  }

  function isInsufficientBalanceError(e) {
    var s = String((e && e.message) || e);
    return s.indexOf("insufficient private balance") >= 0 || s.indexOf("no spendable notes") >= 0;
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
        // on devnet — so a flat 0 becomes an exact, actionable message.
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
      case "transfer": {
        // args: [amountLamports, recipientBase58]. Spend an existing shielded note
        // to pay an address (relayed gaslessly). If the vault's fragments cannot
        // fit the payment (2-input circuit limit), merge them to self first and
        // retry once.
        try {
          var res = await c.transferSOL(msg.args[0], msg.args[1], { relay: true });
          return toPlain(res);
        } catch (e) {
          if (!isInsufficientBalanceError(e)) throw e;
          var gross = BigInt(msg.args[0]) + 20000n;
          var ok = await mergeNotesFor(c, gross, SDK.WRAPPED_SOL_MINT);
          if (!ok) throw e;
          var res2 = await c.transferSOL(msg.args[0], msg.args[1], { relay: true });
          return toPlain(res2);
        }
      }
      case "transferSpl": {
        // args: [mintBase58, amountRaw, recipientBase58]
        try {
          var resS = await c.transferSPL(msg.args[0], msg.args[1], msg.args[2], { relay: true });
          return toPlain(resS);
        } catch (e) {
          if (!isInsufficientBalanceError(e)) throw e;
          var grossS = BigInt(msg.args[1]) + 20000n;
          var okS = await mergeNotesFor(c, grossS, msg.args[0]);
          if (!okS) throw e;
          var resS2 = await c.transferSPL(msg.args[0], msg.args[1], msg.args[2], { relay: true });
          return toPlain(resS2);
        }
      }
      case "send": {
        // Web-style "Send": deposit fresh from the wallet, then withdraw to the
        // recipient gaslessly. Needs signTransaction (the deposit). The deposit is
        // unlinkable to the withdraw via ZK. args: [amountLamports, recipientBase58]
        var res = await c.sendPrivateSOL(msg.args[0], msg.args[1], { relay: true });
        return toPlain(res);
      }
      case "sendSpl": {
        // args: [mintBase58, amountRaw, recipientBase58]
        var res = await c.sendPrivateSPL(msg.args[0], msg.args[1], msg.args[2], { relay: true });
        return toPlain(res);
      }
      case "exportNotes":
        return { json: c.exportNotesString() };
      case "importNotes":
        return { count: await c.importNotesJson(msg.args[0]) };
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
        // Wallet signed the deposit tx; resolve with the signed base64 so
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
