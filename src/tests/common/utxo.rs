use light_hasher::{Hash, Hasher, HasherError};
use solana_keypair::Address;
pub struct Utxo<'a> {
    hasher: &'a Hasher,
    amount: u64,
    blinding: u64,
    keypair: Keypair,
    index: u64,
    mint_address: &'a Address,
}

impl<'a> Utxo<'a> {
    fn new(
        hasher: &Hasher,
        amount: u64,
        blinding: u64,
        keypair: Keypair,
        index: u64,
        mint_address: &Address,
    ) -> Self {
        Self {
            hasher,
            amount,
            blinding,
            keypair,
            index,
            mint_address,
        }
    }

    fn get_commitment(&self) -> Result<Hash, HasherError> {
        let commitment_vec: Vec<u8> = [
            self.amount.to_le_bytes().as_slice(),
            self.keypair.pubkey.to_le_bytes().as_slice(),
            self.blinding.to_le_bytes().as_slice(),
            self.mint_address.as_array().as_slice(),
        ]
        .concat();
        self.hasher.hash(&commitment_vec)
    }
    fn get_nullifier(&self) -> Result<Hash, HasherError> {
        let commitment = self.get_commitment()?;
        let signature: String = self.keypair.sign(commitment, self.index);

        let nullifier: Vec<u8> = [
            commitment.as_slice(),
            self.index.to_le_bytes().as_slice(),
            signature.as_bytes(),
        ]
        .concat();

        self.hasher.hash(&nullifier)
    }
}
