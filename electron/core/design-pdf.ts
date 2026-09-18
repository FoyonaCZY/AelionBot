export function printReadyHtml(html:string){
 if(!html.trim())throw Error('没有可打印的 HTML');
 if(/<html[\s>]/i.test(html))return html;
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Export</title><body>${html}</body></html>`;
}
export async function renderDesignPdf(html:string,print:(document:string)=>Promise<Buffer>){
 const document=printReadyHtml(html);
 const bytes=await print(document);
 if(!bytes.length||bytes.length>40*1024*1024)throw Error('PDF 为空或过大');
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('导出结果不是 PDF');
 return bytes;
}
