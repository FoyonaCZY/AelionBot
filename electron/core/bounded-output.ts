function headBoundary(bytes:Buffer){let index=bytes.length-1;while(index>=0&&(bytes[index]&0xc0)===0x80)index--;if(index<0)return 0;const byte=bytes[index],needed=byte>=0xf0&&byte<=0xf4?4:byte>=0xe0&&byte<=0xef?3:byte>=0xc2&&byte<=0xdf?2:1;return bytes.length-index<needed?index:bytes.length;}
export function bytePage(bytes:Buffer,offset:number,limit=12000,complete=false){
  let start=Math.min(bytes.length,Math.max(0,offset));while(start>0&&start<bytes.length&&(bytes[start]&0xc0)===0x80)start--;
  const wanted=Math.min(bytes.length,start+limit),end=complete&&wanted===bytes.length?wanted:start+headBoundary(bytes.subarray(start,wanted));
  return {output:bytes.subarray(start,end).toString('utf8'),offset:start,nextOffset:end,pendingBytes:wanted===bytes.length?wanted-end:0};
}
function edge(text:string,secrets:string[],head:boolean){
  for(const secret of secrets.filter(value=>value.length>=6).sort((a,b)=>b.length-a.length))for(let length=Math.min(secret.length-1,text.length);length>0;length--){
    if(head?text.endsWith(secret.slice(0,length)):text.startsWith(secret.slice(-length))){text=head?text.slice(0,-length)+'[redacted]':'[redacted]'+text.slice(length);break;}
  }
  return text;
}
export class BoundedOutput {
  private head:Buffer[]=[];private headBytes=0;private tail=Buffer.alloc(0);private bytes=0;
  constructor(private limit=512*1024){if(!Number.isInteger(limit)||limit<8)throw Error('Invalid output limit');}
  push(chunk:Buffer){
    this.bytes+=chunk.length;const headLimit=Math.floor(this.limit/2),take=Math.min(chunk.length,headLimit-this.headBytes);
    if(take>0){this.head.push(Buffer.from(chunk.subarray(0,take)));this.headBytes+=take;}
    const rest=chunk.subarray(take),tailLimit=this.limit-headLimit;if(!rest.length)return;
    this.tail=rest.length>=tailLimit?Buffer.from(rest.subarray(-tailLimit)):Buffer.concat([this.tail,rest]).subarray(-tailLimit);
  }
  result(redact:(text:string)=>string=text=>text,secrets:string[]=[]){
    const head=Buffer.concat(this.head,this.headBytes),truncated=this.bytes>this.limit;
    if(!truncated)return {text:redact(Buffer.concat([head,this.tail]).toString('utf8')),totalBytes:this.bytes,omittedBytes:0,truncated:false};
    const end=headBoundary(head);let start=0;while(start<this.tail.length&&(this.tail[start]&0xc0)===0x80)start++;
    const omittedBytes=this.bytes-end-(this.tail.length-start);
    const first=edge(redact(head.subarray(0,end).toString('utf8')),secrets,true);
    const rawTail=this.tail.subarray(start).toString('utf8').replace(/^[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,'[redacted private key]');
    const last=edge(redact(rawTail),secrets,false);
    return {text:`${first}\n[中间省略 ${omittedBytes} 字节，保留输出首尾]\n${last}`,totalBytes:this.bytes,omittedBytes,truncated:true};
  }
}
