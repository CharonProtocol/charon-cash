pragma circom 2.0.0;

include "./transaction.circom";

// Batch payout circuit: one proof pays up to 2 employees. 3 output slots:
// 2 employee notes + 1 change note. The unused employee slot (when paying 1)
// is a zero-amount note — structurally identical to a real commitment, same
// padding mechanism the 2-output circuit already uses for deposits.
// nOuts is capped at 3 by the Solana 1232-byte tx limit: every output adds an
// encrypted note to the instruction, and 4+ real-size encs overflow the packet
// even with an address lookup table for the static accounts.
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(26, 2, 3);
