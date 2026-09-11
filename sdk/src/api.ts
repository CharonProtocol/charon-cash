import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { API_URL } from "./constants";
import { SilentPayError, SilentPayErrorCode } from "./error";

export class ApiClientError extends SilentPayError {
  apiErrorCode: ApiErrorCode;
  details?: ErrorDetail | null;
  status: number;

  constructor(
    apiErrorCode: ApiErrorCode,
    message: string,
    status: number,
    details?: ErrorDetail | null,
  ) {
    super(message, SilentPayErrorCode.API_ERROR);

    this.name = "ApiClientError";
    this.apiErrorCode = apiErrorCode;
    this.status = status;
    this.details = details;

    Object.setPrototypeOf(this, ApiClientError.prototype);
  }
}

export type Success<T> = {
  success: boolean;
  data: T;
  meta: RequestMeta;
};

export type ErrorResponse = {
  success: boolean;
  error: ApiError;
  meta: RequestMeta;
};

export type ApiError = {
  code: string;
  message: string;
  details?: null | ErrorDetail;
};

export type ErrorDetail = {
  field: string;
  reason: string;
};

export type RequestMeta = {
  requestId: string;
  timestamp: string;
};

enum ApiErrorCode {
  ValidationError = "Validation_Error",
  DbError = "Db_Error", // Most Likely DB connection failed or maintainence
  ValueNotFound = "Value_Not_Found", // Unregistered User
  InvalidInput = "Invalid_Input",
  DuplicateValue = "Duplicate_Value", // Re-registration of user
  BadGateway = "Bad_Gateway",
  // This will not happen in the current Api
  Unauthorized = "Unauthorized",
  // NOTE : This may happen during development
  PoolDoesNotExists = "Pool_Does_Not_Exists",
  PoolError = "Pool_Error",
}

/*
  Rust Serialization -> Js Deserialization 

    &[u8]             ->  number[]
    &str,String       ->  string
    bool              ->  bool
    i8..i32, u8..u32  -> 	number
    i64 / u64 /       ->  number but this will lose precision/ better to send as string
    Option<T>         ->  null | T


 */

async function fetchRecipientViewingKey(pubkey: PublicKey) {
  let response = await fetch(
    `${API_URL}/api/registration/viewing_key/${encodeURIComponent(pubkey.toString())}`,
  );

  if (!response.ok) {
    throw await err(response, "User is not registered on the network");
  }

  let json: Success<number[]> = await response.json();

  return Uint8Array.from(json.data);
}

async function checkRegistration(pubkey: PublicKey) {
  const response = await fetch(
    `${API_URL}/api/registration/${encodeURIComponent(pubkey.toString())}`,
  );

  if (!response.ok) {
    // resource not found then its fine
    // do nothing and move on
    if (response.status !== 404) {
      throw await err(response, "Failed to Check Registration");
    }
  }

  const json: Success<Boolean> = await response.json();

  return json.data;
}

export type RegistrationInfo = {
  walletPubkey: string;
  viewingkey: number[];
};

async function registerUser(info: RegistrationInfo) {
  if (info.viewingkey.length != 32) {
    throw new SilentPayError(
      "Length of viewing key must be 32",
      SilentPayErrorCode.INVALID_VIEWING_KEY,
    );
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

export type TreeState = {
  nextLeafIndex: BN;
  poolId: string;
  currentRoot: Uint8Array;
};

async function fetchTreeState(mintAddress: string): Promise<TreeState> {
  const response = await fetch(
    `${API_URL}/api/pools/${encodeURIComponent(mintAddress)}/merkle`,
  );

  if (!response.ok) {
    throw await err(response, "Failed to get tree State");
  }

  let json: Success<{
    nextLeafIndex: string;
    poolId: string;
    currentRoot: number[];
  }> = await response.json();

  let treeState: TreeState = {
    nextLeafIndex: new BN(json.data.nextLeafIndex),
    poolId: json.data.poolId,
    currentRoot: Uint8Array.from(json.data.currentRoot as number[]),
  };
  return treeState;
}

export type MerkleProof = {
  root: Uint8Array;
  nextIndex: string;
  proofs: Uint8Array[][];
};

async function fetchMerkleProof(
  mintAddress: string,
  leafIndex1: string,
  leafIndex2: string,
): Promise<MerkleProof> {
  const response = await fetch(
    `${API_URL}/api/pools/${encodeURIComponent(mintAddress)}/proof?leaf1=${leafIndex1}&leaf2=${leafIndex2}`,
  );

  if (!response.ok) {
    throw await err(response, "Failed to get leaf proof");
  }

  let json: Success<{
    root: number[];
    nextIndex: string;
    proofs: {
      proof: number[][];
      leaf: number[];
      index: string;
    }[];
  }> = await response.json();

  let path1 = json.data.proofs[0].proof.map((node) => Uint8Array.from(node));
  let path2 = json.data.proofs[1].proof.map((node) => Uint8Array.from(node));

  return {
    root: Uint8Array.from(json.data.root),
    nextIndex: json.data.nextIndex,
    proofs: [path1, path2],
  };
}

async function fetchNotes(lastFetchedNoteIndex: number) {
  const response = await fetch(`${API_URL}/api/utxos/${lastFetchedNoteIndex}`);

  if (!response.ok) {
    throw await err(response, "Failed to fetch utxos");
  }

  const json: Success<number[][]> = await response.json();

  const encryptedNotes: Uint8Array[] = (json.data as number[][]).map(
    (e_note: number[]) => Uint8Array.from(e_note),
  );

  return encryptedNotes;
}

async function err(response: Response, msg?: string): Promise<ApiClientError> {
  let body: ErrorResponse | undefined;
  try {
    body = await response.json();
  } catch {
    return new ApiClientError(
      ApiErrorCode.BadGateway,
      `${msg}: HTTP ${response.status} (non-JSON response)`,
      response.status,
    );
  }

  const apiErr = body?.error;
  if (!apiErr) {
    return new ApiClientError(
      ApiErrorCode.BadGateway,
      `${msg}: HTTP ${response.status} (unexpected error shape)`,
      response.status,
    );
  }

  return new ApiClientError(
    apiErr.code as ApiErrorCode,
    `${msg}: ${apiErr.message}`,
    response.status,
    apiErr.details,
  );
}

export const API = {
  fetchNotes,
  fetchMerkleProof,
  fetchRecipientViewingKey,
  fetchTreeState,
  checkRegistration,
  registerUser,
};
