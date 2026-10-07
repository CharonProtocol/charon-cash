import { init, compress, decompress } from '@bokuweb/zstd-wasm';

async function main() {
  await init();
  await init();
  console.log("Success");
}
main();
