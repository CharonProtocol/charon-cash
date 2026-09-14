import BN from "bn.js";
import { API_URL } from "./constants";
import { SilentPayError, SilentPayErrorCode } from "./error";
export class ApiClientError extends SilentPayError {
    apiErrorCode;
    details;
    status;
    constructor(apiErrorCode, message, status, details) {
        super(message, SilentPayErrorCode.API_ERROR);
        this.name = "ApiClientError";
        this.apiErrorCode = apiErrorCode;
        this.status = status;
        this.details = details;
        Object.setPrototypeOf(this, ApiClientError.prototype);
    }
}
var ApiErrorCode;
(function (ApiErrorCode) {
    ApiErrorCode["ValidationError"] = "Validation_Error";
    ApiErrorCode["DbError"] = "Db_Error";
    ApiErrorCode["ValueNotFound"] = "Value_Not_Found";
    ApiErrorCode["InvalidInput"] = "Invalid_Input";
    ApiErrorCode["DuplicateValue"] = "Duplicate_Value";
    ApiErrorCode["BadGateway"] = "Bad_Gateway";
    // This will not happen in the current Api
    ApiErrorCode["Unauthorized"] = "Unauthorized";
    // NOTE : This may happen during development
    ApiErrorCode["PoolDoesNotExists"] = "Pool_Does_Not_Exists";
    ApiErrorCode["PoolError"] = "Pool_Error";
})(ApiErrorCode || (ApiErrorCode = {}));
/*
  Rust Serialization -> Js Deserialization

    &[u8]             ->  number[]
    &str,String       ->  string
    bool              ->  bool
    i8..i32, u8..u32  -> 	number
    i64 / u64 /       ->  number but this will lose precision/ better to send as string
    Option<T>         ->  null | T


 */
async function fetchRecipientViewingKey(pubkey) {
    let response = await fetch(`${API_URL}/api/registration/viewing_key/${encodeURIComponent(pubkey.toString())}`);
    if (!response.ok) {
        throw await err(response, "User is not registered on the network");
    }
    let json = await response.json();
    return Uint8Array.from(json.data);
}
async function checkRegistration(pubkey) {
    const response = await fetch(`${API_URL}/api/registration/${encodeURIComponent(pubkey.toString())}`);
    if (!response.ok) {
        // resource not found then its fine
        // do nothing and move on
        if (response.status !== 404) {
            throw await err(response, "Failed to Check Registration");
        }
    }
    const json = await response.json();
    return json.data;
}
async function registerUser(info) {
    if (info.viewingkey.length != 32) {
        throw new SilentPayError("Length of viewing key must be 32", SilentPayErrorCode.INVALID_VIEWING_KEY);
    }
    const response = await fetch(`${API_URL}/api/registration/`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(info),
    });
    if (!response.ok) {
        // Duplicate value , not neccessarily an error
        if (response.status !== 409) {
            throw await err(response, "Failed To Register User");
        }
    }
}
async function fetchTreeState(mintAddress) {
    const response = await fetch(`${API_URL}/api/pools/${encodeURIComponent(mintAddress)}/merkle`);
    if (!response.ok) {
        throw await err(response, "Failed to get tree State");
    }
    let json = await response.json();
    let treeState = {
        nextLeafIndex: new BN(json.data.nextLeafIndex),
        poolId: json.data.poolId,
        currentRoot: Uint8Array.from(json.data.currentRoot),
    };
    return treeState;
}
async function fetchMerkleProof(mintAddress, indices, commitments) {
    if (indices.length > 2 || commitments.length > 2) {
        throw new ApiClientError(ApiErrorCode.InvalidInput, "Indices/Commitments should be of length 2", 400);
    }
    const response = await fetch(`${API_URL}/api/pools/${encodeURIComponent(mintAddress)}/proof?indices=${indices.join(",")}&commitments=${commitments.join(",")}`);
    if (!response.ok) {
        throw await err(response, "Failed to get leaf proof");
    }
    let json = await response.json();
    let path1 = json.data.proofs[0].proof.map((node) => Uint8Array.from(node));
    let path2 = json.data.proofs[1].proof.map((node) => Uint8Array.from(node));
    return {
        root: Uint8Array.from(json.data.root),
        nextIndex: json.data.nextIndex,
        proofs: [path1, path2],
    };
}
async function fetchNotes(lastFetchedNoteIndex) {
    const response = await fetch(`${API_URL}/api/utxos/${lastFetchedNoteIndex}`);
    if (!response.ok) {
        throw await err(response, "Failed to fetch utxos");
    }
    const json = await response.json();
    const encryptedNotes = json.data.map((e_note) => Uint8Array.from(e_note));
    return encryptedNotes;
}
async function err(response, msg) {
    let body;
    try {
        body = await response.json();
    }
    catch {
        return new ApiClientError(ApiErrorCode.BadGateway, `${msg}: HTTP ${response.status} (non-JSON response)`, response.status);
    }
    const apiErr = body?.error;
    if (!apiErr) {
        return new ApiClientError(ApiErrorCode.BadGateway, `${msg}: HTTP ${response.status} (unexpected error shape)`, response.status);
    }
    return new ApiClientError(apiErr.code, `${msg}: ${apiErr.message}`, response.status, apiErr.details);
}
export const API = {
    fetchNotes,
    fetchMerkleProof,
    fetchRecipientViewingKey,
    fetchTreeState,
    checkRegistration,
    registerUser,
};
