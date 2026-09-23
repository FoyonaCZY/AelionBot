declare module 'wawoff2/decompress.js' {
 const decompress:(bytes:Uint8Array)=>Promise<Uint8Array>;
 export default decompress;
}
