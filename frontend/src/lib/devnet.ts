import { BACKEND_URL, FEE_RECIPIENT, PROGRAM_ID, SPL_MINTS } from "./config";

type RelayerDeployment = {
  program_id: string;
  fee_recipient: string;
  supported_mints: { mint: string }[];
};

export async function checkDevnetBackend(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BACKEND_URL}/api/relayer/info`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("Cannot reach the devnet backend. Start the local backend with its devnet configuration.");
  }
  if (!response.ok) {
    throw new Error("The devnet backend is unavailable. Start the local backend with its devnet configuration.");
  }
  const info: RelayerDeployment = await response.json();
  if (!PROGRAM_ID || info.program_id !== PROGRAM_ID || info.fee_recipient !== FEE_RECIPIENT) {
    throw new Error("The backend does not match the configured devnet deployment. Check its program ID and fee recipient.");
  }
  if (!Object.values(SPL_MINTS).every((mint) => info.supported_mints?.some((entry) => entry.mint === mint))) {
    throw new Error("The backend does not support the deployed devnet test token.");
  }
}
