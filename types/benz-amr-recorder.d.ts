declare module 'benz-amr-recorder/src/amrnb.js' {
  /** The body of the package's AMR worker: run as a script, it answers `self.onmessage` with `self.postMessage`. */
  const worker: () => void;
  export default worker;
}
