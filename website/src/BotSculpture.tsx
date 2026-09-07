import {useId} from 'react';

export const tones={
  violet:['#b29af8','#8b6bea','#5136a0'],
  blue:['#94cbfd','#518fe3','#3252a5'],
  mint:['#9ad5c8','#51a28e','#2a625c'],
  peach:['#f0bda8','#d48994','#934d8e'],
};
export type BotTone=keyof typeof tones;

export function BotSculpture({tone='violet',className='',flat=false}:{tone?:BotTone;className?:string;flat?:boolean}){
  const id=useId().replaceAll(':',''),colors=tones[tone];
  return <svg className={`bot-sculpture ${className}`} viewBox="0 0 120 120" aria-hidden="true">
    <defs><radialGradient id={`${id}-body`} cx=".29" cy=".18" r=".95"><stop stopColor={colors[0]}/><stop offset=".48" stopColor={colors[1]}/><stop offset="1" stopColor={colors[2]}/></radialGradient><linearGradient id={`${id}-rim`} x2=".7" y2="1"><stop stopColor="white" stopOpacity=".22"/><stop offset=".55" stopColor="white" stopOpacity="0"/></linearGradient></defs>
    <path d="M62 6C94 6 112 28 112 62C112 92 92 112 58 112C24 112 8 92 8 60C8 28 30 6 62 6Z" fill={flat?colors[1]:`url(#${id}-body)`} stroke={flat?'none':`url(#${id}-rim)`} strokeWidth=".7"/>
    <g className="bot-gaze"><g className="bot-blink"><ellipse cx="48" cy="52" rx="5" ry="10" fill="white" transform="rotate(-14 48 52)"/><ellipse cx="72" cy="48" rx="5" ry="10" fill="white" transform="rotate(-14 72 48)"/></g></g>
  </svg>;
}
