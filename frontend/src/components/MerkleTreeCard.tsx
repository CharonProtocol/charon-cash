import { useEffect, useState } from "react"
import { RefreshCw, TreePine } from "lucide-react"
import { toast } from "sonner"

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

export function MerkleTreeCard({ refreshKey = 0 }: { refreshKey?: number }) {
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

  useEffect(() => {
    if (refreshKey > 0) void loadState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <TreePine className="size-4" /> Merkle tree
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={loadState}
            disabled={loading === "state"}
            title="Refresh tree state"
          >
            <RefreshCw className={loading === "state" ? "size-4 animate-spin" : "size-4"} />
          </Button>
        </CardTitle>
        <CardDescription>
          Indexer-backed Poseidon tree (height 26). Use <code className="text-xs">sol</code> or
          an SPL mint address as the tree key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="tree-key">Tree key</Label>
            <Input
              id="tree-key"
              value={treeKey}
              onChange={(e) => setTreeKey(e.target.value)}
              placeholder="sol or mint base58"
              className="font-mono text-xs"
            />
          </div>
          <Button onClick={loadState} disabled={loading === "state"}>
            {loading === "state" ? (
              <>
                <RefreshCw className="mr-1.5 size-3.5 animate-spin" /> Loading
              </>
            ) : (
              "Load state"
            )}
          </Button>
        </div>

        {state && (
          <div className="space-y-2 rounded-xl border border-border bg-secondary/40 p-3 text-sm">
            <Row
              label="Current root"
              value={shortHash(state.current_root, 12, 8)}
              full={state.current_root}
            />
            <Row label="Next leaf index" value={String(state.next_leaf_index)} />
            <Row label="Leaf count" value={String(state.leaf_count)} />
            <Row label="Known roots" value={String(state.known_roots.length)} />
          </div>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <Label className="block">Merkle proof for leaf</Label>
          <div className="flex flex-wrap items-end gap-2">
            <Input
              value={leafIndex}
              onChange={(e) => setLeafIndex(e.target.value)}
              placeholder="leaf index"
              inputMode="numeric"
              className="w-28 font-mono"
            />
            <Button variant="secondary" onClick={loadProof} disabled={loading === "proof"}>
              {loading === "proof" ? (
                <>
                  <RefreshCw className="mr-1.5 size-3.5 animate-spin" /> Fetching
                </>
              ) : (
                "Get proof"
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Returns 26 path elements + indices for the circuit witness.
          </p>
        </div>

        {path && (
          <div className="space-y-2">
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard?.writeText(JSON.stringify(path, null, 2))
                  toast.success("Proof JSON copied")
                }}
              >
                Copy proof JSON
              </Button>
            </div>
            <JsonBlock
              value={{ path_elements: path.path_elements, path_indices: path.path_indices }}
            />
          </div>
        )}
        {error && <ErrorBlock code="REQUEST_FAILED" message={error} />}
      </CardContent>
    </Card>
  )
}

function Row({
  label,
  value,
  full,
}: {
  label: string
  value: string
  full?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <button
        type="button"
        className="font-mono text-xs text-foreground hover:text-primary"
        title={full ?? value}
        onClick={() => {
          if (!full) return
          navigator.clipboard?.writeText(full)
          toast.success("Copied")
        }}
      >
        {value}
      </button>
    </div>
  )
}

function fmt(e: unknown): string {
  if (e instanceof BackendError) return `${e.code}: ${e.message}`
  return (e as Error).message
}
