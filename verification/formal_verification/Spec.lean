import QEDGen.Solana.Account
import QEDGen.Solana.Cpi
import QEDGen.Solana.State
import QEDGen.Solana.Valid

namespace PrivacyCash

open QEDGen.Solana

structure State where
  authority : Pubkey
  max_deposit_amount : Nat
  bump : Nat
  next_index : Nat
  deriving Repr, DecidableEq, BEq, Inhabited

/-- Handler invocation context (#328): account addresses and cross-program
    state the guards read. Universally quantified in every theorem. -/
structure ActionCtx where
  authority : Pubkey

def initializeTransition (s : State) (signer : Pubkey) (initial_max_deposit_amount : Nat) (tree_account_bump : Nat) : Option State :=
  some { s with max_deposit_amount := initial_max_deposit_amount, bump := tree_account_bump, next_index := 0 }

def initialize_tree_account_for_spl_tokenTransition (s : State) (signer : Pubkey) (initial_max_deposit_amount : Nat) (tree_account_bump : Nat) : Option State :=
  some { s with max_deposit_amount := initial_max_deposit_amount, bump := tree_account_bump, next_index := 0 }

def transactTransition (s : State) (signer : Pubkey) (ext_amount : Int) (fee : Nat) : Option State :=
  if ext_amount ≤ (((s.max_deposit_amount) : Int)) ∧ s.next_index % 2 = 0 ∧ s.next_index + 2 ≤ 4294967295 then
    some { s with next_index := s.next_index + 2 }
  else none

def transact_splTransition (s : State) (signer : Pubkey) (ext_amount : Int) (fee : Nat) : Option State :=
  if ext_amount ≤ (((s.max_deposit_amount) : Int)) ∧ s.next_index % 2 = 0 ∧ s.next_index + 2 ≤ 4294967295 then
    some { s with next_index := s.next_index + 2 }
  else none

def update_deposit_limitTransition (s : State) (signer : Pubkey) (ctx : ActionCtx) (new_limit : Nat) : Option State :=
  if signer = s.authority ∧ s.authority = ctx.authority then
    some { s with max_deposit_amount := new_limit }
  else none

def update_deposit_limit_for_splTransition (s : State) (signer : Pubkey) (ctx : ActionCtx) (new_limit : Nat) : Option State :=
  if signer = s.authority ∧ s.authority = ctx.authority then
    some { s with max_deposit_amount := new_limit }
  else none

def update_global_configTransition (s : State) (signer : Pubkey) (ctx : ActionCtx) (deposit_fee_rate : Nat) (withdrawal_fee_rate : Nat) (fee_error_margin : Nat) : Option State :=
  if signer = s.authority ∧ s.authority = ctx.authority ∧ deposit_fee_rate ≤ 10000 ∧ withdrawal_fee_rate ≤ 10000 ∧ fee_error_margin ≤ 10000 then
    some s
  else none

/-- Invariant: tree_admin_bound -/
theorem tree_admin_bound (s : State) : s.max_deposit_amount ≥ 0 := by sorry

/-- Invariant: tree_index_even -/
theorem tree_index_even (s : State) : s.next_index % 2 = 0 := by sorry

inductive Operation where
  | «initialize» (initial_max_deposit_amount : Nat) (tree_account_bump : Nat)
  | initialize_tree_account_for_spl_token (initial_max_deposit_amount : Nat) (tree_account_bump : Nat)
  | transact (ext_amount : Int) (fee : Nat)
  | transact_spl (ext_amount : Int) (fee : Nat)
  | update_deposit_limit (new_limit : Nat)
  | update_deposit_limit_for_spl (new_limit : Nat)
  | update_global_config (deposit_fee_rate : Nat) (withdrawal_fee_rate : Nat) (fee_error_margin : Nat)
  deriving Repr, DecidableEq, BEq

def applyOp (s : State) (signer : Pubkey) (ctx : ActionCtx) : Operation → Option State
  | .«initialize» initial_max_deposit_amount tree_account_bump => initializeTransition s signer initial_max_deposit_amount tree_account_bump
  | .initialize_tree_account_for_spl_token initial_max_deposit_amount tree_account_bump => initialize_tree_account_for_spl_tokenTransition s signer initial_max_deposit_amount tree_account_bump
  | .transact ext_amount fee => transactTransition s signer ext_amount fee
  | .transact_spl ext_amount fee => transact_splTransition s signer ext_amount fee
  | .update_deposit_limit new_limit => update_deposit_limitTransition s signer ctx new_limit
  | .update_deposit_limit_for_spl new_limit => update_deposit_limit_for_splTransition s signer ctx new_limit
  | .update_global_config deposit_fee_rate withdrawal_fee_rate fee_error_margin => update_global_configTransition s signer ctx deposit_fee_rate withdrawal_fee_rate fee_error_margin

-- ============================================================================
-- Abort conditions — operations must reject under specified conditions
-- ============================================================================

theorem transact_aborts_if_DepositLimitExceeded (s : State) (signer : Pubkey) (ext_amount : Int) (fee : Nat)
    (h : ¬(ext_amount ≤ (((s.max_deposit_amount) : Int)))) : transactTransition s signer ext_amount fee = none := by
  unfold transactTransition
  rw [if_neg (fun hg => h hg.1)]

theorem transact_aborts_if_InvalidMerkleTreeAccount (s : State) (signer : Pubkey) (ext_amount : Int) (fee : Nat)
    (h : ¬(s.next_index % 2 = 0)) : transactTransition s signer ext_amount fee = none := by
  unfold transactTransition
  rw [if_neg (fun hg => h hg.2.1)]

theorem transact_spl_aborts_if_DepositLimitExceeded (s : State) (signer : Pubkey) (ext_amount : Int) (fee : Nat)
    (h : ¬(ext_amount ≤ (((s.max_deposit_amount) : Int)))) : transact_splTransition s signer ext_amount fee = none := by
  unfold transact_splTransition
  rw [if_neg (fun hg => h hg.1)]

theorem transact_spl_aborts_if_InvalidMerkleTreeAccount (s : State) (signer : Pubkey) (ext_amount : Int) (fee : Nat)
    (h : ¬(s.next_index % 2 = 0)) : transact_splTransition s signer ext_amount fee = none := by
  unfold transact_splTransition
  rw [if_neg (fun hg => h hg.2.1)]

theorem update_deposit_limit_aborts_if_Unauthorized (s : State) (signer : Pubkey) (ctx : ActionCtx) (new_limit : Nat)
    (h : ¬(s.authority = ctx.authority)) : update_deposit_limitTransition s signer ctx new_limit = none := by
  unfold update_deposit_limitTransition
  rw [if_neg (fun hg => h hg.2)]

theorem update_deposit_limit_for_spl_aborts_if_Unauthorized (s : State) (signer : Pubkey) (ctx : ActionCtx) (new_limit : Nat)
    (h : ¬(s.authority = ctx.authority)) : update_deposit_limit_for_splTransition s signer ctx new_limit = none := by
  unfold update_deposit_limit_for_splTransition
  rw [if_neg (fun hg => h hg.2)]

theorem update_global_config_aborts_if_Unauthorized (s : State) (signer : Pubkey) (ctx : ActionCtx) (deposit_fee_rate : Nat) (withdrawal_fee_rate : Nat) (fee_error_margin : Nat)
    (h : ¬(s.authority = ctx.authority)) : update_global_configTransition s signer ctx deposit_fee_rate withdrawal_fee_rate fee_error_margin = none := by
  unfold update_global_configTransition
  rw [if_neg (fun hg => h hg.2.1)]

theorem update_global_config_aborts_if_InvalidFeeRate_0 (s : State) (signer : Pubkey) (ctx : ActionCtx) (deposit_fee_rate : Nat) (withdrawal_fee_rate : Nat) (fee_error_margin : Nat)
    (h : ¬(deposit_fee_rate ≤ 10000)) : update_global_configTransition s signer ctx deposit_fee_rate withdrawal_fee_rate fee_error_margin = none := by
  unfold update_global_configTransition
  rw [if_neg (fun hg => h hg.2.2.1)]

theorem update_global_config_aborts_if_InvalidFeeRate_1 (s : State) (signer : Pubkey) (ctx : ActionCtx) (deposit_fee_rate : Nat) (withdrawal_fee_rate : Nat) (fee_error_margin : Nat)
    (h : ¬(withdrawal_fee_rate ≤ 10000)) : update_global_configTransition s signer ctx deposit_fee_rate withdrawal_fee_rate fee_error_margin = none := by
  unfold update_global_configTransition
  rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem update_global_config_aborts_if_InvalidFeeRate_2 (s : State) (signer : Pubkey) (ctx : ActionCtx) (deposit_fee_rate : Nat) (withdrawal_fee_rate : Nat) (fee_error_margin : Nat)
    (h : ¬(fee_error_margin ≤ 10000)) : update_global_configTransition s signer ctx deposit_fee_rate withdrawal_fee_rate fee_error_margin = none := by
  unfold update_global_configTransition
  rw [if_neg (fun hg => h hg.2.2.2.2)]

-- ============================================================================
-- Cover properties — reachability (existential proofs)
-- ============================================================================

/-- sol_deposit_withdraw — trace [initialize, transact, transact] is reachable. -/
theorem cover_sol_deposit_withdraw : ∃ (s0 : State) (signer : Pubkey),
    ∃ (v0_0 : Nat) (v0_1 : Nat), ∃ (s1 : State), initializeTransition s0 signer v0_0 v0_1 = some s1 ∧
      ∃ (v1_0 : Int) (v1_1 : Nat), ∃ (s2 : State), transactTransition s1 signer v1_0 v1_1 = some s2 ∧
        ∃ (v2_0 : Int) (v2_1 : Nat), transactTransition s2 signer v2_0 v2_1 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let s0 : State := ⟨pk, 0, 0, 0⟩
  let s1 : State := ⟨pk, 1, 1, 0⟩
  let s2 : State := ⟨pk, 1, 1, 1⟩
  exact ⟨s0, pk, 1, 1, s1, by decide, 1, 1, s2, by decide, 1, 1, by decide⟩

/-- spl_deposit_withdraw — trace [initialize_tree_account_for_spl_token, transact_spl, transact_spl] is reachable. -/
theorem cover_spl_deposit_withdraw : ∃ (s0 : State) (signer : Pubkey),
    ∃ (v0_0 : Nat) (v0_1 : Nat), ∃ (s1 : State), initialize_tree_account_for_spl_tokenTransition s0 signer v0_0 v0_1 = some s1 ∧
      ∃ (v1_0 : Int) (v1_1 : Nat), ∃ (s2 : State), transact_splTransition s1 signer v1_0 v1_1 = some s2 ∧
        ∃ (v2_0 : Int) (v2_1 : Nat), transact_splTransition s2 signer v2_0 v2_1 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let s0 : State := ⟨pk, 0, 0, 0⟩
  let s1 : State := ⟨pk, 1, 1, 0⟩
  let s2 : State := ⟨pk, 1, 1, 1⟩
  exact ⟨s0, pk, 1, 1, s1, by decide, 1, 1, s2, by decide, 1, 1, by decide⟩

/-- admin_raises_sol_limit — trace [initialize, update_deposit_limit] is reachable. -/
theorem cover_admin_raises_sol_limit : ∃ (s0 : State) (signer : Pubkey) (ctx : ActionCtx),
    ∃ (v0_0 : Nat) (v0_1 : Nat), ∃ (s1 : State), initializeTransition s0 signer v0_0 v0_1 = some s1 ∧
      ∃ (v1_0 : Nat), update_deposit_limitTransition s1 signer ctx v1_0 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let ctxw : ActionCtx := ⟨pk⟩
  let s0 : State := ⟨pk, 0, 0, 0⟩
  let s1 : State := ⟨pk, 1, 1, 0⟩
  exact ⟨s0, pk, ctxw, 1, 1, s1, by decide, 1, by decide⟩

/-- admin_raises_spl_limit — trace [initialize_tree_account_for_spl_token, update_deposit_limit_for_spl] is reachable. -/
theorem cover_admin_raises_spl_limit : ∃ (s0 : State) (signer : Pubkey) (ctx : ActionCtx),
    ∃ (v0_0 : Nat) (v0_1 : Nat), ∃ (s1 : State), initialize_tree_account_for_spl_tokenTransition s0 signer v0_0 v0_1 = some s1 ∧
      ∃ (v1_0 : Nat), update_deposit_limit_for_splTransition s1 signer ctx v1_0 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let ctxw : ActionCtx := ⟨pk⟩
  let s0 : State := ⟨pk, 0, 0, 0⟩
  let s1 : State := ⟨pk, 1, 1, 0⟩
  exact ⟨s0, pk, ctxw, 1, 1, s1, by decide, 1, by decide⟩

end PrivacyCash
