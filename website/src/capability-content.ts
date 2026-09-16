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
      "description": "设计师按独立任务制作网页原型和可编辑 PPT，可选择 152 套预装设计系统。",
      "points": [
        "配色、字体、布局与组件参考，围绕同一个方向展开。",
        "每个任务独立选择设计系统，停止任务后可以更改，也可以不指定。",
        "一边对话一边预览，框选、标注，或直接修改网页元素与源码。"
      ],
      "note": "设计师在默认工作目录的 designers 下工作，无需启动 VM。设计系统参考来自 OpenDesign，保留来源与许可；品牌风格参考不代表官方合作。"
    },
    "vm": {
      "kicker": "02 / Linux VM",
      "title": "Linux 工作电脑",
      "description": "通用 Bot 可以在 Linux VM 中使用浏览器、终端和桌面应用。你可以查看工作过程，暂停任务或接管桌面。",
      "points": [
        "通用 Bot 各有工作目录和桌面，在同一台受管理的 VM 中工作。",
        "浏览器、终端和办公应用，把调研、计算与文件处理接起来。",
        "启动前按引导准备环境；本机文件与命令操作仍遵循你设置的权限。"
      ],
      "note": "截图展示工作电脑设置页，示例环境未启动。"
    },
    "group": {
      "kicker": "01 / 多 AGENT 协作",
      "title": "多 Agent 群聊",
      "description": "把职责不同的 Bot 加入同一个群，分配任务、共享文件，或 @ 指定 Bot 处理后续步骤。",
      "points": [
        "按职责、模型和工具配置伙伴，一人交代任务，多位 Agent 协作。",
        "让资料收集、数据处理、代码实现和报告撰写沿着同一项任务推进。",
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
      "description": "152 套設計系統預裝在應用程式裡。為設計師選好視覺方向，再把點子做成可互動的網頁原型或可編輯的 PPT。",
      "points": [
        "配色、字型、版面與元件參考，圍繞同一個方向展開。",
        "每個工作獨立選擇設計系統，停止工作後可以更改，也可以不指定。",
        "一邊對話一邊預覽，框選、標註，或直接修改網頁元素與原始碼。"
      ],
      "note": "設計師在預設工作目錄的 designers 下工作，無需啟動 VM。設計系統參考來自 OpenDesign，保留來源與授權；品牌風格參考不代表官方合作。"
    },
    "vm": {
      "kicker": "02 / Linux VM",
      "title": "Linux 工作電腦",
      "description": "通用 Bot 可以使用受管理的 Linux 工作電腦，開啟網頁、處理檔案、執行程式碼和操作桌面應用程式。你能看到它在做什麼，也能暫停或接管。",
      "points": [
        "通用 Bot 各有工作目錄和桌面，在同一台受管理的 VM 中工作。",
        "瀏覽器、終端機和辦公應用程式，把調研、計算與檔案處理串起來。",
        "啟動前依引導準備環境；本機檔案與命令操作仍遵循你設定的權限。"
      ],
      "note": "截圖展示工作電腦設定頁，範例環境尚未啟動。"
    },
    "group": {
      "kicker": "01 / 多 AGENT 協作",
      "title": "多 Agent 群組",
      "description": "為研究、程式、資料分析和寫作安排不同的 Agent，在同一個群組裡分工、交換檔案、討論結果。你可以隨時補充方向，或 @ 指定夥伴接手。",
      "points": [
        "按職責、模型和工具設定夥伴，一人交代工作，多位 Agent 協作。",
        "讓資料蒐集、資料處理、程式實作和報告撰寫沿著同一項工作推進。",
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
      "description": "152 design systems come bundled with the app. Choose a direction for your Designer, then turn an idea into an interactive web prototype or an editable presentation.",
      "points": [
        "Keep color, typography, layout and component references working together.",
        "Choose a system for each task, change it while the task is stopped, or leave it unspecified.",
        "Preview alongside the conversation. Mark a region, annotate, or edit webpage elements and source."
      ],
      "note": "Designers work locally under designers in your default workspace, without starting a VM. References come from OpenDesign with source and license notices retained; brand-inspired styles do not imply endorsement."
    },
    "vm": {
      "kicker": "02 / LINUX VM",
      "title": "Linux work computer",
      "description": "General Bots can use a managed Linux work computer to browse, process files, run code and operate desktop apps. Watch the work, pause it, or take over when needed.",
      "points": [
        "General Bots have their own workspaces and desktops within one managed VM.",
        "A browser, terminal and office apps connect research, computation and file work.",
        "Prepare the environment through the setup guide. Host file and command access still follows your permission settings."
      ],
      "note": "The screenshot shows work computer settings with the example environment stopped."
    },
    "group": {
      "kicker": "01 / MULTI-AGENT COLLABORATION",
      "title": "Multi-agent group chat",
      "description": "Give research, coding, data analysis and writing their own agents. Bring them into one group to divide the work, exchange files and discuss results. Add a direction or @ a partner to take the next step.",
      "points": [
        "Configure partners with different roles, models and tools, then give the team a shared task.",
        "Connect source gathering, data processing, implementation and report writing around the same objective.",
        "Partners can also exchange private messages. Group context stays separate from unrelated private conversations."
      ],
      "note": "The conversation shown is an example. Bot types are never switched automatically; you choose the participants and their roles."
    }
  }
};
