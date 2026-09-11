export const supportedLanguages=['en','zh-CN','zh-TW'];
export function resolveSiteLanguage(search='',saved=null){
  const requested=new URLSearchParams(search).get('lang');
  return requested&&supportedLanguages.includes(requested)?requested:saved&&supportedLanguages.includes(saved)?saved:'en';
}
export function readSiteLanguage(){
  let saved=null;
  try{saved=localStorage.getItem('aelion-site-language');}catch{}
  return resolveSiteLanguage(location.search,saved);
}
export function rememberSiteLanguage(language){
  try{localStorage.setItem('aelion-site-language',language);}catch{}
  const url=new URL(location.href);url.searchParams.set('lang',language);
  history.replaceState(null,'',url);
}
