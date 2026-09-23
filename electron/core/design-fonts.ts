import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, relative, resolve} from 'node:path';
import {create, type Font} from 'fontkit';
import type {DesignSession} from '../../src/designer-types';
import type {DesignFont, DesignFontAcquire, DesignFontCatalogEntry, DesignFontCheck, DesignFontFile, DesignFontFormat, DesignFontStyle} from '../../src/design-font-types';
import type {DesignerFiles} from './designer-files';

const CSS_PATH = 'assets/fonts/fonts.css';
const MANIFEST_PATH = 'assets/fonts/fonts.json';
const MAX_FONT_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_EXPANDED_FONT = 64 * 1024 * 1024;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const unique = <T>(items: T[]) => [...new Set(items)];
const within = (root: string, target: string) => {const rel = relative(root, target); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');};
type Manifest = {version: 1; fonts: DesignFont[]; cssSha256: string};
type Metadata = DesignFontCatalogEntry & {defSubset?: string; license?: string | {type?: string; url?: string}};
type Parsed = {font: Font; family: string; weight: number; weightRange?: [number, number]; style: DesignFontStyle; format: DesignFontFormat};
type FontDownload = {filename: string; weight: number; style: DesignFontStyle; subset: string; unicodeRange?: string};

function validateFontDirectory(value: unknown, bytes: Buffer, format: DesignFontFormat) {
  // fontkit 2.0.4 create() parses only the directory. Check real allocation sizes
  // before touching its lazy familyName, numGlyphs or characterSet getters.
  const font=value as {directory?:{numTables?:number;totalCompressedSize?:number;totalSfntSize?:number;tables?:Record<string,{length:number;transformLength?:number;offset?:number;compLength?:number}>};_dataPos?:number};
  const directory=font.directory,entries=Object.values(directory?.tables||{});
  if(!directory||!entries.length||entries.length>512||directory.numTables!==entries.length)throw Error('字体表目录无效');
  let sfntSize=12+entries.length*16,expanded=0;
  for(const table of entries){
    if(!Number.isSafeInteger(table.length)||table.length<0||table.length>MAX_EXPANDED_FONT)throw Error('字体表超过解压大小限制');
    sfntSize+=Math.ceil(table.length/4)*4;
    const size=format==='woff2'?(table.transformLength??table.length):table.length;
    if(!Number.isSafeInteger(size)||size<0)throw Error('字体表长度无效');
    expanded+=size;if(expanded>MAX_EXPANDED_FONT||sfntSize>MAX_EXPANDED_FONT)throw Error('字体表超过解压大小限制');
    if(format!=='woff2'){
      const stored=format==='woff'?table.compLength:table.length;
      if(!Number.isSafeInteger(table.offset)||table.offset!<0||!Number.isSafeInteger(stored)||stored!<0||table.offset!+stored!>bytes.length||format==='woff'&&stored!>table.length)throw Error('字体表偏移或压缩长度无效');
    }
  }
  if(format==='woff'||format==='woff2')if(!Number.isSafeInteger(directory.totalSfntSize)||sfntSize>directory.totalSfntSize!||directory.totalSfntSize!>MAX_EXPANDED_FONT)throw Error('字体解压大小与表目录不符');
  if(format==='woff2'&&(!Number.isSafeInteger(font._dataPos)||!Number.isSafeInteger(directory.totalCompressedSize)||directory.totalCompressedSize!<1||font._dataPos!+directory.totalCompressedSize!>bytes.length))throw Error('压缩字体数据长度无效');
}

function shortText(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw Error('字体信息无效');
  return value.trim();
}
function catalogEntry(value: unknown): DesignFontCatalogEntry {
  if (!value || typeof value !== 'object') throw Error('字体目录格式无效');
  const x = value as Record<string, unknown>;
  const id = shortText(x.id, 100);
  if (!ID.test(id) || !Array.isArray(x.weights) || !Array.isArray(x.styles) || !Array.isArray(x.subsets)) throw Error('字体目录格式无效');
  const weights = unique(x.weights.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000));
  const styles = unique(x.styles.filter((v): v is DesignFontStyle => v === 'normal' || v === 'italic'));
  const subsets = unique(x.subsets.filter((v): v is string => typeof v === 'string' && /^[a-z0-9-]{1,80}$/.test(v)));
  if (!weights.length || !styles.length || weights.length > 20 || subsets.length > 80) throw Error('字体目录格式无效');
  return {id, family: shortText(x.family), category: typeof x.category === 'string' ? x.category.slice(0,80) : '', weights, styles, subsets};
}
export function parseFont(bytes: Buffer): Parsed {
  if (bytes.length < 32 || bytes.length > MAX_FONT_BYTES) throw Error('字体文件无效或超过 24 MB');
  const signature = bytes.toString('ascii', 0, 4);
  const format: DesignFontFormat = signature === 'wOF2' ? 'woff2' : signature === 'wOFF' ? 'woff' : signature === 'OTTO' ? 'otf' : bytes.readUInt32BE(0) === 0x10000 || signature === 'true' ? 'ttf' : (() => {throw Error('只支持 WOFF2、WOFF、TTF 和 OTF 字体');})();
  // Check the expanded size before WOFF decompression and reject collections.
  if ((format === 'woff' || format === 'woff2') && (bytes.readUInt32BE(8) !== bytes.length || bytes.readUInt32BE(16) > 64 * 1024 * 1024 || bytes.toString('ascii',4,8) === 'ttcf')) throw Error('压缩字体结构或大小无效');
  try {
    const font = create(bytes);
    validateFontDirectory(font,bytes,format);
    if (!('familyName' in font) || !font.numGlyphs) throw Error('字体没有可用字符');
    // Trigger cmap validation without expanding arbitrary cmap ranges into an array.
    font.hasGlyphForCodePoint(0);
    const family = shortText(font.familyName), axis = font.variationAxes?.wght;
    const rawWeight = font['OS/2']?.usWeightClass || axis?.default || 400;
    const weight = Math.max(1, Math.min(1000, Math.round(rawWeight)));
    const weightRange: [number,number] | undefined = axis && axis.min >= 1 && axis.max <= 1000 && axis.max > axis.min ? [axis.min,axis.max] : undefined;
    return {font, family, weight, weightRange, style: font.italicAngle !== 0 || /italic|oblique/i.test(font.subfamilyName) ? 'italic' : 'normal', format};
  } catch (error) {throw Error('无法解析字体文件：' + (error instanceof Error ? error.message : String(error)));}
}
function styleSheet(fonts: DesignFont[]) {
  return '/* Project fonts. Generated by AelionBot. */\n' + fonts.flatMap(font => font.files.map(file => {
    const src = relative(dirname(CSS_PATH), file.path).replaceAll('\\','/');
    const format = file.format === 'ttf' ? 'truetype' : file.format === 'otf' ? 'opentype' : file.format;
    return `@font-face {\n  font-family: ${JSON.stringify(font.family)};\n  font-style: ${file.style};\n  font-weight: ${file.weightRange ? file.weightRange.join(' ') : file.weight};\n  font-display: swap;\n  src: url(${JSON.stringify('./'+src)}) format(${JSON.stringify(format)});${file.unicodeRange ? '\n  unicode-range: '+file.unicodeRange+';' : ''}\n}\n`;
  })).join('\n');
}

/** The only remote font sources are Fontsource's API and its versioned npm files on jsDelivr. */
export class DesignFonts {
  private cacheDir: string;
  private files: DesignerFiles;
  private fetcher: typeof fetch;
  private catalogPromise?: Promise<DesignFontCatalogEntry[]>;
  constructor(options: {cacheDir: string; files: DesignerFiles; fetch?: typeof fetch}) {
    mkdirSync(options.cacheDir, {recursive:true});
    this.cacheDir = realpathSync.native(options.cacheDir);
    this.files = options.files;
    this.fetcher = options.fetch || fetch;
  }
  private cachePath(name: string) {
    const target = resolve(this.cacheDir, name);
    if (!within(this.cacheDir,target) || realpathSync.native(this.cacheDir) !== this.cacheDir) throw Error('字体缓存目录已改变');
    let current = target;
    while (current !== this.cacheDir) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('字体缓存不允许符号链接');
      current = dirname(current);
    }
    return target;
  }
  private cacheWrite(name: string, bytes: Buffer) {
    const path = this.cachePath(name); mkdirSync(dirname(path),{recursive:true});
    const temp = this.cachePath(name+'.'+randomUUID()+'.tmp');
    try {writeFileSync(temp,bytes,{flag:'wx'});this.cachePath(name);renameSync(temp,path);} finally {if(existsSync(temp))unlinkSync(temp);}
  }
  private async remote(url: string, limit: number, signal?: AbortSignal, budget?: {remaining:number}): Promise<Buffer> {
    const u = new URL(url);
    const api = u.hostname === 'api.fontsource.org' && /^\/v1\/(?:fonts(?:\/[a-z0-9-]+)?|version\/[a-z0-9-]+)$/.test(u.pathname);
    const cdn = u.hostname === 'cdn.jsdelivr.net' && /^\/npm\/@fontsource\/[a-z0-9-]+@\d+\.\d+\.\d+\/(?:metadata\.json|LICENSE|\d{1,4}(?:-italic)?\.css|files\/[a-z0-9-]+\.woff2)$/.test(u.pathname);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (!api && !cdn)) throw Error('字体地址不在允许来源中');
    const timeout = AbortSignal.timeout(25_000), combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
    const response = await this.fetcher(url,{redirect:'error',credentials:'omit',signal:combined});
    if (!response.ok || response.redirected || response.url && response.url !== url) throw Error(`字体下载失败（${response.status}）`);
    if (Number(response.headers.get('content-length') || '0') > Math.min(limit,budget?.remaining??limit) || !response.body) throw Error('字体下载超过大小限制或为空');
    const reader = response.body.getReader(), chunks: Buffer[] = []; let total = 0;
    try {
      for (;;) {combined.throwIfAborted();const part = await reader.read();if(part.done)break;total += part.value.length;if(total > limit)throw Error('字体下载超过大小限制');if(budget){budget.remaining-=part.value.length;if(budget.remaining<0)throw Error('字体下载总量超过 64 MB');}chunks.push(Buffer.from(part.value));}
    } catch (error) {await reader.cancel().catch(()=>{});throw error;} finally {reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  private async cachedRemote(url: string, limit: number, signal?: AbortSignal, budget?: {remaining:number}) {
    signal?.throwIfAborted();
    const key = 'downloads/'+hash(Buffer.from(url)), path = this.cachePath(key);
    if (existsSync(path)) {const stat=lstatSync(path);if(stat.isFile() && stat.size <= limit){if(budget){budget.remaining-=stat.size;if(budget.remaining<0)throw Error('字体下载总量超过 64 MB');}return readFileSync(path);}throw Error('字体缓存文件无效');}
    const bytes = await this.remote(url,limit,signal,budget);this.cacheWrite(key,bytes);return bytes;
  }
  async catalog(query = ''): Promise<DesignFontCatalogEntry[]> {
    if (typeof query !== 'string' || query.length > 200) throw Error('字体搜索词过长');
    this.catalogPromise ||= (async()=>{
      const bytes=await this.cachedRemote('https://api.fontsource.org/v1/fonts',6*1024*1024);
      const data:unknown=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(data)||data.length>10000)throw Error('字体目录格式无效');
      return data.flatMap(item=>{try{return [catalogEntry(item)];}catch{return [];}});
    })().catch(error=>{
      this.catalogPromise=undefined;
      const path=this.cachePath('pins');if(!existsSync(path))throw error;
      const local:DesignFontCatalogEntry[]=[];
      for(const name of readdirSync(path).slice(0,10000)){
        if(!/^[a-z0-9-]+\.json$/.test(name))continue;
        try{const id=name.slice(0,-5),pin=JSON.parse(readFileSync(this.cachePath('pins/'+name),'utf8'));if(!VERSION.test(pin.version))continue;const url='https://cdn.jsdelivr.net/npm/@fontsource/'+id+'@'+pin.version+'/metadata.json',metadata=this.cachePath('downloads/'+hash(Buffer.from(url)));if(!existsSync(metadata)||lstatSync(metadata).size>256*1024)continue;local.push(catalogEntry(JSON.parse(readFileSync(metadata,'utf8'))));}catch{/* Invalid cache entries do not hide other reusable fonts. */}
      }
      if(!local.length)throw error;return local;
    });
    const entries=await this.catalogPromise;
    const aliases:Record<string,string>={'思源黑体':'noto sans sc','思源宋体':'noto serif sc','中文':'chinese','简体':'chinese-simplified','繁体':'chinese-traditional'};
    const needle=(aliases[query.trim()]||query.trim()).toLowerCase(), preferred=['noto-sans-sc','noto-serif-sc','inter','jetbrains-mono','roboto','lora','poppins','manrope','dm-sans'];
    return entries.filter(entry=>!needle || `${entry.id} ${entry.family} ${entry.subsets.join(' ')}`.toLowerCase().replaceAll('-',' ').includes(needle.replaceAll('-',' '))).sort((a,b)=>{
      const rank=(id:string)=>{const i=preferred.indexOf(id);return i<0?100:i;};return rank(a.id)-rank(b.id)||a.family.localeCompare(b.family);
    }).slice(0,80).map(entry=>({...entry,cached:existsSync(this.cachePath('pins/'+entry.id+'.json'))}));
  }
  private projectRead(session: DesignSession, path: string, max = MAX_FONT_BYTES) {
    const absolute = this.files.absolute(session,path), stat=lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size>max) throw Error('字体文件无效或超过读取限制');
    const bytes=readFileSync(absolute);if(bytes.length>max)throw Error('字体文件超过读取限制');return bytes;
  }
  private manifest(session: DesignSession): {data:Manifest; sha256:string|null} {
    const path=this.files.absolute(session,MANIFEST_PATH);
    if(!existsSync(path))return {data:{version:1,fonts:[],cssSha256:''},sha256:null};
    const bytes=this.projectRead(session,MANIFEST_PATH,2*1024*1024);
    try {
      const data=JSON.parse(bytes.toString('utf8')) as Manifest;
      if(data.version!==1||!Array.isArray(data.fonts)||data.fonts.length>100||typeof data.cssSha256!=='string')throw Error();
      for(const font of data.fonts){
        shortText(font.id,150);shortText(font.family);if(font.cssPath!==CSS_PATH || !Array.isArray(font.files)||!font.files.length||font.files.length>MAX_FILES||!['fontsource','import'].includes(font.source))throw Error();
        if(!font.license||typeof font.license.name!=='string'||!Array.isArray(font.weights)||!Array.isArray(font.styles)||!Array.isArray(font.subsets))throw Error();
        if(font.license.path&&!/^assets\/fonts\/[a-z0-9-]+\/LICENSE\.txt$/.test(font.license.path))throw Error();
        for(const file of font.files){if(!/^assets\/fonts\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(file.path)||!/^\w{64}$/.test(file.sha256)||!['normal','italic'].includes(file.style)||!['woff','woff2','ttf','otf'].includes(file.format)||!Number.isFinite(file.weight)||file.weight<1||file.weight>1000)throw Error();if(file.weightRange&&(!Array.isArray(file.weightRange)||file.weightRange.length!==2||file.weightRange.some(value=>!Number.isFinite(value)||value<1||value>1000)||file.weightRange[0]>file.weightRange[1]))throw Error();if(file.unicodeRange&&!/^U\+[0-9a-f?]+(?:-[0-9a-f]+)?(?:\s*,\s*U\+[0-9a-f?]+(?:-[0-9a-f]+)?)*$/i.test(file.unicodeRange))throw Error();this.files.absolute(session,file.path);}
      }
      return {data,sha256:hash(bytes)};
    }catch{throw Error('项目字体记录无效，请检查 assets/fonts/fonts.json');}
  }
  list(session: DesignSession): DesignFont[] {
    const manifest=this.manifest(session).data;
    let cssValid=false;try{cssValid=!!manifest.cssSha256&&hash(this.projectRead(session,CSS_PATH,2*1024*1024))===manifest.cssSha256;}catch{}
    return manifest.fonts.map(font=>{
      const issues=font.files.flatMap(file=>{try{return hash(this.projectRead(session,file.path))===file.sha256?[]:[file.path];}catch{return [file.path];}});
      if(!cssValid)issues.push(CSS_PATH);
      return {...font,available:issues.length===0,...(issues.length?{issues}:{})};
    });
  }
  private materialize(session: DesignSession, incoming: DesignFont, assets: Array<{path:string;bytes:Buffer}>) {
    const previous=this.manifest(session), old=previous.data.fonts.find(font=>font.id===incoming.id);
    const byPath=new Map((old?.files||[]).map(file=>[file.path,file]));for(const file of incoming.files)byPath.set(file.path,file);
    const merged={...incoming,addedAt:old?.addedAt||incoming.addedAt,files:[...byPath.values()]};
    merged.weights=unique(merged.files.map(file=>file.weight)).sort((a,b)=>a-b);merged.styles=unique(merged.files.map(file=>file.style));merged.subsets=unique(merged.files.flatMap(file=>file.subset?[file.subset]:[]));
    const fonts=[...previous.data.fonts.filter(font=>font.id!==merged.id),merged];
    if(fonts.length>100||fonts.reduce((total,font)=>total+font.files.length,0)>1600)throw Error('项目字体数量超过限制');
    const css=Buffer.from(styleSheet(fonts)), cssPath=this.files.absolute(session,CSS_PATH);
    const existingCSS=existsSync(cssPath)?hash(this.projectRead(session,CSS_PATH,2*1024*1024)):null;
    if(existingCSS!==(previous.data.cssSha256||null))throw Error('字体样式已被修改，未覆盖 assets/fonts/fonts.css');
    // Preserve all immutable font/license bytes, and only replace our tracked generated files.
    for(const asset of assets)this.files.preserve(session,asset.path,asset.bytes);
    this.files.write(session,CSS_PATH,css,existingCSS);
    const manifest:Manifest={version:1,fonts,cssSha256:hash(css)};
    this.files.write(session,MANIFEST_PATH,Buffer.from(JSON.stringify(manifest,null,2)+'\n'),previous.sha256);
    return [merged];
  }
  async acquire(session: DesignSession, input: DesignFontAcquire, signal?: AbortSignal, beforeWrite?: () => void): Promise<DesignFont[]> {
    this.files.absolute(session,MANIFEST_PATH);
    if(!input||typeof input.fontId!=='string'||input.fontId.length>100||!ID.test(input.fontId))throw Error('无效的 Fontsource 字体 ID');
    const id=input.fontId,pin='pins/'+id+'.json';let version:string;
    if(existsSync(this.cachePath(pin))){version=JSON.parse(readFileSync(this.cachePath(pin),'utf8')).version;}else{const info=JSON.parse((await this.cachedRemote(`https://api.fontsource.org/v1/version/${id}`,128*1024,signal)).toString('utf8'));version=info.latest;}
    if(typeof version!=='string'||!VERSION.test(version))throw Error('字体版本无效');
    const base=`https://cdn.jsdelivr.net/npm/@fontsource/${id}@${version}/`;
    const metadata:Metadata=JSON.parse((await this.cachedRemote(base+'metadata.json',256*1024,signal)).toString('utf8'));
    const entry=catalogEntry(metadata);if(entry.id!==id)throw Error('字体元数据与请求不匹配');
    const weights=input.weights?.length?unique(input.weights):[entry.weights.includes(400)?400:entry.weights[0]];
    const styles=input.styles?.length?unique(input.styles):[entry.styles.includes('normal')?'normal' as const:entry.styles[0]];
    const chinese=entry.subsets.filter(subset=>subset.startsWith('chinese-'));
    const numberedSubset=chinese[0]||entry.subsets.find(subset=>['japanese','korean'].includes(subset));
    const subsets=input.subsets?.length?unique(input.subsets):chinese.length?[...chinese,...(entry.subsets.includes('latin')?['latin']:[])]:[metadata.defSubset&&entry.subsets.includes(metadata.defSubset)?metadata.defSubset:entry.subsets[0]];
    if(weights.length>9||weights.some(weight=>!entry.weights.includes(weight))||styles.length>2||styles.some(style=>!entry.styles.includes(style))||subsets.length>40||subsets.some(subset=>!entry.subsets.includes(subset)))throw Error('所选字重、样式或语言不受该字体支持');
    const downloads:FontDownload[]=[];
    for(const weight of weights)for(const style of styles){
      const css=(await this.cachedRemote(base+`${weight}${style==='italic'?'-italic':''}.css`,1024*1024,signal)).toString('utf8');
      for(const match of css.matchAll(/\/\*\s*([^*]+?)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g)){
        const comment=match[1].trim(), body=match[2],prefix=`${id}-`,suffix=`-${weight}-${style}`;
        if(!comment.startsWith(prefix)||!comment.endsWith(suffix))continue;
        const rawSubset=comment.slice(prefix.length,-suffix.length),subset=/^\[\d+\]$/.test(rawSubset)?numberedSubset||rawSubset:rawSubset;
        if(!subsets.includes(subset))continue;
        const source=/url\(\s*["']?\.\/files\/([a-z0-9-]+\.woff2)["']?\s*\)/.exec(body),unicode=/unicode-range:\s*([^;]+);/i.exec(body)?.[1].trim();
        if(!source||!source[1].startsWith(id+'-'))throw Error('字体样式包含无效资源');
        if(unicode&&!/^U\+[0-9a-f?]+(?:-[0-9a-f]+)?(?:\s*,\s*U\+[0-9a-f?]+(?:-[0-9a-f]+)?)*$/i.test(unicode))throw Error('字体字符范围无效');
        downloads.push({filename:source[1],weight,style,subset,unicodeRange:unicode});
      }
    }
    if(!downloads.length||downloads.length>MAX_FILES)throw Error('字体文件数量无效；请选择更少的字重');
    for(const weight of weights)for(const style of styles)for(const subset of subsets)if(!downloads.some(file=>file.weight===weight&&file.style===style&&file.subset===subset))throw Error('该版本没有所选语言的字体文件：'+subset);
    const license=await this.cachedRemote(base+'LICENSE',256*1024,signal);if(!license.toString('utf8').trim())throw Error('字体授权记录为空');
    const folder=`assets/fonts/${id}-${version.replaceAll('.','-')}`,assets:Array<{path:string;bytes:Buffer}>=[],files:DesignFontFile[]=[];let cursor=0;const budget={remaining:MAX_TOTAL_BYTES},downloadsController=new AbortController(),downloadSignal=signal?AbortSignal.any([signal,downloadsController.signal]):downloadsController.signal;
    await Promise.all(Array.from({length:Math.min(4,downloads.length)},async()=>{
      for(;;){const item=downloads[cursor++];if(!item)return;signal?.throwIfAborted();const bytes=await this.cachedRemote(base+'files/'+item.filename,MAX_FONT_BYTES,downloadSignal,budget);const parsed=parseFont(bytes);if(parsed.format!=='woff2')throw Error('字体文件格式与来源声明不符');
        const path=folder+'/'+item.filename;assets.push({path,bytes});files.push({path,weight:item.weight,style:item.style,format:parsed.format,sha256:hash(bytes),bytes:bytes.length,subset:item.subset,unicodeRange:item.unicodeRange});
      }
    })).catch(error=>{downloadsController.abort(error);throw error;});
    signal?.throwIfAborted();files.sort((a,b)=>a.path.localeCompare(b.path));
    const licensePath=folder+'/LICENSE.txt';assets.push({path:licensePath,bytes:license});
    const licenseMeta=metadata.license;
    const record:DesignFont={id:`fontsource-${id}-${version.replaceAll('.','-')}`,family:entry.family,source:'fontsource',version,weights,styles,subsets,files,cssPath:CSS_PATH,license:{name:typeof licenseMeta==='string'?licenseMeta:licenseMeta?.type||'Fontsource license',path:licensePath,url:typeof licenseMeta==='object'&&typeof licenseMeta.url==='string'?licenseMeta.url:undefined},addedAt:new Date().toISOString()};
    beforeWrite?.();const result=this.materialize(session,record,assets);this.cacheWrite(pin,Buffer.from(JSON.stringify({version,family:entry.family})));return result;
  }
  /** External paths must come from the user's file dialog; model paths are constrained by the caller. */
  async importFile(session: DesignSession, path: string, options: {licenseNote?: string; beforeWrite?: () => void} = {}): Promise<DesignFont[]> {
    this.files.absolute(session,MANIFEST_PATH);
    if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')||path.replace(/^[a-z]:/i,'').includes(':'))throw Error('无效字体文件路径');
    const target=resolve(path);let parent=target;
    while(dirname(parent)!==parent){if(lstatSync(parent).isSymbolicLink())throw Error('不支持导入符号链接字体');parent=dirname(parent);}
    const stat=lstatSync(target);if(!stat.isFile()||stat.size>MAX_FONT_BYTES)throw Error('字体文件无效或超过 24 MB');
    if(!['.woff2','.woff','.ttf','.otf'].includes(extname(target).toLowerCase()))throw Error('只支持 WOFF2、WOFF、TTF 和 OTF 字体');
    const bytes=readFileSync(target),parsed=parseFont(bytes),sha256=hash(bytes),id='import-'+sha256.slice(0,16),folder='assets/fonts/'+id,filePath=folder+'/'+sha256.slice(0,24)+'.'+parsed.format;
    const note=options.licenseNote;if(note!==undefined&&(typeof note!=='string'||note.length>4000||note.includes('\0')))throw Error('字体授权说明过长或无效');
    const licensePath=folder+'/LICENSE.txt';
    const licenseText=['User-provided font: '+parsed.family,'Original filename: '+basename(target),parsed.font.copyright||'',note?'User-provided license note: '+note:'No license document was supplied.'].filter(Boolean).join('\n')+'\n';
    const file:DesignFontFile={path:filePath,weight:parsed.weight,weightRange:parsed.weightRange,style:parsed.style,format:parsed.format,sha256,bytes:bytes.length};
    const font:DesignFont={id,family:parsed.family,source:'import',weights:[parsed.weight],styles:[parsed.style],subsets:[],files:[file],cssPath:CSS_PATH,license:{name:'用户提供',path:licensePath,note},addedAt:new Date().toISOString()};
    // Repeat imports reuse the original attribution and metadata without changing the license record.
    const existing=this.manifest(session).data.fonts.find(item=>item.id===id);
    options.beforeWrite?.();if(existing)return this.materialize(session,existing,[{path:filePath,bytes}]);
    return this.materialize(session,font,[{path:filePath,bytes},{path:licensePath,bytes:Buffer.from(licenseText)}]);
  }
  check(session: DesignSession, input: {text?: string; family?: string} = {}): DesignFontCheck {
    if(input.text!==undefined&&(typeof input.text!=='string'||input.text.length>50_000))throw Error('字体检查文本超过 50000 字符');
    if(input.family!==undefined&&(typeof input.family!=='string'||input.family.length>200))throw Error('字体名称无效');
    const manifest=this.manifest(session).data,characters=unique(Array.from(input.text||'').filter(char=>!/\s|[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f]/u.test(char)));
    const fonts=manifest.fonts.filter(font=>!input.family||font.family.toLowerCase()===input.family.toLowerCase()).map(font=>{
      const missingFiles:string[]=[],coverage=new Set<number>();
      for(const file of font.files){try{const bytes=this.projectRead(session,file.path);if(hash(bytes)!==file.sha256)throw Error();const parsed=parseFont(bytes);for(const char of characters){const cp=char.codePointAt(0)!;if(!coverage.has(cp)&&parsed.font.hasGlyphForCodePoint(cp))coverage.add(cp);}}catch{missingFiles.push(file.path);}}
      const missingCharacters=characters.filter(char=>!coverage.has(char.codePointAt(0)!));return {id:font.id,family:font.family,valid:missingFiles.length===0,missingFiles,missingCharacters,checkedCharacters:characters.length};
    });
    let cssValid=false;try{cssValid=!!manifest.cssSha256&&hash(this.projectRead(session,CSS_PATH,2*1024*1024))===manifest.cssSha256;}catch{}
    return {fonts,cssPath:CSS_PATH,cssValid};
  }
}
