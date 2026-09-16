import computerEn from '../../docs/assets/product/computer-en.svg';
import computerZh from '../../docs/assets/product/computer-zh-CN.svg';
import computerTw from '../../docs/assets/product/computer-zh-TW.svg';
import handoffEn from '../../docs/assets/product/handoff-en.svg';
import handoffZh from '../../docs/assets/product/handoff-zh-CN.svg';
import handoffTw from '../../docs/assets/product/handoff-zh-TW.svg';
import workspaceEn from '../../docs/assets/product/workspace-en.svg';
import workspaceZh from '../../docs/assets/product/workspace-zh-CN.svg';
import workspaceTw from '../../docs/assets/product/workspace-zh-TW.svg';
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
  ?[conversationEn,collaborationEn,studioEn,rhythmEn,computerEn,handoffEn,workspaceEn]
  :language==='zh-TW'?[conversationTw,collaborationTw,studioTw,rhythmTw,computerTw,handoffTw,workspaceTw]:[conversationZh,collaborationZh,studioZh,rhythmZh,computerZh,handoffZh,workspaceZh];
export const sceneCopy={
  en:{kicker:'A closer look',title:['Open it.','Make it yours.'],description:'Browse the files. Preview the result. Edit code and text in the same space.',tabs:["Your preview studio","The details, remembered","Linux work computer","Bot-to-Bot handoff","Multi-agent workspace"],caption:'Product illustrations · Example content',alt:['A writing partner turns notes into a talk and a document.','Three partners share research, ideas, and a finished brief.','A file tree, web preview, and editable notes in one space.','Preferences, scheduled research, and permission choices.',"A Linux desktop with source files, a browser and a terminal.","Two Bots exchange source material and a comparison file.","Multiple AI partners, a task conversation, files and a VM in one workspace."]},
  'zh-CN':{kicker:'成果，近一点看',title:['打开看看。','顺手改改。'],description:'浏览目录、预览成果，代码和文字都能在这里直接修改。',tabs:["你的预览工作台","记住合作里的细节","Linux 工作电脑","Bot 私信与文件交接","多 Agent 工作台"],caption:'功能示意 · 示例内容',alt:['写作伙伴将笔记整理成分享讲稿和文档。','三位伙伴一起整理资料、讨论创意、完成提纲。','文件目录、网页预览与可编辑的笔记。','偏好记忆、定时资料整理与操作许可。',"Linux 桌面中的资料文件、浏览器和终端。","两位 Bot 通过私信交接资料与对比结果。","多位 AI 伙伴、任务对话、文件和 VM 构成的工作台。"]},
  'zh-TW':{kicker:'成果，近一點看',title:['打開看看。','順手改改。'],description:'瀏覽目錄、預覽成果，程式碼和文字都能在這裡直接修改。',tabs:["你的預覽工作台","記住合作裡的細節","Linux 工作電腦","Bot 私訊與檔案交接","多 Agent 工作台"],caption:'功能示意 · 範例內容',alt:['寫作夥伴將筆記整理成分享講稿和文件。','三位夥伴一起整理資料、討論創意、完成提綱。','檔案目錄、網頁預覽與可編輯的筆記。','偏好記憶、排程資料整理與操作許可。',"Linux 桌面中的資料檔案、瀏覽器和終端機。","兩位 Bot 透過私訊交接資料與比較結果。","多位 AI 夥伴、工作對話、檔案和 VM 組成的工作台。"]}
};

export const teamShowcaseCopy={
 'zh-CN':{kicker:'通用多 AGENT 工作空间',title:'把伙伴、工具和任务放在一起。',description:'配置不同职责的 Agent，单独交办，或在群聊中分工。浏览器、代码、文件与工作电脑，都围绕正在做的事展开。',gallery:'看看伙伴怎样真正动手。',captions:['在 Linux 工作电脑中浏览、运行代码和处理文件。','通过 Bot 私信交接来源、数据与结果。']},
 'zh-TW':{kicker:'通用多 AGENT 工作空間',title:'把夥伴、工具和工作放在一起。',description:'設定不同職責的 Agent，單獨交辦，或在群組裡分工。瀏覽器、程式碼、檔案與工作電腦，都圍繞正在做的事展開。',gallery:'看看夥伴怎樣真正動手。',captions:['在 Linux 工作電腦中瀏覽、執行程式與處理檔案。','透過 Bot 私訊交接來源、資料與結果。']},
 en:{kicker:'A GENERAL-PURPOSE MULTI-AGENT WORKSPACE',title:'Partners, tools and tasks. Together.',description:'Configure agents with different responsibilities. Work one-to-one or divide a task in group chat, with browsers, code, files and a work computer close at hand.',gallery:'See how the work gets done.',captions:['Browse, run code and process files in a Linux work computer.','Pass sources, data and results through Bot-to-Bot messages.']}
};
