/** Monotonic milliseconds since this attempt began; retries have separate records.
 * The first attempt includes ModelClient preparation, not the earlier harness work.
 * Missing fields mean that phase was never reached (e.g. tool-only output has no text).
 */
export interface ModelRequestTiming {
  preparationMs?:number; // First transport dispatch, including local serialization.
  responseMs?:number; // First response/headers, including connect, upload and server wait.
  firstEventMs?:number; // First parsed provider event (possibly reasoning or tool data).
  firstTextMs?:number; // First text delivered to the reply callback; not necessarily all output tokens.
  firstToolMs?:number;
  lastEventMs?:number;
  responseBytes?:number;
  outputEvents?:number;
  toolArgumentChars?:number;
  completed?:boolean;
  totalMs:number;
}
