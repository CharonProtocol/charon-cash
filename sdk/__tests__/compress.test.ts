import { describe, expect, test } from "bun:test"

import { compressG1, compressG2 } from "../src/compress"

// Real proofs from the prover crate: compressed by arkworks, raw = the
// program's own alt_bn128 decompression of those bytes.
const VECTORS = [
  {
    "raw": {
      "a": "062fecab3c6417b247b512ae42c7e3676c017f36a4c3dc70576b100632b615e22cb5c8ad2b7aff31508ce68aa893572e4beae4085586acaf08d2de8062849d1c",
      "b": "0264cb7df1a9072341c9245a0fc7a83994cf34d727c8ce4def260b2b0fb598a1170e51b2f37a1f86b93981f24dee423b6c67954dadbd158718e9c0406db1bbaa1ad8adb17de4f680a7a163d71799bda8b8384ab6046bd4c8b5f2d951d04061610ccc7fce6e59c965bf1816414fc9e214f9111fe7e11a46d5d8dd8260d1950b3a",
      "c": "131e582803130f72436ff8eaa5959ae781d1efe75f24b600bdad3a7748f04a2008ad43f531c790215edfaa6875ddb123c899b3f51e769afde321916eb7b6b750"
    },
    "compressed": {
      "a": "862fecab3c6417b247b512ae42c7e3676c017f36a4c3dc70576b100632b615e2",
      "b": "8264cb7df1a9072341c9245a0fc7a83994cf34d727c8ce4def260b2b0fb598a1170e51b2f37a1f86b93981f24dee423b6c67954dadbd158718e9c0406db1bbaa",
      "c": "131e582803130f72436ff8eaa5959ae781d1efe75f24b600bdad3a7748f04a20"
    }
  },
  {
    "raw": {
      "a": "07135b341893844729c69620c4e9d1757b3c5f402b4ffa8250fb88a3d33d32b31d687d416848aea30991ab5db8283c647c6434d436c7509b05a9b20087e0fe13",
      "b": "0598a39f9e3da3545c42ab2bc799e4a8b72b97153a8af99cdf014db38a3cc74516ca07c0cc21b4d23c7b4c28f6ee346c6f38e15793ec21e2838874730ad76dbb0dcc97557b86981271545f3a4426f71bdd0c6e7a173050a523cdc2a9a7a29e870d499672f5aca5f583de6c785602a2741d4a778de80ccccaef0da1a1da28d24e",
      "c": "093f93e39d264de1ec44a32555bb9167f8286da2c371d4cda4a9a4ac6690bf130e5af8450654cdae5161922ecf049d78336e4e1842f59efd526f3abaab15f563"
    },
    "compressed": {
      "a": "87135b341893844729c69620c4e9d1757b3c5f402b4ffa8250fb88a3d33d32b3",
      "b": "0598a39f9e3da3545c42ab2bc799e4a8b72b97153a8af99cdf014db38a3cc74516ca07c0cc21b4d23c7b4c28f6ee346c6f38e15793ec21e2838874730ad76dbb",
      "c": "093f93e39d264de1ec44a32555bb9167f8286da2c371d4cda4a9a4ac6690bf13"
    }
  },
  {
    "raw": {
      "a": "06400c8b66c587f8cc469271654dc2bcab5c21025facaf24d479024ffb0e943c1f9614b0d7d3d1d63f24df84a10f21db3365d4da2ff178536e5f1bd7d3656b93",
      "b": "12b906f096f87a3743abc79aa8dbe25aab329205b06d951e408443fcdb5672f3260da18dd1aae9f195f25da8e1120a84280e8747de8be861b6773e77d620a24e27124d5beca6ac060abf157ca43583624dac5da0ab989c186e47e9533c6993d8004bd09251b5e9cab420485101ae56f3c91110bda955b76ed56e597fcb58f570",
      "c": "15a3bbc6628b9156db8b798e93cdd10db0f0cca19805466a900719d81bc4730d1e7814a6e7f335c1d5658a3f9165ee42263f9dd008c8ae3de9d14b0133820e7c"
    },
    "compressed": {
      "a": "86400c8b66c587f8cc469271654dc2bcab5c21025facaf24d479024ffb0e943c",
      "b": "92b906f096f87a3743abc79aa8dbe25aab329205b06d951e408443fcdb5672f3260da18dd1aae9f195f25da8e1120a84280e8747de8be861b6773e77d620a24e",
      "c": "95a3bbc6628b9156db8b798e93cdd10db0f0cca19805466a900719d81bc4730d"
    }
  }
]

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"))
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex")

describe("proof point compression (program format)", () => {
  test.each(VECTORS.map((v, i) => [i, v] as const))("proof %d", (_i, v) => {
    expect(toHex(compressG1(hex(v.raw.a)))).toBe(v.compressed.a)
    expect(toHex(compressG2(hex(v.raw.b)))).toBe(v.compressed.b)
    expect(toHex(compressG1(hex(v.raw.c)))).toBe(v.compressed.c)
  })
})
