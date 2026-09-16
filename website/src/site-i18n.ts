export type SiteLanguage='zh-CN'|'zh-TW'|'en';

export const siteLanguages:ReadonlyArray<{value:SiteLanguage;label:string}>=([
  {value:'en',label:'English'},
  {value:'zh-CN',label:'简体中文'},
  {value:'zh-TW',label:'繁體中文'},
  
] as const);

export const siteCopy:Record<SiteLanguage,{
  blog:string;github:string;download:string;closeNav:string;openNav:string;downloadWindows:string;downloadMacArm:string;downloadMacIntel:string;downloadAll:string;downloadWindowsShort:string;downloadMacArmShort:string;downloadMacIntelShort:string;downloadMobileHint:string;downloadLinuxHint:string;home:string;mainNav:string;footerNav:string;skip:string;heroEyebrow:string;heroTitle:string[];heroDescription:string;meet:string;seeCollab:string;castCaption:string;fromOne:string;workTitle:string[];workDescription:string;viewProduct:string[];productAlt:string[];productCaption:string;makingKicker:string;makingTitle:string[];makingDescription:string[];paperBack:string;paperOverline:string;paperTitle:string[];deliveryTitle:string;deliverySubtitle:string;personalityKicker:string;personalityTitle:string[];personalityDescription:string[];paletteAria:string;paletteNames:string[];paletteHint:string;memoryQuote:string;memoryDescription:string;possibilitiesKicker:string;possibilitiesTitle:string[];casePrompt:string;weeklyTitle:string;weeklyDescription:string;weeklyLink:string;questionsTitle:string;downloadKicker:string;downloadTitle:string[];footerTagline:string;realProduct:string;exampleContent:string;closeScreenshot:string;previousScreenshot:string;nextScreenshot:string;expandProduct:string;productViewAria:string;sceneAria:string;tryPalette:string;
}>={
  "zh-CN": {
    "blog": "博客",
    "github": "GitHub",
    "download": "下载应用",
    "closeNav": "关闭导航",
    "openNav": "打开导航",
    "downloadWindows": "下载 Windows 版",
    "downloadMacArm": "下载 Mac 版（Apple 芯片）",
    "downloadMacIntel": "下载 Mac 版（Intel）",
    "downloadAll": "查看全部版本",
    "downloadWindowsShort": "Windows",
    "downloadMacArmShort": "Mac · Apple 芯片",
    "downloadMacIntelShort": "Mac · Intel",
    "downloadMobileHint": "这是桌面应用，请在电脑上下载安装。",
    "downloadLinuxHint": "暂无 Linux 安装包，可下载 Windows 或 Mac 版。",
    "home": "AelionBot 首页",
    "mainNav": "主导航",
    "footerNav": "页脚导航",
    "skip": "跳至主要内容",
    "heroEyebrow": "AelionBot",
    "heroTitle": [
      "通用多 Agent",
      "桌面工作空间"
    ],
    "heroDescription": "为 Agent 配置模型、职责和工具。通过群聊分工，使用 Linux VM 和本机工具完成调研、写作、代码与办公任务。",
    "meet": "下载应用",
    "seeCollab": "查看界面",
    "castCaption": "对话 · 群聊 · 工具执行",
    "fromOne": "界面截图",
    "workTitle": [
      "对话与群聊"
    ],
    "workDescription": "与单个 Bot 处理任务，或在群聊中分配工作、交换文件。",
    "viewProduct": [
      "和伙伴聊聊",
      "让团队一起做"
    ],
    "productAlt": [
      "AelionBot 当前版本的写作对话，展示分享讲稿和可保存的文件。",
      "AelionBot 当前版本的群聊，资料、灵感和写作伙伴共同准备分享讲稿。"
    ],
    "productCaption": "当前版本界面 · 示例任务",
    "makingKicker": "会想，也会动手",
    "makingTitle": [
      "让成果，",
      "从对话里",
      "走出来。"
    ],
    "makingDescription": [
      "查资料、处理文件、使用应用。",
      "通用 Bot 使用 VM，设计师在本机创作。"
    ],
    "paperBack": "资料，变得有头绪。",
    "paperOverline": "写下来的想法",
    "paperTitle": [
      "让灵感，",
      "有处可去。"
    ],
    "deliveryTitle": "分享讲稿",
    "deliverySubtitle": "准备好了，看看吧。",
    "personalityKicker": "Agent 配置",
    "personalityTitle": [
      "按任务配置",
      "模型和角色"
    ],
    "personalityDescription": [
      "设置名称、职责、模型和配色。",
      "可以创建多个 Bot，分别处理不同类型的工作。"
    ],
    "paletteAria": "试试伙伴的配色",
    "paletteNames": [
      "暮光紫",
      "晴空蓝",
      "薄荷绿",
      "蜜桃粉"
    ],
    "paletteHint": "选择配色",
    "memoryQuote": "“回复时保留来源链接。”",
    "memoryDescription": "保存经你确认的工作偏好。",
    "possibilitiesKicker": "任务类型",
    "possibilitiesTitle": [
      "调研、写作、代码",
      "与日常办公"
    ],
    "casePrompt": "试着这样开口",
    "weeklyTitle": "定时任务",
    "weeklyDescription": "安排一次性或周期性任务，执行时需要保持应用开启。",
    "weeklyLink": "了解定时工作",
    "questionsTitle": "常见问题",
    "downloadKicker": "AelionBot",
    "downloadTitle": [
      "下载 AelionBot"
    ],
    "footerTagline": "通用多 Agent 桌面应用",
    "realProduct": "真实产品界面 · 示例内容",
    "exampleContent": "示例内容",
    "closeScreenshot": "关闭图片",
    "previousScreenshot": "上一张图片",
    "nextScreenshot": "下一张图片",
    "expandProduct": "放大界面截图",
    "productViewAria": "查看产品界面",
    "sceneAria": "资料、创意和文件成果的视觉演示",
    "tryPalette": "试试伙伴的配色"
  },
  "zh-TW": {
    "blog": "部落格",
    "github": "GitHub",
    "download": "下載應用程式",
    "closeNav": "關閉導覽",
    "openNav": "開啟導覽",
    "downloadWindows": "下載 Windows 版",
    "downloadMacArm": "下載 Mac 版（Apple 晶片）",
    "downloadMacIntel": "下載 Mac 版（Intel）",
    "downloadAll": "查看全部版本",
    "downloadWindowsShort": "Windows",
    "downloadMacArmShort": "Mac · Apple 晶片",
    "downloadMacIntelShort": "Mac · Intel",
    "downloadMobileHint": "這是桌面應用程式，請在電腦上下載安裝。",
    "downloadLinuxHint": "暫無 Linux 安裝包，可下載 Windows 或 Mac 版。",
    "home": "AelionBot 首頁",
    "mainNav": "主導覽",
    "footerNav": "頁尾導覽",
    "skip": "跳至主要內容",
    "heroEyebrow": "AelionBot",
    "heroTitle": [
      "通用多 Agent",
      "桌面工作空間"
    ],
    "heroDescription": "為 Agent 設定模型、職責和工具。透過群組分工，使用 Linux VM 和本機工具完成調研、寫作、程式與辦公工作。",
    "meet": "下載應用程式",
    "seeCollab": "查看介面",
    "castCaption": "對話 · 群組 · 工具執行",
    "fromOne": "介面截圖",
    "workTitle": [
      "對話與群組"
    ],
    "workDescription": "與單個 Bot 處理工作，或在群組中分工、交換檔案。",
    "viewProduct": [
      "和夥伴聊聊",
      "讓團隊一起做"
    ],
    "productAlt": [
      "AelionBot 目前版本的寫作對話，展示分享講稿和可儲存的檔案。",
      "AelionBot 目前版本的群組聊天，資料、靈感和寫作夥伴共同準備分享講稿。"
    ],
    "productCaption": "目前版本介面 · 範例工作",
    "makingKicker": "會想，也會動手",
    "makingTitle": [
      "讓成果，",
      "從對話裡",
      "走出來。"
    ],
    "makingDescription": [
      "查資料、處理檔案、使用應用程式。",
      "通用 Bot 使用 VM，設計師在本機創作。"
    ],
    "paperBack": "資料，變得有頭緒。",
    "paperOverline": "寫下來的想法",
    "paperTitle": [
      "讓靈感，",
      "有處可去。"
    ],
    "deliveryTitle": "分享講稿",
    "deliverySubtitle": "準備好了，看看吧。",
    "personalityKicker": "Agent 設定",
    "personalityTitle": [
      "按工作設定",
      "模型和角色"
    ],
    "personalityDescription": [
      "設定名稱、職責、模型和配色。",
      "可以建立多個 Bot，分別處理不同類型的工作。"
    ],
    "paletteAria": "試試夥伴的配色",
    "paletteNames": [
      "暮光紫",
      "晴空藍",
      "薄荷綠",
      "蜜桃粉"
    ],
    "paletteHint": "選擇配色",
    "memoryQuote": "「回覆時保留來源連結。」",
    "memoryDescription": "儲存經你確認的工作偏好。",
    "possibilitiesKicker": "工作類型",
    "possibilitiesTitle": [
      "調研、寫作、程式",
      "與日常辦公"
    ],
    "casePrompt": "可以這樣開口",
    "weeklyTitle": "排程工作",
    "weeklyDescription": "安排一次性或週期性工作，執行時需要保持應用程式開啟。",
    "weeklyLink": "了解排程工作",
    "questionsTitle": "常見問題",
    "downloadKicker": "AelionBot",
    "downloadTitle": [
      "下載 AelionBot"
    ],
    "footerTagline": "通用多 Agent 桌面應用程式",
    "realProduct": "真實產品介面 · 範例內容",
    "exampleContent": "範例內容",
    "closeScreenshot": "關閉圖片",
    "previousScreenshot": "上一張圖片",
    "nextScreenshot": "下一張圖片",
    "expandProduct": "放大介面截圖",
    "productViewAria": "查看產品介面",
    "sceneAria": "資料、創意和檔案成果的視覺演示",
    "tryPalette": "試試夥伴的配色"
  },
  "en": {
    "blog": "Blog",
    "github": "GitHub",
    "download": "Download app",
    "closeNav": "Close navigation",
    "openNav": "Open navigation",
    "downloadWindows": "Download for Windows",
    "downloadMacArm": "Download for Mac (Apple Silicon)",
    "downloadMacIntel": "Download for Mac (Intel)",
    "downloadAll": "See all downloads",
    "downloadWindowsShort": "Windows",
    "downloadMacArmShort": "Mac · Apple Silicon",
    "downloadMacIntelShort": "Mac · Intel",
    "downloadMobileHint": "This is a desktop app. Download it on a computer.",
    "downloadLinuxHint": "No Linux build yet. You can download Windows or Mac.",
    "home": "AelionBot home",
    "mainNav": "Main navigation",
    "footerNav": "Footer navigation",
    "skip": "Skip to main content",
    "heroEyebrow": "AelionBot",
    "heroTitle": [
      "A desktop workspace",
      "for multiple AI agents"
    ],
    "heroDescription": "Configure models, roles and tools for your agents. Use group chats, a Linux VM and local tools for research, writing, code and office tasks.",
    "meet": "Download app",
    "seeCollab": "View the interface",
    "castCaption": "Conversations · Group chat · Tool execution",
    "fromOne": "INTERFACE SCREENSHOTS",
    "workTitle": [
      "Conversations and group chats"
    ],
    "workDescription": "Work with one Bot, or use group chat to assign tasks and exchange files.",
    "viewProduct": [
      "Chat with a partner",
      "Work as a team"
    ],
    "productAlt": [
      "AelionBot writing conversation showing a shareable talk outline and saved files.",
      "AelionBot group chat where research, ideas, and writing partners prepare a talk outline together."
    ],
    "productCaption": "Current interface · Example task",
    "makingKicker": "Thinks, then does",
    "makingTitle": [
      "Beyond chat.",
      "Into the",
      "real world."
    ],
    "makingDescription": [
      "Research, handle files, use apps.",
      "Your partner has its own work computer."
    ],
    "paperBack": "Make the material make sense.",
    "paperOverline": "Ideas, written down",
    "paperTitle": [
      "Give ideas",
      "somewhere to go."
    ],
    "deliveryTitle": "Shareable outline",
    "deliverySubtitle": "Ready when you are.",
    "personalityKicker": "AGENT CONFIGURATION",
    "personalityTitle": [
      "Configure models",
      "and roles"
    ],
    "personalityDescription": [
      "Set a name, role, model and color.",
      "Create multiple Bots for different types of work."
    ],
    "paletteAria": "Try the partner colors",
    "paletteNames": [
      "Twilight violet",
      "Clear sky blue",
      "Mint green",
      "Peach pink"
    ],
    "paletteHint": "Select a color",
    "memoryQuote": "“Include source links in your replies.”",
    "memoryDescription": "Save work preferences that you have confirmed.",
    "possibilitiesKicker": "TASK TYPES",
    "possibilitiesTitle": [
      "Research, writing, code",
      "and office tasks"
    ],
    "casePrompt": "Try saying it this way",
    "weeklyTitle": "Scheduled tasks",
    "weeklyDescription": "Set one-off or recurring tasks. Keep the app open while they run.",
    "weeklyLink": "Explore scheduled work",
    "questionsTitle": "Frequently asked questions",
    "downloadKicker": "AelionBot",
    "downloadTitle": [
      "Download AelionBot"
    ],
    "footerTagline": "A general-purpose multi-agent desktop app",
    "realProduct": "Real product interface · Example content",
    "exampleContent": "Example content",
    "closeScreenshot": "Close image",
    "previousScreenshot": "Previous image",
    "nextScreenshot": "Next image",
    "expandProduct": "Enlarge interface screenshot",
    "productViewAria": "View product interface",
    "sceneAria": "A visual demonstration of research, ideas, and file results",
    "tryPalette": "Try the partner colors"
  }
};

export const siteExamples:Record<SiteLanguage,ReadonlyArray<{name:string;prompt:string;result:string;file:string;tone:'violet'|'blue'|'mint'|'peach'}>>={
  'zh-CN':[
    {name:'准备分享',prompt:'把这些材料，变成一场十分钟的分享。',result:'帮你把重点讲清楚。',file:'分享讲稿.docx',tone:'violet'},
    {name:'整理资料',prompt:'帮我读完这些资料，留下真正值得看的。',result:'重点与出处，都替你整理好。',file:'主题资料整理.pdf',tone:'blue'},
    {name:'看懂报表',prompt:'这几份表格里，有哪些变化值得关注？',result:'让一整页数字变得有头绪。',file:'本周数据汇总.xlsx',tone:'mint'},
    {name:'做个小工具',prompt:'我想做一个自己用着顺手的小工具。',result:'边聊边调整，让想法可以用。',file:'我的小工具.html',tone:'peach'},
  ],
  'zh-TW':[
    {name:'準備分享',prompt:'把這些資料，變成一場十分鐘的分享。',result:'幫你把重點說清楚。',file:'分享講稿.docx',tone:'violet'},
    {name:'整理資料',prompt:'幫我讀完這些資料，留下真正值得看的。',result:'重點與出處，都替你整理好。',file:'主題資料整理.pdf',tone:'blue'},
    {name:'看懂報表',prompt:'這幾份表格裡，有哪些變化值得注意？',result:'讓一整頁數字變得有頭緒。',file:'本週資料彙總.xlsx',tone:'mint'},
    {name:'做個小工具',prompt:'我想做一個自己用起來順手的小工具。',result:'邊聊邊調整，讓想法可以使用。',file:'我的小工具.html',tone:'peach'},
  ],
  en:[
    {name:'Prepare a talk',prompt:'Turn these materials into a ten-minute talk.',result:'The key points, clearly told.',file:'talk-outline.docx',tone:'violet'},
    {name:'Research notes',prompt:'Read these materials and keep what is worth my time.',result:'Key points and sources, organized.',file:'research-notes.pdf',tone:'blue'},
    {name:'Understand a report',prompt:'What changes in these spreadsheets are worth attention?',result:'A page of numbers, made clear.',file:'weekly-summary.xlsx',tone:'mint'},
    {name:'Build a small tool',prompt:'I want a small tool that feels good to use.',result:'Shape the idea as you talk.',file:'my-small-tool.html',tone:'peach'},
  ]
};

export const siteQuestions:Record<SiteLanguage,ReadonlyArray<{question:string;answer:string}>>={
  "zh-CN": [
    {
      "question": "怎样开始和伙伴一起工作？",
      "answer": "下载适合这台电脑的安装包，按引导连接你想使用的 AI 服务。给伙伴起个名字、安排职责，就能交给它第一件事。AI 服务的使用费用按你所选服务计算。"
    },
    {
      "question": "可以决定伙伴能做哪些事吗？",
      "answer": "可以。你决定它能接触哪些资料、怎样获得操作许可。任务过程中可以补充要求、暂停工作，通用 Bot 使用工作电脑时，你也可以亲自接管。"
    },
    {
      "question": "群聊里怎样安排工作？",
      "answer": "把职责不同的 Bot 加入同一个群，分享目标和材料，或 @ 指定伙伴接手。研究、代码、分析与写作可以沿着同一项任务协作；伙伴也能通过私信交换与任务有关的文件。分工和参与者由你决定。"
    },
    {
      "question": "通用 Bot 和设计师有什么区别？",
      "answer": "通用 Bot 负责调研、文件处理、代码和桌面操作，可以使用 Linux VM；设计师按独立任务制作网页原型和可编辑 PPT，在本机 designers 目录工作。新建时选择类型，也可以在资料里更改；更改类型需要确认清空该 Bot 的上下文。"
    },
    {
      "question": "设计系统需要另外安装吗？",
      "answer": "不需要。152 套设计系统随应用预装，参考文件可以离线读取。每个任务独立选择，停止后可更改；也可以不指定。模型服务与外部素材仍可能需要联网。"
    },
    {
      "question": "定时工作需要一直开着应用吗？",
      "answer": "任务执行时需要保持应用开启。你可以安排一次性的事情，也可以让伙伴每天或每周重复处理例行工作。"
    },
    {
      "question": "有 Mac 版本吗？",
      "answer": "有。下载区域会按这台电脑推荐 Windows、Apple 芯片或 Intel 安装包，也可以改选其他版本。"
    }
  ],
  "zh-TW": [
    {
      "question": "怎樣開始和夥伴一起工作？",
      "answer": "下載適合這台電腦的安裝包，依照引導連線你想使用的 AI 服務。替夥伴取名、安排職責，就能交給它第一件事。AI 服務費用依你選擇的服務計算。"
    },
    {
      "question": "可以決定夥伴能做哪些事嗎？",
      "answer": "可以。你決定它能接觸哪些資料、如何取得操作許可。工作過程中可以補充要求、暫停工作，通用 Bot 使用工作電腦時，你也可以親自接管。"
    },
    {
      "question": "群組裡怎樣安排工作？",
      "answer": "把職責不同的 Bot 加入同一個群組，分享目標和資料，或 @ 指定夥伴接手。研究、程式、分析與寫作可以圍繞同一項工作協作；夥伴也能透過私訊交換與工作有關的檔案。分工和參與者由你決定。"
    },
    {
      "question": "通用 Bot 和設計師有什麼差別？",
      "answer": "通用 Bot 負責調研、檔案處理、程式碼與桌面操作，可以使用 Linux VM；設計師以獨立工作製作網頁原型和可編輯 PPT，在本機 designers 目錄工作。建立時選擇類型，也能在資料中更改；更改類型需要確認清空該 Bot 的上下文。"
    },
    {
      "question": "設計系統需要另外安裝嗎？",
      "answer": "不需要。152 套設計系統隨應用程式預裝，參考檔案可離線讀取。每個工作獨立選擇，停止後可更改，也可以不指定。模型服務與外部素材仍可能需要連線。"
    },
    {
      "question": "排程工作需要一直開著應用程式嗎？",
      "answer": "執行工作時需要保持應用程式開啟。你可以安排一次性工作，也可以讓夥伴每天或每週重複處理例行工作。"
    },
    {
      "question": "有 Mac 版本嗎？",
      "answer": "有。下載區域會按這台電腦推薦 Windows、Apple 晶片或 Intel 安裝包，也可以改選其他版本。"
    }
  ],
  "en": [
    {
      "question": "How do I start working with a partner?",
      "answer": "Download the installer for this computer and connect the AI service you want to use. Name your partner, give it a role, and hand it a first task. AI service charges depend on the service you choose."
    },
    {
      "question": "Can I decide what a partner is allowed to do?",
      "answer": "Yes. You decide which materials it can access and how it asks for permission. Add requirements, pause the work, or take over a General Bot’s VM desktop when needed."
    },
    {
      "question": "How do I organize work in a group?",
      "answer": "Add Bots with different responsibilities, share the goal and materials, or @ a partner to take the next step. Research, code, analysis and writing can contribute to the same task. Partners can also exchange task-related files privately. You choose the participants and their roles."
    },
    {
      "question": "How are General Bots and Designers different?",
      "answer": "General Bots handle research, files, code and desktop work, with access to a Linux VM. Designers create web prototypes and editable presentations as separate tasks in your local designers folder. Choose a type at creation or change it in the profile; switching requires confirmation that the Bot’s context will be cleared."
    },
    {
      "question": "Do design systems need a separate installation?",
      "answer": "No. All 152 systems come bundled, and their reference files can be read offline. Each task has its own selection, which can be changed while stopped or left unspecified. Model services and external assets may still require an internet connection."
    },
    {
      "question": "Does scheduled work require the app to stay open?",
      "answer": "The app needs to stay open while a task runs. Schedule one-off work, or have a partner repeat routine work daily or weekly."
    },
    {
      "question": "Is there a Mac version?",
      "answer": "Yes. The download section recommends Windows, Apple Silicon, or Intel based on this computer. Other builds are linked underneath."
    }
  ]
};
