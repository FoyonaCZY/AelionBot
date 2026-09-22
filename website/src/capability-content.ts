import type {SiteLanguage} from './site-i18n';
interface Feature {kicker:string;title:string;description:string;points:string[];note:string;}
interface CapabilityCopy {nav:string[];design:Feature;vm:Feature;group:Feature;}
export const capabilityCopy:Record<SiteLanguage,CapabilityCopy>={
  "zh-CN": {
    "nav": [
      "多 Agent 协作",
      "工作电脑",
      "专业设计"
    ],
    "design": {
      "kicker": "03 / 专业角色 · 设计师",
      "title": "设计师与设计系统",
      "description": "设计师按独立任务制作网页原型、可编辑 PPT 和网站复刻，可选择 152 套预装设计系统。",
      "points": [
        "每套设计系统包含配色、字体、布局与组件参考。",
        "每个任务独立选择设计系统，停止任务后可以更改，也可以不指定。",
        "一边对话一边预览，框选、标注，或直接修改网页元素与源码。"
      ],
      "note": "设计师在默认工作目录的 designers 下工作，无需启动 VM。设计系统参考来自 OpenDesign，保留来源与许可；品牌风格参考不代表官方合作。"
    },
    "vm": {
      "kicker": "02 / Linux VM",
      "title": "Linux 工作电脑",
      "description": "通用 Bot 使用 Linux VM，支持查看执行过程、暂停任务和接管桌面。",
      "points": [
        "通用 Bot 各有工作目录和桌面，在同一台受管理的 VM 中工作。",
        "浏览器、终端和办公应用支持调研、计算与文件处理。",
        "启动前按引导准备环境；本机文件与命令操作仍遵循你设置的权限。"
      ],
      "note": "截图展示工作电脑设置页，示例环境未启动。"
    },
    "group": {
      "kicker": "01 / 多 AGENT 协作",
      "title": "多 Agent 群聊",
      "description": "把职责不同的 Bot 加入同一个群，分配任务、共享文件，或 @ 指定 Bot 处理后续步骤。",
      "points": [
        "每个 Bot 可单独配置职责、模型和工具。",
        "群成员共享任务材料和产出文件。",
        "伙伴也能互发私信；群聊使用群内上下文，不混入无关私聊记录。"
      ],
      "note": "以下是协作示意。Bot 类型不会被系统自动切换，分工和参与者由你选择。"
    }
  },
  "zh-TW": {
    "nav": [
      "多 Agent 協作",
      "工作電腦",
      "專業設計"
    ],
    "design": {
      "kicker": "03 / 專業角色 · 設計師",
      "title": "設計師與設計系統",
      "description": "設計師以獨立工作製作網頁原型、可編輯 PPT 與網站複刻，可選擇 152 套預裝設計系統。",
      "points": [
        "每套設計系統包含配色、字型、版面與元件參考。",
        "每個工作獨立選擇設計系統，停止工作後可以更改，也可以不指定。",
        "一邊對話一邊預覽，框選、標註，或直接修改網頁元素與原始碼。"
      ],
      "note": "設計師在預設工作目錄的 designers 下工作，無需啟動 VM。設計系統參考來自 OpenDesign，保留來源與授權；品牌風格參考不代表官方合作。"
    },
    "vm": {
      "kicker": "02 / Linux VM",
      "title": "Linux 工作電腦",
      "description": "通用 Bot 使用 Linux VM，支援查看執行過程、暫停工作與接管桌面。",
      "points": [
        "通用 Bot 各有工作目錄和桌面，在同一台受管理的 VM 中工作。",
        "瀏覽器、終端機和辦公應用程式支援調研、計算與檔案處理。",
        "啟動前依引導準備環境；本機檔案與命令操作仍遵循你設定的權限。"
      ],
      "note": "截圖展示工作電腦設定頁，範例環境尚未啟動。"
    },
    "group": {
      "kicker": "01 / 多 AGENT 協作",
      "title": "多 Agent 群組",
      "description": "將職責不同的 Bot 加入同一個群組，分配工作、共享檔案，或 @ 指定 Bot 處理後續步驟。",
      "points": [
        "每個 Bot 可單獨設定職責、模型與工具。",
        "群組成員共享工作資料與產出檔案。",
        "夥伴也能互傳私訊；群組使用群內上下文，不混入無關私訊紀錄。"
      ],
      "note": "以下為協作示意。Bot 類型不會被系統自動切換，分工和參與者由你選擇。"
    }
  },
  "en": {
    "nav": [
      "Multi-agent teamwork",
      "Work computer",
      "Design role"
    ],
    "design": {
      "kicker": "03 / SPECIALIST ROLE · DESIGNER",
      "title": "Designer and design systems",
      "description": "Designers create web prototypes, editable presentations and website clones as separate tasks, with a choice of 152 bundled design systems.",
      "points": [
        "Each design system includes color, typography, layout and component references.",
        "Choose a system for each task, change it while the task is stopped, or leave it unspecified.",
        "Preview alongside the conversation. Mark a region, annotate, or edit webpage elements and source."
      ],
      "note": "Designers work locally under designers in your default workspace, without starting a VM. References come from OpenDesign with source and license notices retained; brand-inspired styles do not imply endorsement."
    },
    "vm": {
      "kicker": "02 / LINUX VM",
      "title": "Linux work computer",
      "description": "General Bots use a Linux VM. View their activity, pause tasks or take over the desktop.",
      "points": [
        "General Bots have their own workspaces and desktops within one managed VM.",
        "Browser, terminal and office apps support research, computation and file editing.",
        "Prepare the environment through the setup guide. Host file and command access still follows your permission settings."
      ],
      "note": "The screenshot shows work computer settings with the example environment stopped."
    },
    "group": {
      "kicker": "01 / MULTI-AGENT COLLABORATION",
      "title": "Multi-agent group chat",
      "description": "Add Bots with different roles to a group, assign tasks, share files, or @ a Bot for a follow-up.",
      "points": [
        "Each Bot has its own role, model and tools.",
        "Group members share task materials and output files.",
        "Partners can also exchange private messages. Group context stays separate from unrelated private conversations."
      ],
      "note": "The conversation shown is an example. Bot types are never switched automatically; you choose the participants and their roles."
    }
  }
};
