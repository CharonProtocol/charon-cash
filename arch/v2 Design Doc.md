# SilentPa App — Design Doc

- **_New Design_**

---

![v2_arch.png](v2_arch.png)

## **1. Schemas**

`Commitments-Table` and `Encrypted-Notes-Table` are **_not_** the source of truth — they act as a cache/index. On-chain transactions remain the source of truth, since nearly everything is sent on-chain.

For this the `encrypted_output1` and `encrypted_output2` that we send in `process_transact` instruction we have to modify them a bit

```
encrypted_output = ephemeral_pubkey (32 bytes)
+ nonce (12 bytes, for AES-GCM)
+ authTag (16 bytes)
+ ciphertext (variable length)
```

This makes everything On-Chain and that as only source of truth.

### **Registration Table**

| Column          | Description                                  |
| --------------- | -------------------------------------------- |
| `wallet_pubkey` | User's Solana wallet public key              |
| `x25519_pubkey` | Derived X25519 public key                    |
| `birth_index`   | Merkle Index at registration for efficiency. |

### **Commitments Table**

| Column        | Description                      |
| ------------- | -------------------------------- |
| `index`       | Note index / position            |
| `commitments` | On-chain commitment for the note |

### **Encrypted Notes Table**

| Column             | Description                          |
| ------------------ | ------------------------------------ |
| `ephemeral_pubkey` | Ephemeral X25519 public key per note |
| `encrypted_notes`  | Encrypted note payload               |
| `updated_at`       | Last updated timestamp               |

---

## **2. Key Generation**

Each user's wallet deterministically derives an X25519 key pair used for peer-to-peer encryption of notes.

```
seed           = wallet.sign("GOATPay")
x25519_keypair = crypto.generate_seed(seed)
```

The resulting **_public_** key is stored in DB, keyed by wallet address, in the `Registration Table`.

This provides the ability to generate a shared secret (via X25519 ECDH), enabling encrypted notes that can only be decrypted by the receiver.

---

## **3. Encryption & Decryption**

### **Encryption**

1. A note gets created on transaction, and for each note a fresh ephemeral key pair is generated:

```
(note_pubkey, note_privkey) = crypto.generate_random()
```

1. The receiver's X25519 pubkey is fetched:

```
recv_pubkey
```

1. A shared secret is generated:

```
shared_secret = generate_shared_secret(note_privkey, recv_pubkey)
key           = hkdf(shared_secret)
encrypted_note = aes_gcm(key, note)
```

1. `note_privkey` is discarded after the instruction is sent. So this makes it that now only the receiver will be the only one that can decrypt the encrypted note achieving

### **Decryption**

1. The pair `(note_pubkey, encrypted_note)` is received by the user.
2. For each note, the user generates the shared secret and attempts to decrypt:

```
shared_secret = generate_shared_secret(recv_privkey, note_pubkey)
```

This shared secret is the same one generated during encryption.

```
key           = hkdf(shared_secret)
decrypted_note = aes_gcm_decrypt(key, encrypted_note)
```

1. If decryption succeeds, the note is stored in the local cache; otherwise, it is discarded.

---

## **4. Program Flow**

### **4.1 Deposit**

1. User signs a deposit transaction (e.g. 100 SOL) between their wallet and the pool.
2. A note is generated and encrypted as per the encryption.
3. The `process_transact` instruction is then sent.
4. On successful on-chain confirmation, the indexer:
   - Fetches the transaction.
   - Parses the data.
   - populates **_Commitments-Table_** / **_Encrypted-Notes-Table_** as a cache.

### **4.2 Withdraw**

1. User signs a withdrawal transaction between the **_pool_** and their wallet.
2. This spends (nullifies) the note(s) being withdrawn.
3. On successful on-chain confirmation, the indexer:
   - Fetches the transaction.
   - Parses the data.
   - populates **_Commitments-Table_** / **_Encrypted-Notes-Table_** as a cache.

---

## **5. Note Discovery**

There is no way to know in advance which notes belong to a given user — **_every_** user must attempt to decrypt **_every_** note on the network.

### **Efficiency Strategy on FrontEnd**

1. Run decryption in a **_Web Worker_**, off the main thread.
2. Fetch encrypted notes from the chain **_in batches_**.
3. For each batch, attempt decryption with the user's key:
   - Successfully decrypted notes → keep.
   - Everything else → discard.
4. **_Index tracking:_** the index up to which the user has performed checks will be kept on client-side.

> **_NOTE:_** if the user's local cache is reset, they will be required to perform decryption of every note from the start. Suggestions needed.
