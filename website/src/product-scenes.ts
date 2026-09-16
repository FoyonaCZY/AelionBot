import type {SiteLanguage} from './site-i18n';
import conversationEn from '../../docs/assets/screenshots/conversation-en.png';
import conversationZh from '../../docs/assets/screenshots/conversation-zh-CN.png';
import conversationTw from '../../docs/assets/screenshots/conversation-zh-TW.png';
import collaborationEn from '../../docs/assets/screenshots/collaboration-en.png';
import collaborationZh from '../../docs/assets/screenshots/collaboration-zh-CN.png';
import collaborationTw from '../../docs/assets/screenshots/collaboration-zh-TW.png';
import studioEn from '../../docs/assets/screenshots/studio-en.png';
import studioZh from '../../docs/assets/screenshots/studio-zh-CN.png';
import studioTw from '../../docs/assets/screenshots/studio-zh-TW.png';
import rhythmEn from '../../docs/assets/screenshots/rhythm-en.png';
import rhythmZh from '../../docs/assets/screenshots/rhythm-zh-CN.png';
import rhythmTw from '../../docs/assets/screenshots/rhythm-zh-TW.png';
import computerEn from '../../docs/assets/screenshots/computer-en.png';
import computerZh from '../../docs/assets/screenshots/computer-zh-CN.png';
import computerTw from '../../docs/assets/screenshots/computer-zh-TW.png';
import handoffEn from '../../docs/assets/screenshots/handoff-en.png';
import handoffZh from '../../docs/assets/screenshots/handoff-zh-CN.png';
import handoffTw from '../../docs/assets/screenshots/handoff-zh-TW.png';
import workspaceEn from '../../docs/assets/screenshots/workspace-en.png';
import workspaceZh from '../../docs/assets/screenshots/workspace-zh-CN.png';
import workspaceTw from '../../docs/assets/screenshots/workspace-zh-TW.png';
import designerEn from '../../docs/assets/screenshots/designer-en.png';
import designerZh from '../../docs/assets/screenshots/designer-zh-CN.png';
import designerTw from '../../docs/assets/screenshots/designer-zh-TW.png';

export const productScenes=(language:SiteLanguage)=>language==='en'?[conversationEn,collaborationEn,studioEn,rhythmEn,computerEn,handoffEn,workspaceEn,designerEn]:language==='zh-TW'?[conversationTw,collaborationTw,studioTw,rhythmTw,computerTw,handoffTw,workspaceTw,designerTw]:[conversationZh,collaborationZh,studioZh,rhythmZh,computerZh,handoffZh,workspaceZh,designerZh];
export const sceneCopy={
  "zh-CN": {
    "kicker": "界面功能",
    "title": [
      "文件预览",
      "与工作配置"
    ],
    "description": "查看当前界面。截图中的对话和文件均为示例数据。",
    "tabs": [
      "文件预览",
      "Bot 配置",
      "工作电脑设置",
      "Bot 私聊",
      "工作台",
      "设计系统选择"
    ],
    "caption": "当前界面截图 · 示例数据",
    "alt": [
      "任务对话 · 当前界面截图 · 示例数据",
      "群聊协作 · 当前界面截图 · 示例数据",
      "文件预览 · 当前界面截图 · 示例数据",
      "Bot 配置 · 当前界面截图 · 示例数据",
      "工作电脑设置 · 当前界面截图 · 示例数据",
      "Bot 私聊 · 当前界面截图 · 示例数据",
      "工作台 · 当前界面截图 · 示例数据",
      "设计系统选择 · 当前界面截图 · 示例数据"
    ]
  },
  "zh-TW": {
    "kicker": "介面功能",
    "title": [
      "檔案預覽",
      "與工作設定"
    ],
    "description": "查看目前介面。截圖中的對話和檔案均為範例資料。",
    "tabs": [
      "檔案預覽",
      "Bot 設定",
      "工作電腦設定",
      "Bot 私訊",
      "工作台",
      "設計系統選擇"
    ],
    "caption": "目前介面截圖 · 範例資料",
    "alt": [
      "工作對話 · 目前介面截圖 · 範例資料",
      "群組協作 · 目前介面截圖 · 範例資料",
      "檔案預覽 · 目前介面截圖 · 範例資料",
      "Bot 設定 · 目前介面截圖 · 範例資料",
      "工作電腦設定 · 目前介面截圖 · 範例資料",
      "Bot 私訊 · 目前介面截圖 · 範例資料",
      "工作台 · 目前介面截圖 · 範例資料",
      "設計系統選擇 · 目前介面截圖 · 範例資料"
    ]
  },
  "en": {
    "kicker": "INTERFACE",
    "title": [
      "Files and",
      "configuration"
    ],
    "description": "Browse the current interface. Screenshots use sample conversations and files.",
    "tabs": [
      "File preview",
      "Bot configuration",
      "Work computer settings",
      "Bot messages",
      "Workspace",
      "Design system picker"
    ],
    "caption": "Current UI screenshots · Example data",
    "alt": [
      "Task conversation · Current UI screenshots · Example data",
      "Group conversation · Current UI screenshots · Example data",
      "File preview · Current UI screenshots · Example data",
      "Bot configuration · Current UI screenshots · Example data",
      "Work computer settings · Current UI screenshots · Example data",
      "Bot messages · Current UI screenshots · Example data",
      "Workspace · Current UI screenshots · Example data",
      "Design system picker · Current UI screenshots · Example data"
    ]
  }
};
export const teamShowcaseCopy={
  "zh-CN": {
    "kicker": "工作台",
    "title": "查看实际工作界面",
    "description": "左侧选择 Bot 或群聊，中间处理任务，右侧查看工作电脑和定时任务。截图使用示例数据，没有连接模型或 VM。",
    "gallery": "工作电脑与 Bot 私聊",
    "captions": [
      "工作电脑设置页，示例环境未启动。",
      "查看 Bot 之间的消息和附件。"
    ]
  },
  "zh-TW": {
    "kicker": "工作台",
    "title": "查看實際工作介面",
    "description": "左側選擇 Bot 或群組，中間處理工作，右側查看工作電腦和排程。截圖使用範例資料，沒有連線模型或 VM。",
    "gallery": "工作電腦與 Bot 私訊",
    "captions": [
      "工作電腦設定頁，範例環境尚未啟動。",
      "查看 Bot 之間的訊息與附件。"
    ]
  },
  "en": {
    "kicker": "WORKSPACE",
    "title": "The application workspace",
    "description": "Select a Bot or group on the left, work in the conversation, and access the work computer and schedules on the right. Screenshots use sample data, without a model or VM connection.",
    "gallery": "Work computer and Bot messages",
    "captions": [
      "Work computer settings, with the example environment stopped.",
      "View messages and attachments exchanged between Bots."
    ]
  }
};
