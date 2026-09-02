import BN from "bn.js";
export async function fetchRecipientViewingKey(pubkey) {
    let response = await fetch(`${process.env.API_URL}/api/registration/get_viewing_key/${encodeURIComponent(pubkey.toString())}`);
    if (!response.ok) {
        throw await err(response, "Couldn't Retreive RecipientInfo");
    }
    let json = await response.json();
    return Uint8Array.from(json.data);
}
export async function checkRegistration(pubkey) {
    const response = await fetch(`${process.env.API_URL}/api/registration/check/${encodeURIComponent(pubkey.toString())}`);
    if (!response.ok) {
        throw await err(response, "Failed to verify registration");
    }
    return await response.json();
}
export async function registerUserInfo(info) {
    if (info.viewing_pubkey.length != 32) {
        throw new Error("Length of viewing key must be 32");
    }
    const response = await fetch(`${process.env.API_URL}/api/registration/register`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(info),
    });
    if (!response.ok) {
        throw await err(response, "Failed To Register User");
    }
}
export async function fetchTreeState(mintAddress) {
    const response = await fetch(`${process.env.API_URL}/api/merkle/${encodeURIComponent(mintAddress)}`);
    if (!response.ok) {
        throw await err(response, "Failed to get tree State");
    }
    let json = await response.json();
    let treeState = {
        nextLeafIndex: new BN(json.data.nextLeafIndex),
        treeKey: json.data.treeKey,
        currentRoot: Uint8Array.from(json.data.currentRoot),
    };
    return treeState;
}
export async function fetchMerkleProofForLeaves(mintAddress, leafIndex1, leafIndex2) {
    if (leafIndex1 === "0" && leafIndex2 === "0") {
        throw new Error("At least one of leafIndex1 or leafIndex2 must be non-zero.");
    }
    const response = await fetch(`${process.env.API_URL}/api/merkle/${encodeURIComponent(mintAddress)}/proof/${leafIndex1},${leafIndex2}`);
    if (!response.ok) {
        throw await err(response, "Failed to get leaf proof");
    }
    let json = await response.json();
    let merkleProof1 = {
        proof: json.data.proof1.proof.map((node) => Uint8Array.from(node)),
        leaf: Uint8Array.from(json.data.proof1.leaf),
        index: json.data.proof1.index,
        root: Uint8Array.from(json.data.proof1.root),
    };
    let merkleProof2 = {
        proof: json.data.proof2.proof.map((node) => Uint8Array.from(node)),
        leaf: Uint8Array.from(json.data.proof2.leaf),
        index: json.data.proof2.index,
        root: Uint8Array.from(json.data.proof2.root),
    };
    return {
        proof1: merkleProof1,
        proof2: merkleProof2,
    };
}
async function err(response, msg) {
    return new Error(`${msg},  Status: ${response.status}, Error: ${(await response.json()).data.err}`);
}
export async function fetchNotes(lastFetchedNoteIndex) {
    const response = await fetch(`${process.env.API_URL}/api/notes/send_notes/${lastFetchedNoteIndex}`);
    if (!response.ok) {
        throw await err(response, "Failed To Fetch Notes");
    }
    const json = await response.json();
    // it will return number[][]
    // [notes_in_bytes]
    const encryptedNotes = json.data.map((e_note) => Uint8Array.from(e_note));
    return encryptedNotes;
}
