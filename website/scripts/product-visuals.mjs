// Product illustrations, not screenshots. Keep all text and shapes as vectors.
// Run from the repository root: node website/scripts/product-visuals.mjs
import {mkdirSync,writeFileSync} from 'node:fs';

const destination='docs/assets/product';
mkdirSync(destination,{recursive:true});
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const rect=(x,y,w,h,fill='#fff',r=18,stroke='none')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const text=(x,y,value,size=24,color='#282832',weight=400)=>`<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}">${esc(value)}</text>`;
const line=(x,y,w)=>`<path d="M${x} ${y}h${w}" stroke="#e4e4eb"/>`;
const bot=(x,y,color='#9174df',size=42)=>`<g transform="translate(${x} ${y}) scale(${size/64})"><path d="M33 2C51 1 61 14 62 33C63 52 50 62 30 62C11 62 2 51 2 31C2 13 14 2 33 2Z" fill="${color}"/><ellipse cx="24" cy="29" rx="3" ry="6" fill="white" transform="rotate(-15 24 29)"/><ellipse cx="41" cy="27" rx="3" ry="6" fill="white" transform="rotate(-15 41 27)"/></g>`;
const iconFile=(x,y,color='#787181')=>`<g transform="translate(${x} ${y})" stroke="${color}" fill="none" stroke-width="2"><path d="M2 0h17l9 9v29H2zM19 0v9h9M8 20h14M8 27h10"/></g>`;
const file=(x,y,w,title,detail,color='#f3f1f8')=>rect(x,y,w,82,color,14)+iconFile(x+22,y+22)+text(x+70,y+34,title,21,'#30303a',500)+text(x+70,y+59,detail,15,'#757580');
const chrome=(label,sub,body)=>rect(26,26,1148,688,'#fff',22,'#e2e2e9')+bot(54,49)+text(109,78,label,24,'#292833',550)+text(1140,77,sub,15,'#757580').replace('<text ','<text text-anchor="end" ')+line(26,108,1148)+body;
const copy={
  en:{
    chat:['Writing partner','Ready','Turn these notes into a ten-minute talk.','Your first draft is ready.','A clear story, from opening to takeaway.','01','Start with the idea worth sharing.','02','Make it concrete with one good example.','03','Leave your audience with a next step.','talk-outline.docx','Document · Ready to save','Make the opening a little more personal.','Message your partner…'],
    team:['Launch team','3 partners','One brief. Three different strengths.','Research partner','The audience notes and sources are organized.','Creative partner','Let’s build the story around a day in their life.','Writing partner','I’ve brought both into a first draft.','launch-brief.pdf','Shared with the team','Research','Shape the story','Bring it together'],
    studio:['Preview studio','project /','Files','launch','index.html','style.css','notes.md','Your next idea,','one page away.','A small page for something worth sharing.','Explore the idea','Preview','Edit','notes.md','Keep the story simple.','Start with a human moment.','End with something to try.','Saved','Read it. Refine it. Make it yours.'],
    rhythm:['Room to focus.','Your partner remembers the details.','Your preferences','Writing style','Clear, warm, to the point.','Weekly research','Friday · 9:00 AM','Next up','You choose what happens next.','Ask first','Allow once','Pause anytime','Scheduled work runs while the app is open.']
  },
  'zh-CN':{
    chat:['写作伙伴','已完成','把这些笔记，变成一场十分钟的分享。','第一版讲稿，准备好了。','从开场到结尾，让重点自然讲出来。','01','从最值得分享的想法说起。','02','用一个具体例子，把它讲明白。','03','留给听众一件可以试试的小事。','分享讲稿.docx','文档 · 可以保存','开场再亲切一点，像和朋友聊天。','给伙伴发消息…'],
    team:['分享准备小组','3 位伙伴','一件事，交给各有所长的伙伴。','资料伙伴','读者背景和引用来源，已经整理好了。','灵感搭档','从读者生活里的一天切入，故事会更自然。','写作伙伴','我把资料和这个开场，写进了第一版。','分享提纲.pdf','已发到群聊','整理资料','一起想创意','写成作品'],
    studio:['预览工作台','project /','文件','launch','index.html','style.css','notes.md','下一个想法，','就从这里开始。','给值得分享的事情，做一个小页面。','看看这个想法','预览','编辑','notes.md','让故事简单一些。','从一个生活里的瞬间开始。','留下一件可以试试的小事。','已保存','看一看，改一改，变成你的作品。'],
    rhythm:['放心专注眼前。','合作里的细节，让伙伴记着。','你的偏好','写作风格','清楚、亲切、直接一点。','每周资料整理','星期五 · 上午 9:00','下次安排','每一步，都由你决定。','先询问','允许本次','随时暂停','定时工作执行时，需要保持应用开启。']
  }
};
copy['zh-TW']={
  chat:['寫作夥伴','已完成','把這些筆記，變成一場十分鐘的分享。','第一版講稿，準備好了。','從開場到結尾，讓重點自然說出來。','01','從最值得分享的想法說起。','02','用一個具體例子，把它說明白。','03','留給聽眾一件可以試試的小事。','分享講稿.docx','文件 · 可以儲存','開場再親切一點，像和朋友聊天。','傳訊息給夥伴…'],
  team:['分享準備小組','3 位夥伴','一件事，交給各有所長的夥伴。','資料夥伴','讀者背景和引用來源，已經整理好了。','靈感搭檔','從讀者生活裡的一天切入，故事會更自然。','寫作夥伴','我把資料和這個開場，寫進了第一版。','分享提綱.pdf','已傳到群組聊天','整理資料','一起想創意','寫成作品'],
  studio:['預覽工作台','project /','檔案','launch','index.html','style.css','notes.md','下一個想法，','就從這裡開始。','給值得分享的事情，做一個小頁面。','看看這個想法','預覽','編輯','notes.md','讓故事簡單一些。','從一個生活裡的瞬間開始。','留下一件可以試試的小事。','已儲存','看一看，改一改，變成你的作品。'],
  rhythm:['放心專注眼前。','合作裡的細節，讓夥伴記著。','你的偏好','寫作風格','清楚、親切、直接一點。','每週資料整理','星期五 · 上午 9:00','下次安排','每一步，都由你決定。','先詢問','允許本次','隨時暫停','執行排程工作時，需要保持應用程式開啟。']
};
for(const [language,c] of Object.entries(copy)){
  const a=c.chat;
  const chat=chrome(a[0],a[1],rect(539,142,585,64,'#eeebf6',20)+text(562,182,a[2],24)+bot(64,247,'#9e83ca')+text(122,275,a[3],28,'#24232c',550)+text(122,315,a[4],23,'#73727e')+[0,1,2].map((v)=>text(124,365+v*45,a[5+v*2],17,'#9b8bb0',500)+text(174,365+v*45,a[6+v*2],23)).join('')+file(122,484,480,a[11],a[12])+rect(614,586,510,52,'#eeebf6',18)+text(638,620,a[13],21)+line(56,659,1088)+text(65,692,a[14],19,'#92929c')+text(1106,692,'↑',27));
  const t=c.team;
  const team=chrome(t[0],t[1],text(64,167,t[2],29,'#272631',550)+[0,1,2].map((v)=>{
    const y=208+v*119,colors=['#659ccd','#ad85b4','#7dab99'];
    return bot(64,y,colors[v])+text(124,y+23,t[3+v*2],19,'#73727c',500)+rect(122,y+39,921,62,'#f5f5f7',16)+text(145,y+78,t[4+v*2],23);
  }).join('')+file(122,570,530,t[9],t[10],'#eef4f1')+text(750,620,`${t[11]} → ${t[12]}`,19,'#7d7786'));
  const s=c.studio;
  const studio=rect(26,26,1148,688,'#fff',22,'#e2e2e9')+rect(26,26,232,688,'#f5f5f8',22)+rect(240,26,18,688,'#f5f5f8',0)+text(55,81,s[2],21,'#575562',500)+text(55,147,'⌄  '+s[3],21)+rect(43,170,198,44,'#e8e4f2',9)+text(70,199,s[4],21)+text(70,248,s[5],21,'#777582')+text(70,293,s[6],21,'#777582')+text(290,77,s[0],21,'#3a3844',500)+rect(953,46,184,43,'#f1f0f4',12)+text(974,74,s[11],18)+text(1063,74,s[12],18,'#8d8599')+line(258,108,916)+rect(291,138,848,320,'#eeedf6',18)+text(337,211,s[7],42,'#353142',550)+text(337,265,s[8],42,'#7962a9',550)+text(337,309,s[9],21,'#777082')+rect(336,347,215,54,'#37313f',27)+text(359,381,s[10],20,'#fff')+bot(922,231,'#b5a3d8',128)+text(300,507,s[13],19,'#777180')+text(1070,507,s[17],17,'#6a8e7e')+[0,1,2].map(v=>text(302,552+v*36,String(v+1),17,'#b1a9bc')+text(342,552+v*36,s[14+v],22)).join('')+text(301,682,s[18],20,'#8b8298');
  const r=c.rhythm;
  const rhythm=rect(26,26,1148,688,'#f6f5f8',22)+text(75,108,r[0],43,'#2e2b36',550)+text(76,151,r[1],24,'#807888')+rect(72,194,510,262,'#fff',22)+text(105,237,r[2],17,'#9586a4',500)+text(105,291,r[3],29,'#34313d',500)+text(105,338,r[4],23,'#7e7786')+rect(105,373,66,5,'#af9fc4',2)+rect(181,373,146,5,'#e4deed',2)+rect(607,194,519,262,'#fff',22)+rect(641,230,66,72,'#edf3ef',14)+text(662,279,'F',31,'#709380',500)+text(728,259,r[5],25,'#34313d',500)+text(728,296,r[6],21,'#807888')+line(641,328,450)+text(644,399,r[7],19,'#80a090')+rect(72,481,1054,163,'#2e2c36',22)+text(106,530,r[8],27,'#fff',500)+[0,1,2].map(v=>rect(106+v*230,556,211,53,v===1?'#e7e0f4':'#42404a',26)+text(129+v*230,590,r[9+v],20,v===1?'#4e4266':'#e8e4ec')).join('')+text(77,687,r[12],17,'#98909f');
  for(const [name,body] of Object.entries({conversation:chat,collaboration:team,studio,rhythm})){
    const title={conversation:a[3],collaboration:t[2],studio:s[18],rhythm:r[0]}[name];
    writeFileSync(`${destination}/${name}-${language}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="740" viewBox="0 0 1200 740" fill="none" role="img"><title>${esc(title)}</title><desc>${language==='en'?'Product illustration with example content; not an application screenshot.':'功能示意，使用示例内容，并非应用截图。'}</desc><g font-family="Inter, Segoe UI, Arial, Microsoft YaHei, Noto Sans CJK SC, sans-serif">${body}</g></svg>\n`);
  }
}
