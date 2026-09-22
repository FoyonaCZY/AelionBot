/** Turns any image failure into exactly one actionable next step. Callers branch on `nextStep`, never on wording or HTTP status. */
import {IMAGE_NEXT_STEP_GUIDANCE,IMAGE_NEXT_STEP_MESSAGE,type ImageNextStep,type ImageProtocol} from '../../src/image-types';

const POLICY=/content[_\s-]?polic|safety|moderat|nsfw|prohibited|not allowed|violat|blocked|censor|sensitive|敏感|违规|审核|内容政策/i;
const QUOTA=/quota|billing|credit|insufficient|balance|payment required|exceeded your current|arrears|余额|额度|欠费|计费/i;
const RATE=/rate[_\s-]?limit|too many requests|overload|capacity|server busy|请求过于频繁|限流/i;
const MISMATCH=/model|endpoint|not found|unsupported|unknown|unrecognized|no such|does not exist|not support|invalid url|404/i;
const REFERENCE=/input[_\s-]?image|reference|mask|参考图/i;

/** Drops anything shaped like a credential before a provider message reaches the execution ledger. */
export function scrubImageDetail(text:string){
  return text
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g,'***')
    .replace(/\b(?:Bearer|x-api-key|api[_-]?key)\s*[:=]?\s*[A-Za-z0-9_.-]{8,}/gi,'***')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g,'***')
    .slice(0,400);
}

export class ImageGenerationError extends Error {
  readonly nextStep:ImageNextStep;
  readonly subject?:'prompt'|'reference';
  readonly protocol?:ImageProtocol;
  readonly status?:number;
  readonly detail?:string;
  constructor(nextStep:ImageNextStep,options:{subject?:'prompt'|'reference';protocol?:ImageProtocol;status?:number;detail?:string}={}){
    super(IMAGE_NEXT_STEP_MESSAGE[nextStep]);
    this.name='ImageGenerationError';this.nextStep=nextStep;
    this.subject=options.subject;this.protocol=options.protocol;this.status=options.status;
    this.detail=options.detail?scrubImageDetail(options.detail):undefined;
  }
  get guidance(){return IMAGE_NEXT_STEP_GUIDANCE[this.nextStep];}
  /** Shape handed to the model: the user-facing sentence, the closed-set step, and what to do about it. */
  toolResult(){
    return {error:this.message,nextStep:this.nextStep,guidance:this.guidance,
      ...(this.subject?{subject:this.subject}:{}),...(this.status?{status:this.status}:{}),...(this.detail?{detail:this.detail}:{})};
  }
  withProtocol(protocol:ImageProtocol){
    return this.protocol?this:new ImageGenerationError(this.nextStep,{subject:this.subject,protocol,status:this.status,detail:this.detail});
  }
}

/** HTTP response → next step. `hasKey` separates "never configured" from "configured but rejected". */
export function classifyImageResponse(status:number,body:string,hasKey:boolean):{nextStep:ImageNextStep;subject?:'prompt'|'reference'}{
  const policySubject=REFERENCE.test(body)?'reference' as const:'prompt' as const;
  if(status===401)return {nextStep:hasKey?'sign-in':'open-settings'};
  if(status===402)return {nextStep:'add-credit'};
  if(status===403)return POLICY.test(body)?{nextStep:'revise-request',subject:policySubject}:{nextStep:hasKey?'sign-in':'open-settings'};
  if(status===404)return {nextStep:'switch-model'};
  if(status===408)return {nextStep:'retry-later'};
  if(status===413)return {nextStep:'revise-request',subject:'reference'};
  if(status===429)return QUOTA.test(body)?{nextStep:'add-credit'}:{nextStep:'retry-later'};
  if(status>=500)return {nextStep:'retry-later'};
  if(status===400||status===422){
    if(POLICY.test(body))return {nextStep:'revise-request',subject:policySubject};
    if(QUOTA.test(body))return {nextStep:'add-credit'};
    if(RATE.test(body))return {nextStep:'retry-later'};
    // A plain 400 from an images endpoint almost always means this model does not speak this protocol.
    if(MISMATCH.test(body)||!body.trim())return {nextStep:'switch-model'};
    return {nextStep:'switch-model'};
  }
  return {nextStep:'contact-support'};
}

/** Transport-level failure (DNS, TLS, timeout, reset) → next step. Abort is the caller's concern and is rethrown upstream. */
export function classifyImageTransport(error:unknown):ImageNextStep{
  const text=(error as Error)?.message||'';
  if(/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i.test(text))return 'retry-later';
  return 'contact-support';
}

export function isImageGenerationError(value:unknown):value is ImageGenerationError{return value instanceof ImageGenerationError;}
