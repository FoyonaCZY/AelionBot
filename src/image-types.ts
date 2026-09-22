/** Image generation contract shared by the renderer and the main process. Adding a protocol means adding one descriptor, not editing heuristics. */
export const IMAGE_PROTOCOLS=['openai-images','gemini-images','responses-images','sd-webui'] as const;
export type ImageProtocol=typeof IMAGE_PROTOCOLS[number];

export const IMAGE_ASPECTS=['1:1','16:9','9:16','4:3','3:4','3:2','2:3'] as const;
export type ImageAspect=typeof IMAGE_ASPECTS[number];

export const IMAGE_QUALITIES=['auto','low','medium','high'] as const;
export type ImageQuality=typeof IMAGE_QUALITIES[number];

/** Closed set of recovery actions. Every image failure carries exactly one; callers branch on this, never on wording or HTTP status. */
export const IMAGE_NEXT_STEPS=['revise-request','switch-model','open-settings','sign-in','add-credit','retry-later','unsupported','contact-support'] as const;
export type ImageNextStep=typeof IMAGE_NEXT_STEPS[number];

export interface ImageCapabilities {aspect:boolean;size:boolean;quality:boolean;reference:boolean;negativePrompt:boolean;seed:boolean;}
export interface ImageProtocolInfo {id:ImageProtocol|'auto';label:string;hint:string;endpoint:string;capabilities:ImageCapabilities;}

/** Per-model image defaults stored in the provider catalog. */
export interface ImageModelDefaults {aspect?:ImageAspect;quality?:ImageQuality;negativePrompt?:string;}

export function asImageProtocol(value:unknown):ImageProtocol|undefined{
  return typeof value==='string'&&(IMAGE_PROTOCOLS as readonly string[]).includes(value)?value as ImageProtocol:undefined;
}
export function asImageAspect(value:unknown):ImageAspect|undefined{
  return typeof value==='string'&&(IMAGE_ASPECTS as readonly string[]).includes(value)?value as ImageAspect:undefined;
}
export function asImageQuality(value:unknown):ImageQuality|undefined{
  return typeof value==='string'&&(IMAGE_QUALITIES as readonly string[]).includes(value)?value as ImageQuality:undefined;
}

/** Well-known bucket resolutions. Exact where the ratio divides evenly, otherwise the nearest standard diffusion bucket. */
export const ASPECT_DIMENSIONS:Record<ImageAspect,{width:number;height:number}>={
  '1:1':{width:1024,height:1024},
  '16:9':{width:1344,height:768},
  '9:16':{width:768,height:1344},
  '4:3':{width:1152,height:864},
  '3:4':{width:864,height:1152},
  '3:2':{width:1216,height:832},
  '2:3':{width:832,height:1216},
};
export function aspectDimensions(aspect:ImageAspect='1:1'){return ASPECT_DIMENSIONS[aspect]||ASPECT_DIMENSIONS['1:1'];}

/** What the user sees when a generation fails. Diagnostics stay in the tool trace; this never names a provider or protocol. */
export const IMAGE_NEXT_STEP_MESSAGE:Record<ImageNextStep,string>={
  'revise-request':'请求未通过内容审核，请修改描述或参考图。',
  'switch-model':'当前模型不支持生图，请在设置中更换模型。',
  'open-settings':'生图模型未配置 API Key。',
  'sign-in':'生图服务凭证已失效，请更新 API Key。',
  'add-credit':'生图额度用完，请充值或更换模型。',
  'retry-later':'生图服务暂时不可用，请稍后重试。',
  'unsupported':'当前任务不能生成图片。',
  'contact-support':'图片生成失败，请查看执行记录。',
};
/** What the agent should do. Only `retry-later` may be retried automatically; everything else would re-bill without changing the outcome. */
export const IMAGE_NEXT_STEP_GUIDANCE:Record<ImageNextStep,string>={
  'revise-request':'改写提示词，去掉被拒绝的内容后重试一次；仍失败则改用占位图并说明。',
  'switch-model':'不要重试同一个模型。改用占位图完成排版，并告诉用户需要更换生图模型。',
  'open-settings':'不要重试。改用占位图完成排版，并告诉用户去设置里配置生图模型。',
  'sign-in':'不要重试。改用占位图完成排版，并告诉用户密钥已失效。',
  'add-credit':'不要重试，重试会重复计费。改用占位图完成排版。',
  'retry-later':'可以原样重试一次；再次失败就改用占位图完成排版。',
  'unsupported':'不要重试。改用占位图或纯 CSS/SVG 构图完成设计。',
  'contact-support':'不要重试。改用占位图完成排版，并把失败如实写进回复。',
};
/** Only a protocol mismatch justifies probing another adapter in `auto` mode. Auth, billing and policy failures are terminal. */
export function probesNextProtocol(nextStep:ImageNextStep){return nextStep==='switch-model'||nextStep==='unsupported';}
export function retryableImageFailure(nextStep:ImageNextStep){return nextStep==='retry-later';}
