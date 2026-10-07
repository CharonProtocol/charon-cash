import { describe, expect, it } from "bun:test"

import { refreshTreeKeys, shouldRecheckSpent } from "../src/client"
import { SOL_TREE_KEY } from "../src/constants"

describe("refreshNotes policy", () => {
  const mints = [{ mint: "MINTA" }, { mint: "MINTB" }]

  it("discovery sweeps the SOL tree plus every supported mint", () => {
    expect(refreshTreeKeys(undefined, mints)).toEqual([SOL_TREE_KEY, "MINTA", "MINTB"])
    // no relayer info yet: still the SOL tree
    expect(refreshTreeKeys({}, undefined)).toEqual([SOL_TREE_KEY])
  })

  it("a quick poll scans only the tree the caller is paying", () => {
    // payroll mid-run: change notes land in the paid tree, and the engine
    // knows which one — other trees have nothing new to discover
    expect(refreshTreeKeys({ quick: SOL_TREE_KEY }, mints)).toEqual([SOL_TREE_KEY])
    expect(refreshTreeKeys({ quick: "spl:MINTB" }, mints)).toEqual(["spl:MINTB"])
  })

  it("the spent-recheck runs forced at start, ambient at most every 15s, never on quick", () => {
    // run-start verification: the phantom-balance guard / rescue sweep
    expect(shouldRecheckSpent({ recheckSpent: true }, 0, 1_000)).toBe(true)
    // ambient discovery: first-ever refresh (cursor at 0) and the 15s gate
    expect(shouldRecheckSpent(undefined, 0, 16_000)).toBe(true)
    expect(shouldRecheckSpent(undefined, 0, 15_000)).toBe(false)
    expect(shouldRecheckSpent(undefined, 10_000, 16_000)).toBe(false)
    // a mid-run quick poll never re-derives old nullifiers: a freshly
    // landed note cannot be spent, and the engine tracks its own spends
    expect(shouldRecheckSpent({ quick: SOL_TREE_KEY }, 0, 999_999)).toBe(false)
    // fromScratch rescans stay recheck-free (they only rebuild the set)
    expect(shouldRecheckSpent({ fromScratch: true }, 0, 999_999)).toBe(false)
  })
})
