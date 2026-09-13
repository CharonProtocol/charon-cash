#!/usr/bin/env python3
"""Check that the on-chain VERIFYING_KEY encodes artifacts/circuits/verifyingkey2.json.

The proving key and the JSON verifying key are compared separately with
`snarkjs zkey export verificationkey`; together the two checks bind the
committed .zkey to the key the program actually verifies against.
"""

import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]


def be32(value):
    return list(int(value).to_bytes(32, "big"))


def g1(point):
    x, y, z = point
    if z != "1":
        raise ValueError("G1 point is not affine")
    return be32(x) + be32(y)


def g2(point):
    # The alt_bn128 syscalls take G2 coordinates as (x.c1, x.c0, y.c1, y.c0).
    (x0, x1), (y0, y1), (z0, z1) = point
    if (z0, z1) != ("1", "0"):
        raise ValueError("G2 point is not affine")
    return be32(x1) + be32(x0) + be32(y1) + be32(y0)


def expected_key(vk):
    if vk["protocol"] != "groth16" or vk["curve"] != "bn128":
        raise ValueError("Expected a Groth16 BN254 verifying key")
    return {
        "nr_pubinputs": [vk["nPublic"]],
        "vk_alpha_g1": g1(vk["vk_alpha_1"]),
        "vk_beta_g2": g2(vk["vk_beta_2"]),
        "vk_gamme_g2": g2(vk["vk_gamma_2"]),
        "vk_delta_g2": g2(vk["vk_delta_2"]),
        "vk_ic": [g1(point) for point in vk["IC"]],
    }


def byte_list(text):
    return [int(n) for n in re.findall(r"\d+", text)]


def actual_key(source):
    start = source.index("pub const VERIFYING_KEY")
    body = source[start : source.index("\n};", start)]
    key = {}
    for field in ("vk_alpha_g1", "vk_beta_g2", "vk_gamme_g2", "vk_delta_g2"):
        match = re.search(rf"\b{field}:\s*\[([^\]]*)\]", body)
        if not match:
            raise ValueError(f"VERIFYING_KEY field {field} not found")
        key[field] = byte_list(match.group(1))
    match = re.search(r"\bnr_pubinputs:\s*(\d+)", body)
    if not match:
        raise ValueError("VERIFYING_KEY field nr_pubinputs not found")
    key["nr_pubinputs"] = [int(match.group(1))]
    ic = body[body.index("vk_ic:") :]
    key["vk_ic"] = [byte_list(point) for point in re.findall(r"\[([^\[\]]*)\]", ic)]
    return key


def main():
    vk_path = ROOT / "artifacts/circuits/verifyingkey2.json"
    expected = expected_key(json.loads(vk_path.read_text()))
    actual = actual_key((ROOT / "src/utils.rs").read_text())
    mismatches = [field for field in expected if expected[field] != actual.get(field)]
    if mismatches:
        print(f"src/utils.rs VERIFYING_KEY differs from {vk_path.name}: {mismatches}")
        return 1
    print(f"src/utils.rs VERIFYING_KEY matches {vk_path.name}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
