export const previewErrorText=(error:unknown)=>String(error instanceof Error?error.message:error).replace(/^Error invoking remote method '[^']+': Error: /,'');
export function previewFormat(name:string){return name.split('.').pop()?.toLowerCase()||'';}
export function previewKind(name:string){
  const ext=previewFormat(name);
  if(['ppt','pptx','odp'].includes(ext))return '演示文稿';
  if(['html','htm'].includes(ext))return '网页';
  if(['png','jpg','jpeg','svg','gif','webp','bmp','avif'].includes(ext))return '图片';
  return '文档';
}
export function csvRows(text:string){
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length&&rows.length<201;i++){
    const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if((cell||row.length)&&rows.length<201){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return rows.map(row=>row.slice(0,30));
}

// The document stays in an opaque, script-free frame. Do not inherit its base URL
// or allow embedded content to navigate the application or submit forms.
export function previewHtml(content:string){
  return '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; base-uri \'none\'; form-action \'none\'"><meta name="referrer" content="no-referrer">'+content;
}
