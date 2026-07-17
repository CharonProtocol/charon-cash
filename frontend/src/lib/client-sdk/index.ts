import type { WithdrawKind, WithdrawRequest } from "@/lib/types"

export class ClientSdkNotConnectedError extends Error {
  constructor(message = "Client SDK is not connected — ZK proof generation is not implemented yet.") {
    super(message)
    this.name = "ClientSdkNotConnectedError"
  }
}

export interface BuildWithdrawParams {
  kind: WithdrawKind
  recipient: string
  extAmount: number
  fee: number
  mint?: string
}

export const CLIENT_SDK_VERSION: string | null = null

export function isClientSdkConnected(): boolean {
  return false
}

export async function buildWithdrawRequest(
  _params: BuildWithdrawParams,
): Promise<WithdrawRequest> {
  throw new ClientSdkNotConnectedError(
    "buildWithdrawRequest() is a stub. The real implementation goes in src/lib/client-sdk — see README.md. " +
      "It must fetch the Merkle proof from the backend, run the circom WASM prover to produce proof_a/b/c, " +
      "compute ext_data_hash + public_amount from the note, and return a full WithdrawRequest.",
  )
}

export function parsePastedWithdrawRequest(json: string): WithdrawRequest {
  const data = JSON.parse(json) as Record<string, unknown>
  const required = [
    "kind",
    "proof_a",
    "proof_b",
    "proof_c",
    "root",
    "public_amount",
    "ext_data_hash",
    "input_nullifiers",
    "output_commitments",
    "ext_amount",
    "fee",
    "encrypted_output1",
    "encrypted_output2",
    "recipient",
  ]
  for (const key of required) {
    if (!(key in data)) {
      throw new Error(`pasted proof JSON missing field: ${key}`)
    }
  }
  return data as unknown as WithdrawRequest
}
