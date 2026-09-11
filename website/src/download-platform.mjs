export const downloadBuilds=['windows-x64','mac-arm64','mac-x64'];

const files={
  'windows-x64':version=>`AelionBot-Setup-${version}-x64.exe`,
  'mac-arm64':version=>`AelionBot-${version}-mac-arm64.dmg`,
  'mac-x64':version=>`AelionBot-${version}-mac-x64.dmg`,
};

export function downloadHref(id,repository,version){
  if(id==='releases')return `${repository}/releases/latest`;
  return `${repository}/releases/download/v${version}/${files[id](version)}`;
}

export function downloadIcon(id){
  return id==='windows-x64'?'windows':id==='mac-arm64'||id==='mac-x64'?'mac':'down';
}

export function recommendDownload(platform){
  let primary='releases';
  if(platform.os==='windows')primary='windows-x64';
  else if(platform.os==='mac')primary=platform.arch==='arm64'?'mac-arm64':'mac-x64';
  return {primary,alternatives:downloadBuilds.filter(id=>id!==primary)};
}

export function detectDownloadPlatform(hints={}){
  const os=detectOs(hints);
  return {os,arch:detectArch(os,hints)};
}

function detectOs(hints){
  const ua=hints.userAgent||'';
  const platform=hints.platform||'';
  const ch=String(hints.userAgentData?.platform||'').toLowerCase();
  const touch=hints.maxTouchPoints||0;
  if(ch==='android'||/Android/i.test(ua))return 'android';
  if(ch==='ios'||/iPhone|iPod/i.test(ua)||/iPad/i.test(ua)||((/Macintosh|Mac OS X/i.test(ua)||/^Mac/i.test(platform))&&touch>1))return 'ios';
  if(ch==='windows'||/Windows/i.test(ua)||/^Win/i.test(platform))return 'windows';
  if(ch==='macos'||/Macintosh|Mac OS X/i.test(ua)||/^Mac/i.test(platform))return 'mac';
  if(ch==='linux'||ch==='chrome os'||/Linux|CrOS/i.test(ua)||/^Linux/i.test(platform))return 'linux';
  return 'unknown';
}

function detectArch(os,hints){
  const ua=hints.userAgent||'';
  const platform=hints.platform||'';
  const architecture=String(hints.userAgentData?.architecture||'').toLowerCase();
  if(architecture==='arm'||architecture==='arm64'||architecture==='aarch64')return 'arm64';
  if(architecture==='x86'||architecture==='x86_64'||architecture==='x64'||architecture==='amd64'||architecture==='ia32')return 'x64';
  if(/arm64|aarch64/i.test(ua)||/arm64|aarch64/i.test(platform))return 'arm64';
  if(/WOW64|Win64|x64|amd64|x86_64/i.test(ua)||/x86_64|amd64|Win64/i.test(platform))return 'x64';
  const renderer=hints.webglRenderer||'';
  if(os==='mac'){
    if(/Apple\s*M\d|Apple GPU|Apple7|Apple8|Apple9/i.test(renderer)&&!/Intel|AMD|NVIDIA|Radeon/i.test(renderer))return 'arm64';
    if(/Intel|AMD|Radeon|NVIDIA/i.test(renderer))return 'x64';
  }
  if(os==='windows')return 'x64';
  return 'unknown';
}

export function navigatorHints(nav=typeof navigator==='undefined'?undefined:navigator){
  if(!nav)return {};
  const hints={userAgent:nav.userAgent,platform:nav.platform,maxTouchPoints:nav.maxTouchPoints||0,webglRenderer:readWebglRenderer()};
  if(nav.userAgentData)hints.userAgentData={platform:nav.userAgentData.platform,mobile:nav.userAgentData.mobile};
  return hints;
}

export async function readBrowserDownloadHints(){
  const hints=navigatorHints();
  const uad=typeof navigator==='undefined'?undefined:navigator.userAgentData;
  if(uad?.getHighEntropyValues){
    try{
      const values=await uad.getHighEntropyValues(['architecture','bitness','platform']);
      hints.userAgentData={platform:values.platform||uad.platform,mobile:uad.mobile,architecture:values.architecture,bitness:values.bitness};
    }catch{}
  }
  if(!hints.webglRenderer)hints.webglRenderer=readWebglRenderer();
  return hints;
}

function readWebglRenderer(){
  if(typeof document==='undefined')return '';
  try{
    const canvas=document.createElement('canvas');
    const gl=canvas.getContext('webgl')||canvas.getContext('experimental-webgl');
    if(!gl||typeof gl.getParameter!=='function')return '';
    const info=typeof gl.getExtension==='function'?gl.getExtension('WEBGL_debug_renderer_info'):null;
    if(info)return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)||'');
    return String(gl.getParameter(gl.RENDERER)||'');
  }catch{
    return '';
  }
}
