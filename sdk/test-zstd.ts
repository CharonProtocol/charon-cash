import { init, compress, decompress } from '@bokuweb/zstd-wasm';

async function main() {
  await init();
  const data = new TextEncoder().encode("Hello world! Hello world!");
  const compressed = compress(data);
  const decompressed = decompress(compressed);
  console.log(new TextDecoder().decode(decompressed));
}
main();
