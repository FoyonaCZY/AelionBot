export interface TokenCalibration {version:2;factor:number;samples:number[];}
export function readCalibration(raw?:string):TokenCalibration{
 try{const value=JSON.parse(raw||'');if(value.version===2&&Number.isFinite(value.factor)&&value.factor>=1&&value.factor<=4&&Array.isArray(value.samples)&&value.samples.every((sample:unknown)=>typeof sample==='number'&&Number.isFinite(sample)&&sample>0&&sample<=16))return {version:2,factor:value.factor,samples:value.samples.slice(-12)};}catch{}
 return {version:2,factor:1,samples:[]};
}
export function observeCalibration(state:TokenCalibration,reported:number,estimated:number,appliedFactor:number):TokenCalibration{
 if(!Number.isSafeInteger(reported)||reported<=0||!Number.isFinite(estimated)||estimated<=0||!Number.isFinite(appliedFactor)||appliedFactor<1||appliedFactor>4)return state;
 const ratio=reported/(estimated/appliedFactor);if(!Number.isFinite(ratio)||ratio<=0||ratio>16)return state;
 const samples=[...state.samples,ratio].slice(-12),sorted=[...samples].sort((a,b)=>a-b),target=Math.min(4,Math.max(1,sorted[Math.ceil(sorted.length*.9)-1]*1.08));
 // Raise immediately when actual usage demands it. Lower only after several
 // observations, gradually, and never below the uncalibrated estimate.
 const factor=target>=state.factor?target:samples.length>=5?Math.max(target,state.factor*.9):state.factor;
 return {version:2,factor,samples};
}


// Display estimates are separate from the conservative compression/output budget above.
const validRatio=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=.1&&value<=4;
function displaySamples(raw?:string):number[]{
 try{const value=JSON.parse(raw||'null');if(value?.version===1&&Array.isArray(value.samples))return value.samples.filter(validRatio).slice(-12);}catch{}
 return [];
}
export function displayCalibration(raw?:string,fallback?:number){
 const samples=displaySamples(raw).sort((a,b)=>a-b);
 if(samples.length){const middle=Math.floor(samples.length/2);return {factor:samples.length%2?samples[middle]:(samples[middle-1]+samples[middle])/2,calibrated:true};}
 return {factor:validRatio(fallback)?fallback:1,calibrated:validRatio(fallback)};
}
export function recordDisplayCalibration(raw:string|undefined,reported:number,estimated:number):string|undefined{
 if(!Number.isSafeInteger(reported)||reported<64||!Number.isFinite(estimated)||estimated<1024||!validRatio(reported/estimated))return;
 return JSON.stringify({version:1,samples:[...displaySamples(raw),reported/estimated].slice(-12)});
}
