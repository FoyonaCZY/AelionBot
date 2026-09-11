import conversationEn from '../../docs/assets/product/conversation-en.svg';
import conversationZh from '../../docs/assets/product/conversation-zh-CN.svg';
import collaborationEn from '../../docs/assets/product/collaboration-en.svg';
import collaborationZh from '../../docs/assets/product/collaboration-zh-CN.svg';
import studioEn from '../../docs/assets/product/studio-en.svg';
import studioZh from '../../docs/assets/product/studio-zh-CN.svg';
import rhythmEn from '../../docs/assets/product/rhythm-en.svg';
import rhythmZh from '../../docs/assets/product/rhythm-zh-CN.svg';
import conversationTw from '../../docs/assets/product/conversation-zh-TW.svg';
import collaborationTw from '../../docs/assets/product/collaboration-zh-TW.svg';
import studioTw from '../../docs/assets/product/studio-zh-TW.svg';
import rhythmTw from '../../docs/assets/product/rhythm-zh-TW.svg';
import type {SiteLanguage} from './site-i18n';

export const productScenes=(language:SiteLanguage)=>language==='en'
  ?[conversationEn,collaborationEn,studioEn,rhythmEn]
  :language==='zh-TW'?[conversationTw,collaborationTw,studioTw,rhythmTw]:[conversationZh,collaborationZh,studioZh,rhythmZh];
export const sceneCopy={
  en:{kicker:'A closer look',title:['Open it.','Make it yours.'],description:'Browse the files. Preview the result. Edit code and text in the same space.',tabs:['Your preview studio','The details, remembered'],caption:'Product illustrations · Example content',alt:['A writing partner turns notes into a talk and a document.','Three partners share research, ideas, and a finished brief.','A file tree, web preview, and editable notes in one space.','Preferences, scheduled research, and permission choices.']},
  'zh-CN':{kicker:'成果，近一点看',title:['打开看看。','顺手改改。'],description:'浏览目录、预览成果，代码和文字都能在这里直接修改。',tabs:['你的预览工作台','记住合作里的细节'],caption:'功能示意 · 示例内容',alt:['写作伙伴将笔记整理成分享讲稿和文档。','三位伙伴一起整理资料、讨论创意、完成提纲。','文件目录、网页预览与可编辑的笔记。','偏好记忆、定时资料整理与操作许可。']},
  'zh-TW':{kicker:'成果，近一點看',title:['打開看看。','順手改改。'],description:'瀏覽目錄、預覽成果，程式碼和文字都能在這裡直接修改。',tabs:['你的預覽工作台','記住合作裡的細節'],caption:'功能示意 · 範例內容',alt:['寫作夥伴將筆記整理成分享講稿和文件。','三位夥伴一起整理資料、討論創意、完成提綱。','檔案目錄、網頁預覽與可編輯的筆記。','偏好記憶、排程資料整理與操作許可。']}
};
