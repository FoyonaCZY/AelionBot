import {createHash} from 'node:crypto';

// Only hashes and counts are retained, never prompt text. Long transcripts must
// not evict the entire working set when one more message is added.
export class TokenCountCache {
  private entries=new Map<string,number>();
  constructor(private tokenize:(text:string)=>number,private capacity=16384){
    if(!Number.isSafeInteger(capacity)||capacity<1)throw new Error('Invalid token cache capacity');
  }
  count(text:string){
    if(!text)return 0;
    const key=createHash('sha256').update(text).digest('hex'),known=this.entries.get(key);
    if(known!==undefined){this.entries.delete(key);this.entries.set(key,known);return known;}
    const tokens=this.tokenize(text);
    if(this.entries.size>=this.capacity)this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key,tokens);return tokens;
  }
}
