export type SiteLanguage = 'zh-CN' | 'zh-TW' | 'en';

export const siteLanguages: ReadonlyArray<{ value: SiteLanguage; label: string }> = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const;

export const siteCopy: Record<
  SiteLanguage,
  {
    blog: string;
    github: string;
    download: string;
    closeNav: string;
    openNav: string;
    downloadWindows: string;
    downloadMacArm: string;
    downloadAll: string;
    downloadWindowsShort: string;
    downloadMacArmShort: string;
    downloadMobileHint: string;
    downloadLinuxHint: string;
    downloadMacIntelHint: string;
    home: string;
    mainNav: string;
    footerNav: string;
    skip: string;
    heroEyebrow: string;
    heroTitle: string[];
    heroDescription: string;
    meet: string;
    seeCollab: string;
    castCaption: string;
    fromOne: string;
    workTitle: string[];
    workDescription: string;
    viewProduct: string[];
    productAlt: string[];
    productCaption: string;
    makingKicker: string;
    makingTitle: string[];
    makingDescription: string[];
    paperBack: string;
    paperOverline: string;
    paperTitle: string[];
    deliveryTitle: string;
    deliverySubtitle: string;
    personalityKicker: string;
    personalityTitle: string[];
    personalityDescription: string[];
    paletteAria: string;
    paletteNames: string[];
    paletteHint: string;
    memoryQuote: string;
    memoryDescription: string;
    possibilitiesKicker: string;
    possibilitiesTitle: string[];
    casePrompt: string;
    weeklyTitle: string;
    weeklyDescription: string;
    weeklyLink: string;
    questionsTitle: string;
    downloadKicker: string;
    downloadTitle: string[];
    footerTagline: string;
    realProduct: string;
    exampleContent: string;
    closeScreenshot: string;
    previousScreenshot: string;
    nextScreenshot: string;
    expandProduct: string;
    productViewAria: string;
    sceneAria: string;
    tryPalette: string;
  }
> = {
  'zh-CN': {
    blog: '博客',
    github: 'GitHub',
    download: '下载应用',
    closeNav: '关闭导航',
    openNav: '打开导航',
    downloadWindows: '下载 Windows 版',
    downloadMacArm: '下载 Mac 版（Apple 芯片）',
    downloadAll: '查看全部版本',
    downloadWindowsShort: 'Windows',
    downloadMacArmShort: 'Mac · Apple 芯片',
    downloadMobileHint: '这是桌面应用，请在电脑上下载安装。',
    downloadLinuxHint: '暂无 Linux 安装包，可下载 Windows 或 Mac 版。',
    downloadMacIntelHint: 'Mac 版只支持 Apple 芯片，Intel 芯片的 Mac 无法使用。',
    home: 'AelionBot 首页',
    mainNav: '主导航',
    footerNav: '页脚导航',
    skip: '跳至主要内容',
    heroEyebrow: 'AelionBot',
    heroTitle: ['通用多 Agent', '桌面工作空间'],
    heroDescription:
      '为 Agent 配置模型、职责和工具。通过群聊分工，使用 Linux VM 和本机工具完成调研、写作、代码与办公任务。',
    meet: '下载应用',
    seeCollab: '查看界面',
    castCaption: '对话 · 群聊 · 工具执行',
    fromOne: '界面截图',
    workTitle: ['对话与群聊'],
    workDescription: '与单个 Bot 处理任务，或在群聊中分配工作、交换文件。',
    viewProduct: ['单个 Bot', '群聊协作'],
    productAlt: [
      'AelionBot 当前版本的写作对话，展示分享讲稿和可保存的文件。',
      'AelionBot 当前版本的群聊，资料、灵感和写作伙伴共同准备分享讲稿。',
    ],
    productCaption: '当前版本界面 · 示例任务',
    makingKicker: '文件与应用',
    makingTitle: ['调研、计算', '与文件', '处理'],
    makingDescription: ['查资料、处理文件、使用应用。', '需要时使用 Linux VM，设计任务直接在本机完成。'],
    paperBack: '调研资料',
    paperOverline: '讲稿提纲',
    paperTitle: ['产品调研', '分享讲稿'],
    deliveryTitle: '分享讲稿',
    deliverySubtitle: '已生成',
    personalityKicker: 'Agent 配置',
    personalityTitle: ['按任务配置', '模型和角色'],
    personalityDescription: ['设置名称、职责、模型和配色。', '可以创建多个 Bot，分别处理不同类型的工作。'],
    paletteAria: '选择 Bot 配色',
    paletteNames: ['暮光紫', '晴空蓝', '薄荷绿', '蜜桃粉'],
    paletteHint: '选择配色',
    memoryQuote: '“回复时保留来源链接。”',
    memoryDescription: '保存经你确认的工作偏好。',
    possibilitiesKicker: '任务类型',
    possibilitiesTitle: ['调研、写作、代码', '与日常办公'],
    casePrompt: '任务示例',
    weeklyTitle: '定时任务',
    weeklyDescription: '安排一次性或周期性任务，执行时需要保持应用开启。',
    weeklyLink: '了解定时工作',
    questionsTitle: '常见问题',
    downloadKicker: 'AelionBot',
    downloadTitle: ['下载 AelionBot'],
    footerTagline: '通用多 Agent 桌面应用',
    realProduct: '真实产品界面 · 示例内容',
    exampleContent: '示例内容',
    closeScreenshot: '关闭图片',
    previousScreenshot: '上一张图片',
    nextScreenshot: '下一张图片',
    expandProduct: '放大界面截图',
    productViewAria: '查看产品界面',
    sceneAria: '资料、创意和文件成果的视觉演示',
    tryPalette: '选择 Bot 配色',
  },
  'zh-TW': {
    blog: '部落格',
    github: 'GitHub',
    download: '下載應用程式',
    closeNav: '關閉導覽',
    openNav: '開啟導覽',
    downloadWindows: '下載 Windows 版',
    downloadMacArm: '下載 Mac 版（Apple 晶片）',
    downloadAll: '查看全部版本',
    downloadWindowsShort: 'Windows',
    downloadMacArmShort: 'Mac · Apple 晶片',
    downloadMobileHint: '這是桌面應用程式，請在電腦上下載安裝。',
    downloadLinuxHint: '暫無 Linux 安裝包，可下載 Windows 或 Mac 版。',
    downloadMacIntelHint: 'Mac 版只支援 Apple 晶片，Intel 處理器的 Mac 無法使用。',
    home: 'AelionBot 首頁',
    mainNav: '主導覽',
    footerNav: '頁尾導覽',
    skip: '跳至主要內容',
    heroEyebrow: 'AelionBot',
    heroTitle: ['通用多 Agent', '桌面工作空間'],
    heroDescription:
      '為 Agent 設定模型、職責和工具。透過群組分工，使用 Linux VM 和本機工具完成調研、寫作、程式與辦公工作。',
    meet: '下載應用程式',
    seeCollab: '查看介面',
    castCaption: '對話 · 群組 · 工具執行',
    fromOne: '介面截圖',
    workTitle: ['對話與群組'],
    workDescription: '與單個 Bot 處理工作，或在群組中分工、交換檔案。',
    viewProduct: ['單個 Bot', '群組協作'],
    productAlt: [
      'AelionBot 目前版本的寫作對話，展示分享講稿和可儲存的檔案。',
      'AelionBot 目前版本的群組聊天，資料、靈感和寫作夥伴共同準備分享講稿。',
    ],
    productCaption: '目前版本介面 · 範例工作',
    makingKicker: '檔案與應用程式',
    makingTitle: ['調研、計算', '與檔案', '處理'],
    makingDescription: ['查資料、處理檔案、使用應用程式。', '需要時使用 Linux VM，設計工作直接在本機完成。'],
    paperBack: '調研資料',
    paperOverline: '講稿大綱',
    paperTitle: ['產品調研', '分享講稿'],
    deliveryTitle: '分享講稿',
    deliverySubtitle: '已產生',
    personalityKicker: 'Agent 設定',
    personalityTitle: ['按工作設定', '模型和角色'],
    personalityDescription: ['設定名稱、職責、模型和配色。', '可以建立多個 Bot，分別處理不同類型的工作。'],
    paletteAria: '選擇 Bot 配色',
    paletteNames: ['暮光紫', '晴空藍', '薄荷綠', '蜜桃粉'],
    paletteHint: '選擇配色',
    memoryQuote: '「回覆時保留來源連結。」',
    memoryDescription: '儲存經你確認的工作偏好。',
    possibilitiesKicker: '工作類型',
    possibilitiesTitle: ['調研、寫作、程式', '與日常辦公'],
    casePrompt: '工作範例',
    weeklyTitle: '排程工作',
    weeklyDescription: '安排一次性或週期性工作，執行時需要保持應用程式開啟。',
    weeklyLink: '了解排程工作',
    questionsTitle: '常見問題',
    downloadKicker: 'AelionBot',
    downloadTitle: ['下載 AelionBot'],
    footerTagline: '通用多 Agent 桌面應用程式',
    realProduct: '真實產品介面 · 範例內容',
    exampleContent: '範例內容',
    closeScreenshot: '關閉圖片',
    previousScreenshot: '上一張圖片',
    nextScreenshot: '下一張圖片',
    expandProduct: '放大介面截圖',
    productViewAria: '查看產品介面',
    sceneAria: '資料、創意和檔案成果的視覺演示',
    tryPalette: '選擇 Bot 配色',
  },
  en: {
    blog: 'Blog',
    github: 'GitHub',
    download: 'Download app',
    closeNav: 'Close navigation',
    openNav: 'Open navigation',
    downloadWindows: 'Download for Windows',
    downloadMacArm: 'Download for Mac (Apple Silicon)',
    downloadAll: 'See all downloads',
    downloadWindowsShort: 'Windows',
    downloadMacArmShort: 'Mac · Apple Silicon',
    downloadMobileHint: 'This is a desktop app. Download it on a computer.',
    downloadLinuxHint: 'No Linux build yet. You can download Windows or Mac.',
    downloadMacIntelHint: 'The Mac app requires Apple Silicon. Intel Macs are not supported.',
    home: 'AelionBot home',
    mainNav: 'Main navigation',
    footerNav: 'Footer navigation',
    skip: 'Skip to main content',
    heroEyebrow: 'AelionBot',
    heroTitle: ['A desktop workspace', 'for multiple AI agents'],
    heroDescription:
      'Configure models, roles and tools for your agents. Use group chats, a Linux VM and local tools for research, writing, code and office tasks.',
    meet: 'Download app',
    seeCollab: 'View the interface',
    castCaption: 'Conversations · Group chat · Tool execution',
    fromOne: 'INTERFACE SCREENSHOTS',
    workTitle: ['Conversations and group chats'],
    workDescription: 'Work with one Bot, or use group chat to assign tasks and exchange files.',
    viewProduct: ['Single Bot', 'Group chat'],
    productAlt: [
      'AelionBot writing conversation showing a shareable talk outline and saved files.',
      'AelionBot group chat where research, ideas, and writing partners prepare a talk outline together.',
    ],
    productCaption: 'Current interface · Example task',
    makingKicker: 'FILES AND APPS',
    makingTitle: ['Research,', 'calculate,', 'create files.'],
    makingDescription: [
      'Research, handle files, use apps.',
      'Use the Linux VM when needed; design work happens locally.',
    ],
    paperBack: 'Research notes',
    paperOverline: 'Talk outline',
    paperTitle: ['Product research', 'presentation'],
    deliveryTitle: 'Shareable outline',
    deliverySubtitle: 'Created',
    personalityKicker: 'AGENT CONFIGURATION',
    personalityTitle: ['Configure models', 'and roles'],
    personalityDescription: ['Set a name, role, model and color.', 'Create multiple Bots for different types of work.'],
    paletteAria: 'Choose Bot colors',
    paletteNames: ['Twilight violet', 'Clear sky blue', 'Mint green', 'Peach pink'],
    paletteHint: 'Select a color',
    memoryQuote: '“Include source links in your replies.”',
    memoryDescription: 'Save work preferences that you have confirmed.',
    possibilitiesKicker: 'TASK TYPES',
    possibilitiesTitle: ['Research, writing, code', 'and office tasks'],
    casePrompt: 'Example task',
    weeklyTitle: 'Scheduled tasks',
    weeklyDescription: 'Set one-off or recurring tasks. Keep the app open while they run.',
    weeklyLink: 'Explore scheduled work',
    questionsTitle: 'Frequently asked questions',
    downloadKicker: 'AelionBot',
    downloadTitle: ['Download AelionBot'],
    footerTagline: 'A general-purpose multi-agent desktop app',
    realProduct: 'Real product interface · Example content',
    exampleContent: 'Example content',
    closeScreenshot: 'Close image',
    previousScreenshot: 'Previous image',
    nextScreenshot: 'Next image',
    expandProduct: 'Enlarge interface screenshot',
    productViewAria: 'View product interface',
    sceneAria: 'A visual demonstration of research, ideas, and file results',
    tryPalette: 'Choose Bot colors',
  },
};

export const siteQuestions: Record<SiteLanguage, ReadonlyArray<{ question: string; answer: string }>> = {
  'zh-CN': [
    {
      question: '如何开始使用？',
      answer: '安装应用，添加模型服务的 API Key，创建 Bot 后即可发送任务。模型服务单独计费。',
    },
    {
      question: '可以决定伙伴能做哪些事吗？',
      answer:
        '可以。你决定它能接触哪些资料、怎样获得操作许可。任务过程中可以补充要求、暂停工作，通用 Bot 使用工作电脑时，你也可以亲自接管。',
    },
    {
      question: '群聊里怎样安排工作？',
      answer:
        '把职责不同的 Bot 加入同一个群，分享目标和材料，或 @ 指定伙伴接手。研究、代码、分析与写作可以沿着同一项任务协作；伙伴也能通过私信交换与任务有关的文件。分工和参与者由你决定。',
    },
    {
      question: '做设计需要单独的设计师 Bot 吗？',
      answer:
        '不需要。每个 Bot 都能做设计：要原型、PPT 或网站复刻时，它会在当前对话里建立设计任务，设计稿显示在对话旁的画布卡片里。设计任务在本机 designers 目录进行，不用启动 VM，也不用换 Bot。',
    },
    {
      question: '设计系统需要另外安装吗？',
      answer:
        '不需要。152 套设计系统随应用预装，参考文件可以离线读取。用哪一套由 Bot 按需求决定，也可以不用；设置里可以搜索、筛选和导入。模型服务与外部素材仍可能需要联网。',
    },
    {
      question: '定时工作需要一直开着应用吗？',
      answer: '需要。支持一次性、每日或每周任务。',
    },
    {
      question: '有 Mac 版本吗？',
      answer:
        '有，支持 Apple 芯片的 Mac，不支持 Intel 芯片的 Mac。下载区域会按这台电脑推荐安装包，也可以改选其他版本。',
    },
  ],
  'zh-TW': [
    {
      question: '如何開始使用？',
      answer: '安裝應用程式，新增模型服務的 API Key，建立 Bot 後即可傳送工作。模型服務另外計費。',
    },
    {
      question: '可以決定夥伴能做哪些事嗎？',
      answer:
        '可以。你決定它能接觸哪些資料、如何取得操作許可。工作過程中可以補充要求、暫停工作，通用 Bot 使用工作電腦時，你也可以親自接管。',
    },
    {
      question: '群組裡怎樣安排工作？',
      answer:
        '把職責不同的 Bot 加入同一個群組，分享目標和資料，或 @ 指定夥伴接手。研究、程式、分析與寫作可以圍繞同一項工作協作；夥伴也能透過私訊交換與工作有關的檔案。分工和參與者由你決定。',
    },
    {
      question: '做設計需要單獨的設計師 Bot 嗎？',
      answer:
        '不需要。每個 Bot 都能做設計：要原型、PPT 或網站複刻時，它會在目前對話裡建立設計工作，設計稿顯示在對話旁的畫布卡片裡。設計工作在本機 designers 目錄進行，不用啟動 VM，也不用換 Bot。',
    },
    {
      question: '設計系統需要另外安裝嗎？',
      answer:
        '不需要。152 套設計系統隨應用程式預裝，參考檔案可離線讀取。用哪一套由 Bot 依需求決定，也可以不用；設定裡可以搜尋、篩選和匯入。模型服務與外部素材仍可能需要連線。',
    },
    {
      question: '排程工作需要一直開著應用程式嗎？',
      answer: '需要。支援一次性、每日或每週工作。',
    },
    {
      question: '有 Mac 版本嗎？',
      answer:
        '有，支援 Apple 晶片的 Mac，不支援 Intel 處理器的 Mac。下載區域會按這台電腦推薦安裝包，也可以改選其他版本。',
    },
  ],
  en: [
    {
      question: 'How do I get started?',
      answer:
        'Install the app, add your model service API key, and create a Bot to start a task. Model services are billed separately.',
    },
    {
      question: 'Can I decide what a partner is allowed to do?',
      answer:
        'Yes. You decide which materials it can access and how it asks for permission. Add requirements, pause the work, or take over a General Bot’s VM desktop when needed.',
    },
    {
      question: 'How do I organize work in a group?',
      answer:
        'Add Bots with different responsibilities, share the goal and materials, or @ a partner to take the next step. Research, code, analysis and writing can contribute to the same task. Partners can also exchange task-related files privately. You choose the participants and their roles.',
    },
    {
      question: 'Do I need a separate designer Bot for design work?',
      answer:
        'No. Every Bot can do design. Ask for a prototype, a presentation or a website clone and it starts a design task in the same conversation; the design shows in a canvas card beside the chat. Design tasks run locally in your designers folder, without starting a VM or switching Bots.',
    },
    {
      question: 'Do design systems need a separate installation?',
      answer:
        'No. All 152 systems come bundled, and their reference files can be read offline. The Bot chooses one to fit the request, or none; browse, filter and import in Settings. Model services and external assets may still require an internet connection.',
    },
    {
      question: 'Does scheduled work require the app to stay open?',
      answer: 'Yes. Tasks can run once, daily or weekly.',
    },
    {
      question: 'Is there a Mac version?',
      answer:
        'Yes, for Macs with Apple Silicon. Intel Macs are not supported. The download section recommends a build for this computer, and other builds are linked underneath.',
    },
  ],
};
