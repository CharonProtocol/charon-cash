import { useState } from "react"
import { TreePine } from "lucide-react"

import { api, BackendError } from "@/lib/api"
import { shortHash } from "@/lib/format"
import type { MerklePath, TreeState } from "@/lib/types"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel"

export function MerkleTreeCard() {
  const [treeKey, setTreeKey] = useState("sol")
  const [leafIndex, setLeafIndex] = useState("0")
  const [state, setState] = useState<TreeState | null>(null)
  const [path, setPath] = useState<MerklePath | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<"state" | "proof" | null>(null)

  const loadState = async () => {
    setLoading("state")
    setError(null)
    setPath(null)
    try {
      setState(await api.merkleState(treeKey.trim()))
    } catch (e) {
      setState(null)
      setError(fmt(e))
    } finally {
      setLoading(null)
    }
  }

  const loadProof = async () => {
    setLoading("proof")
    setError(null)
    setPath(null)
    try {
      setPath(await api.merkleProof(treeKey.trim(), Number(leafIndex)))
    } catch (e) {
      setError(fmt(e))
    } finally {
      setLoading(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TreePine className="size-4" /> Merkle tree
        </CardTitle>
        <CardDescription>
          Tree state served by the indexer-backed mirror, and Poseidon Merkle paths for the circuit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="tree-key">tree key</Label>
            <Input
              id="tree-key"
              value={treeKey}
              onChange={(e) => setTreeKey(e.target.value)}
              placeholder="sol or a mint base58"
            />
          </div>
          <Button onClick={loadState} disabled={loading === "state"}>
            {loading === "state" ? "…" : "Load state"}
          </Button>
        </div>

        {state && (
          <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">current root</span>
              <span className="font-mono text-xs">{shortHash(state.current_root, 12, 8)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">next leaf index</span>
              <span className="font-mono">{state.next_leaf_index}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">leaf count</span>
              <span className="font-mono">{state.leaf_count}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">known roots</span>
              <span className="font-mono">{state.known_roots.length}</span>
            </div>
          </div>
        )}

        <div className="border-t pt-3">
          <Label className="mb-1.5 block">Merkle proof for leaf</Label>
          <div className="flex items-end gap-2">
            <Input
              value={leafIndex}
              onChange={(e) => setLeafIndex(e.target.value)}
              placeholder="leaf index"
              inputMode="numeric"
              className="w-32"
            />
            <Button variant="secondary" onClick={loadProof} disabled={loading === "proof"}>
              {loading === "proof" ? "…" : "Get proof"}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Returns 26 path elements + 26 path indices (height-26 Poseidon tree).
          </p>
        </div>

        {path && (
          <JsonBlock
            value={{ path_elements: path.path_elements, path_indices: path.path_indices }}
          />
        )}
        {error && <ErrorBlock code="REQUEST_FAILED" message={error} />}
      </CardContent>
    </Card>
  )
}

function fmt(e: unknown): string {
  if (e instanceof BackendError) return `${e.code}: ${e.message}`
  return (e as Error).message
}
