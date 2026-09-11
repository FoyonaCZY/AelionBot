import {createHash} from 'node:crypto';
import {decodeText,TEXT_FILE_LIMIT} from './file-text';
import type {EditableText} from '../../src/editable-text';
export function editableText(bytes:Buffer,identity:string):EditableText{
  const decoded=decodeText(bytes),lineSeparator=decoded.text.includes('\r\n')?'\r\n':'\n';
  return {content:decoded.text.replace(/\r\n?|\n/g,lineSeparator),revision:createHash('sha256').update(identity+'\0'+decoded.sha256).digest('hex'),bytes:bytes.length,lineSeparator};
}
export function editedBytes(content:unknown,before?:Buffer){
  if(typeof content!=='string'||content.length>TEXT_FILE_LIMIT||content.includes('\0'))throw Error('文本内容无效或超过 2 MB');
  const original=before?decodeText(before):undefined;
  const lineSeparator=original?.text.includes('\r\n')?'\r\n':'\n';
  const value=(original?.bom?'\uFEFF':'')+content.replace(/\r\n?|\n/g,lineSeparator),bytes=Buffer.from(value,'utf8');
  if(bytes.length>TEXT_FILE_LIMIT)throw Error('保存后的文本超过 2 MB');
  return bytes;
}
