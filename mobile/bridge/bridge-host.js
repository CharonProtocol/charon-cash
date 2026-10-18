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

  // Several messages in one wallet session (MWA signMessages takes a batch).
  function bridgedSignBatch(messages) {
    return new Promise(function (resolve, reject) {
      var signId = ++signCounter;
      pendingSigns[signId] = { resolve: resolve, reject: reject };
      post({ type: "signBatchRequest", signId: signId, messagesB64: messages.map(bytesToB64) });
      setTimeout(function () {
        if (pendingSigns[signId]) {
          pendingSigns[signId].reject(new Error("signMessages timed out (120s)"));
          delete pendingSigns[signId];
        }
      }, 120000);
    });
  }

  // Unlock needs two signatures. Ask the wallet for both in ONE session and
  // seed rememberUnlockSigner's per-session cache, so unlock() reads them
  // instead of opening the wallet twice.
  async function presignUnlock() {
    var pk = cfg().walletPubkey;
    var keys = ["charon:unlock:notes:" + pk, "charon:unlock:receive:" + pk];
    try {
      if (sessionStorage.getItem(keys[0]) && sessionStorage.getItem(keys[1])) return;
    } catch (e) {
      return; // no storage: unlock signs one by one
    }
    var enc = new TextEncoder();
    var sigs = await bridgedSignBatch([enc.encode(SDK.SIGN_MESSAGE), enc.encode(SDK.RECEIVE_SIGN_MESSAGE)]);
    if (!sigs || sigs.length !== 2) throw new Error("wallet returned " + (sigs ? sigs.length : 0) + " signatures");
    sessionStorage.setItem(keys[0], sigs[0]);
    sessionStorage.setItem(keys[1], sigs[1]);
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

  // ---- native prover: proofs round-trip to the app's arkworks module ----
  var pendingProofs = {}; // proveId -> {resolve, reject}
  var proveCounter = 0;

  // The arkworks parser reads extDataHash little-endian (same quirk as the
  // wasm prover); every other input is big-endian. Pre-swap so the circuit
  // sees the true value.
  function swapBytes32(v) {
    var h = BigInt(v);
    var out = 0n;
    for (var i = 0; i < 32; i++) out = (out << 8n) | ((h >> BigInt(8 * i)) & 0xffn);
    return out;
  }
  function bigintsToString(v) {
    if (typeof v === "bigint") return v.toString(10);
    if (Array.isArray(v)) return v.map(bigintsToString);
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) o[k] = bigintsToString(v[k]);
      return o;
    }
    return v;
  }

  function nativeProve(input) {
    var patched = Object.assign({}, input);
    if (patched.extDataHash !== undefined) patched.extDataHash = swapBytes32(patched.extDataHash);
    var inputJson = JSON.stringify(bigintsToString(patched));
    return new Promise(function (resolve, reject) {
      var proveId = ++proveCounter;
      pendingProofs[proveId] = { resolve: resolve, reject: reject };
      post({ type: "proveRequest", proveId: proveId, inputJson: inputJson });
    }).then(function (rawJson) {
      return SDK.compressedToSnarkjs(JSON.parse(rawJson));
    });
  }

  // ---- SDK client (lazy) ----
  var client = null;
  var started = null;
  var SDK = window.PrivacyCashSDK;
  var PublicKey = SDK && SDK.PublicKey;

  function ensureClient() {
    if (client) return client;
    if (!SDK) throw new Error("SDK bundle missing (window.PrivacyCashSDK)");
    if (!PublicKey) throw new Error("SDK did not export PublicKey");
    var c = cfg();
    if (c.backendUrl && SDK.setBackendUrl) SDK.setBackendUrl(c.backendUrl);
    if (c.nativeProver && SDK.setProver) {
      SDK.setProver(function (input) {
        return nativeProve(input);
      });
    }
    var base = {
      publicKey: new PublicKey(c.walletPubkey),
      signMessage: bridgedSignMessage,
      signTransaction: bridgedSignTransaction,
    };
    // the two unlock signatures are kept for this WebView's session
    signer = SDK.rememberUnlockSigner ? SDK.rememberUnlockSigner(base) : base;
    client = new SDK.PrivacyCashClient(signer);
    return client;
  }
  var signer = null;

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
    // BN / bigint -> decimal strings so the result survives JSON
    try {
      return JSON.parse(JSON.stringify(o, function (_k, val) {
        if (typeof val === "bigint") return val.toString(10);
        if (val && typeof val.toArrayLike === "function") return val.toString(10);
        return val;
      }));
    } catch (e) {
      return o;
    }
  }

  var SOL = "SOL";
  function isSol(mint) {
    return !mint || mint === SOL || mint === SDK.WRAPPED_SOL_MINT;
  }
  function noteMint(mint) {
    return isSol(mint) ? SDK.WRAPPED_SOL_MINT : mint;
  }

  // ---- note consolidation ----
  // A spend takes at most 2 input notes, so a balance that covers a payment
  // can still fail once it is fragmented. solveMergeNet sizes a self-transfer
  // so the merged note keeps the whole value minus the relayer fee.
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

  // Merge the two largest free notes (relayed, gasless) until one note or a
  // pair covers targetBn. Returns true when covered.
  async function mergeNotesFor(c, targetBn, mint) {
    var self = cfg().walletPubkey;
    var info = await SDK.fetchRelayerInfo();
    var bps = BigInt(info.withdrawalFeeRateBps || 25);
    var floorBn = BigInt(info.minTransferFee || 0);
    var nm = noteMint(mint);
    for (var m = 0; m < 8; m++) {
      var notes = c
        .getNotes()
        .filter(function (n) {
          return !n.spent && n.mintAddress === nm;
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
      var net = solveMergeNet(notes[0].amount + notes[1].amount, bps, floorBn);
      if (net <= 0n) return false;
      var inputs = [{ blinding: notes[0].blinding }, { blinding: notes[1].blinding }];
      if (isSol(mint)) await c.transferNoteSOL(self, Number(net), { relay: true, inputNotes: inputs });
      else await c.transferNoteSPL(mint, self, Number(net), { relay: true, inputNotes: inputs });
      await c.refreshNotes();
    }
    return false;
  }

  function isInsufficientBalanceError(e) {
    var s = String((e && e.message) || e);
    return s.indexOf("insufficient private balance") >= 0 || s.indexOf("no spendable notes") >= 0;
  }

  // Run a spend; if the notes are too fragmented for it, merge once and retry.
  async function spend(c, mint, gross, fn) {
    try {
      return await fn();
    } catch (e) {
      if (!isInsufficientBalanceError(e)) throw e;
      if (!(await mergeNotesFor(c, BigInt(gross), mint))) throw e;
      return await fn();
    }
  }

  function balances(c) {
    var out = {};
    var notes = c.getNotes().filter(function (n) {
      return !n.spent;
    });
    for (var i = 0; i < notes.length; i++) {
      var mint = notes[i].mintAddress === SDK.WRAPPED_SOL_MINT ? SOL : notes[i].mintAddress;
      var b = out[mint] || (out[mint] = { total: 0n, amounts: [] });
      var a = BigInt(notes[i].amount || "0");
      b.total += a;
      b.amounts.push(a);
    }
    var res = {};
    for (var k in out) {
      var am = out[k].amounts.sort(function (x, y) {
        return x > y ? -1 : x < y ? 1 : 0;
      });
      res[k] = {
        total: out[k].total.toString(),
        // a spend takes at most two notes
        maxSingle: ((am[0] || 0n) + (am[1] || 0n)).toString(),
        noteCount: am.length,
      };
    }
    return res;
  }

  async function handleCall(msg) {
    var c = ensureClient();
    var a = msg.args || [];
    switch (msg.method) {
      case "status": {
        return {
          webcrypto: !!(window.crypto && window.crypto.subtle),
          config: cfg(),
        };
      }
      case "diag": {
        // Reachability probe from inside the WebView (same network path the SDK uses).
        var d = { backendUrl: (cfg().backendUrl || "").slice(0, 80), reachable: false, fetchError: null };
        try {
          var h = await nativeFetch(cfg().backendUrl + "/health").then(function (r) {
            return r.json();
          });
          d.reachable = !!h && h.status === "ok";
        } catch (e) {
          d.fetchError = String((e && e.message) || e).slice(0, 140);
        }
        return d;
      }
      case "start": {
        // Unlock (two signatures, once per session) and enroll this wallet for
        // private receiving: the same signature links the note-backup key.
        started =
          started ||
          (async function () {
            await c.init();
            await presignUnlock();
            await c.unlock();
            var me = cfg().walletPubkey;
            if (!(await SDK.fetchRecipientKeys(me))) {
              await SDK.publishRecipientKeys(signer, c.receiveKeys(), c.backupKey());
            }
            var info = await SDK.fetchRelayerInfo();
            return {
              pubkey: me,
              feeBps: info.withdrawalFeeRateBps,
              mints: info.supportedMints.map(function (m) {
                return { mint: m.mint, symbol: m.symbol || null, decimals: m.decimals == null ? null : m.decimals };
              }),
            };
          })();
        try {
          return await started;
        } catch (e) {
          started = null;
          throw e;
        }
      }
      case "refresh":
        return toPlain(await c.refreshNotes());
      case "getNotes":
        return toPlain(c.getNotes());
      case "balances":
        return balances(c);
      case "isRegistered":
        return { registered: !!(await SDK.fetchRecipientKeys(a[0])) };
      case "deposit": {
        // args: [mint|"SOL", amountRaw]: wallet -> own private balance
        if (isSol(a[0])) return toPlain(await c.depositSOL(Number(a[1])));
        return toPlain(await c.depositSPL(a[0], a[1]));
      }
      case "depositTo": {
        // args: [mint|"SOL", amountRaw, recipientWallet]: wallet -> their private balance
        if (isSol(a[0])) return toPlain(await c.depositSOLTo(Number(a[1]), a[2]));
        return toPlain(await c.depositSPLTo(a[0], a[1], a[2]));
      }
      case "withdraw": {
        // args: [mint|"SOL", amountRaw, recipientAddress?]: private -> a public address (relayed)
        var to = a[2] || cfg().walletPubkey;
        return toPlain(
          await spend(c, a[0], a[1], function () {
            if (isSol(a[0])) return c.withdrawSOL(Number(a[1]), to, { relay: true });
            return c.withdrawSPL(a[0], a[1], to, { relay: true });
          }),
        );
      }
      case "transferPrivate": {
        // args: [mint|"SOL", amountRaw, recipientWallet]: private -> their private balance
        return toPlain(
          await spend(c, a[0], a[1], function () {
            if (isSol(a[0])) return c.transferNoteSOL(a[2], Number(a[1]), { relay: true });
            return c.transferNoteSPL(a[0], a[2], Number(a[1]), { relay: true });
          }),
        );
      }
      case "swap": {
        // args: [fromMint|"SOL", toMint|"SOL", amountRaw]
        return toPlain(await c.swap(noteMint(a[0]), noteMint(a[1]), a[2]));
      }
      case "exportNotes":
        return { json: c.exportNotesString() };
      case "importNotes":
        return { count: await c.importNotesJson(a[0]) };
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
      if (msg.type === "signBatchResponse") {
        var pb = pendingSigns[msg.signId];
        if (pb) {
          delete pendingSigns[msg.signId];
          if (msg.error) pb.reject(new Error(msg.error));
          else pb.resolve(msg.signaturesB64);
        }
        return;
      }
      if (msg.type === "proveResponse") {
        var pp = pendingProofs[msg.proveId];
        if (pp) {
          delete pendingProofs[msg.proveId];
          if (msg.error) pp.reject(new Error(msg.error));
          else pp.resolve(msg.rawJson);
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
