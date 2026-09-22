/** Shared argument handling for the two image tools, so `generate_image` and `design_image` accept the same surface. */
import type {ModelConfig} from '../../src/shared';
import {asImageAspect,asImageQuality} from '../../src/image-types';
import {imageExtension,type ImageJob} from './image-generation';
import type {ImageReference} from './image-protocols';

const SUPPORTED_REFERENCE=/^image\/(png|jpeg|webp|gif)$/;

/** Tool arguments win; the model catalog supplies the default when the agent did not choose. */
export function imageJobFromArgs(args:Record<string,unknown>,config:Pick<ModelConfig,'imageAspect'|'imageQuality'>,resolveReference?:(ids:string[])=>ImageReference[]):ImageJob{
  const ids=Array.isArray(args.referenceAttachmentIds)?args.referenceAttachmentIds.filter(value=>typeof value==='string').slice(0,4) as string[]:[];
  const reference=ids.length&&resolveReference?resolveReference(ids):undefined;
  const negative=typeof args.negativePrompt==='string'?args.negativePrompt.trim():'';
  return {
    prompt:typeof args.prompt==='string'?args.prompt:'',
    aspect:asImageAspect(args.aspect)||config.imageAspect,
    quality:asImageQuality(args.quality)||config.imageQuality,
    ...(negative?{negativePrompt:negative.slice(0,1000)}:{}),
    ...(reference?.length?{reference}:{}),
  };
}

/** Names the file after what the provider actually returned rather than what the model guessed. */
export function imageFileName(requested:unknown,mediaType:string,fallback='generated'){
  const raw=typeof requested==='string'&&requested.trim()?requested.trim():fallback;
  const base=raw.replace(/\.[a-z0-9]{1,5}$/i,'').replace(/[^\p{L}\p{N}._-]/gu,'-').replace(/^[-.]+/,'').slice(0,60)||fallback;
  return `${base}.${imageExtension(mediaType)}`;
}

export function imageReferences(attachments:Array<{id:string;name:string;mime:string}>,bytes:(id:string)=>Buffer):ImageReference[]{
  return attachments.map(file=>{
    if(!SUPPORTED_REFERENCE.test(file.mime))throw Error(`参考图 ${file.name} 不是受支持的图片格式`);
    return {bytes:bytes(file.id),mediaType:file.mime,name:file.name};
  });
}
