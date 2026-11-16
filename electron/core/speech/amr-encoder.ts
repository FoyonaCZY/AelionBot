// AMR-NB, the voice message format WeCom takes from bots. The encoder is opencore-amr compiled to asm.js, as
// benz-amr-recorder ships it for a Web Worker. It runs in the hidden codec page rather than the main process: a minute
// of speech takes about a second to encode.
// eslint-disable-next-line no-restricted-imports -- the package's own src folder, not the renderer's
import amrWorker from 'benz-amr-recorder/src/amrnb.js';

let script: string | undefined;

/**
 * Script text that defines `encodeAmr(samples)`: 8 kHz mono float samples to an AMR-NB file at 12.2 kbit/s. The
 * worker answers through `self.postMessage`, which a local `self` catches. It leaves out the last frame it is given,
 * so a frame of silence goes after the sound.
 */
export function amrEncoderScript() {
  return (script ??= `const encodeAmr=(()=>{let result;const self={postMessage:message=>{result=message.amr}};
(${amrWorker.toString()})();
return samples=>{const frames=Math.ceil(samples.length/160)+1,padded=new Float32Array(frames*160);padded.set(samples);
self.onmessage({data:{command:'encode',samples:padded,sampleRate:8000}});return result}})();`);
}
