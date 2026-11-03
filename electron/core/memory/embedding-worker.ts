// Runs the local embedding model on its own thread. Built as an ES module next to the ONNX Runtime WASM files, which
// it finds by its own location; see scripts/build.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web';

const MAX_TOKENS = 256;
const { modelDir } = workerData as { modelDir: string };
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = pathToFileURL(dirname(fileURLToPath(import.meta.url)) + '/').href;

const read = (name: string) => readFileSync(join(modelDir, name));
const tokenizer = new Tokenizer(
  JSON.parse(read('tokenizer.json').toString()),
  JSON.parse(read('tokenizer_config.json').toString()),
);
const session = ort.InferenceSession.create(read('model.onnx'), { executionProviders: ['wasm'] });

/** One normalized vector: the model's first token (CLS), as the BGE models are meant to be used. */
async function embedOne(text: string) {
  const model = await session,
    ids = tokenizer.encode(text).ids.slice(0, MAX_TOKENS),
    length = ids.length,
    shape = [1, length],
    output = await model.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), shape),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(length).fill(1n), shape),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(length), shape),
    }),
    hidden = output[model.outputNames[0]],
    size = hidden.dims[2],
    data = hidden.data as Float32Array,
    vector = new Float32Array(size);
  let norm = 0;
  for (let i = 0; i < size; i++) norm += data[i] * data[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < size; i++) vector[i] = data[i] / norm;
  return vector;
}
parentPort!.on('message', async ({ id, texts }: { id: number; texts: string[] }) => {
  try {
    const vectors: Float32Array[] = [];
    for (const text of texts) vectors.push(await embedOne(text));
    parentPort!.postMessage({ id, vectors });
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message });
  }
});
