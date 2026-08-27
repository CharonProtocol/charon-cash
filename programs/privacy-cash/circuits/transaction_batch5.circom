pragma circom 2.0.0;

include "./transaction.circom";

// Batch payout circuit: one proof pays up to 4 employees.
// Same JoinSplit as transaction2 but with 5 output slots:
// 4 employee notes + 1 change note. Unused employee slots are zero-amount
// notes (structurally identical commitments), so any k = 1..4 payouts fit
// one proof. Use 26 levels, same as light protocol v1.
component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(26, 2, 5);
