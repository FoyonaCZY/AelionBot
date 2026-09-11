export type SiteLanguage='zh-CN'|'zh-TW'|'en';

export const siteLanguages:ReadonlyArray<{value:SiteLanguage;label:string}>=([
  {value:'en',label:'English'},
  {value:'zh-CN',label:'简体中文'},
  {value:'zh-TW',label:'繁體中文'},
  
] as const);

export const siteCopy:Record<SiteLanguage,{
  blog:string;github:string;download:string;closeNav:string;openNav:string;downloadWindows:string;downloadMacArm:string;downloadMacIntel:string;downloadAll:string;downloadWindowsShort:string;downloadMacArmShort:string;downloadMacIntelShort:string;downloadMobileHint:string;downloadLinuxHint:string;home:string;mainNav:string;footerNav:string;skip:string;heroEyebrow:string;heroTitle:string[];heroDescription:string;meet:string;seeCollab:string;castCaption:string;fromOne:string;workTitle:string[];workDescription:string;viewProduct:string[];productAlt:string[];productCaption:string;makingKicker:string;makingTitle:string[];makingDescription:string[];paperBack:string;paperOverline:string;paperTitle:string[];deliveryTitle:string;deliverySubtitle:string;personalityKicker:string;personalityTitle:string[];personalityDescription:string[];paletteAria:string;paletteNames:string[];paletteHint:string;memoryQuote:string;memoryDescription:string;possibilitiesKicker:string;possibilitiesTitle:string[];casePrompt:string;weeklyTitle:string;weeklyDescription:string;weeklyLink:string;questionsTitle:string;downloadKicker:string;downloadTitle:string[];footerTagline:string;realProduct:string;exampleContent:string;closeScreenshot:string;previousScreenshot:string;nextScreenshot:string;expandProduct:string;productViewAria:string;sceneAria:string;tryPalette:string;
}>={
  'zh-CN':{
    blog:'博客',github:'GitHub',download:'下载应用',closeNav:'关闭导航',openNav:'打开导航',downloadWindows:'下载 Windows 版',downloadMacArm:'下载 Mac 版（Apple 芯片）',downloadMacIntel:'下载 Mac 版（Intel）',downloadAll:'查看全部版本',downloadWindowsShort:'Windows',downloadMacArmShort:'Mac · Apple 芯片',downloadMacIntelShort:'Mac · Intel',downloadMobileHint:'这是桌面应用，请在电脑上下载安装。',downloadLinuxHint:'暂无 Linux 安装包，可下载 Windows 或 Mac 版。',home:'AelionBot 首页',mainNav:'主导航',footerNav:'页脚导航',skip:'跳至主要内容',heroEyebrow:'AelionBot · 你的 AI 工作伙伴',heroTitle:['好想法。','一起做出来。'],heroDescription:'让擅长不同事情的伙伴，来到你的桌面。',meet:'认识你的伙伴',seeCollab:'看看怎么合作',castCaption:'各有本事。一起做事。',fromOne:'从一句话开始',workTitle:['聊着聊着，','事情就做出来了。'],workDescription:'单独交代一件事，或让几位伙伴接力完成。',viewProduct:['和伙伴聊聊','让团队一起做'],productAlt:['AelionBot 当前版本的写作对话，展示分享讲稿和可保存的文件。','AelionBot 当前版本的群聊，资料、灵感和写作伙伴共同准备分享讲稿。'],productCaption:'当前版本界面 · 示例任务',makingKicker:'会想，也会动手',makingTitle:['让成果，','从对话里','走出来。'],makingDescription:['查资料、处理文件、使用应用。','伙伴有自己的工作电脑。'],paperBack:'资料，变得有头绪。',paperOverline:'写下来的想法',paperTitle:['让灵感，','有处可去。'],deliveryTitle:'分享讲稿',deliverySubtitle:'准备好了，看看吧。',personalityKicker:'很有个性，也很合拍',personalityTitle:['你的伙伴。','你的样子。'],personalityDescription:['名字、职责、配色，都由你决定。','写作搭档，资料助手，或随时陪你聊灵感的朋友。'],paletteAria:'试试伙伴的配色',paletteNames:['暮光紫','晴空蓝','薄荷绿','蜜桃粉'],paletteHint:'点一点，换个心情。',memoryQuote:'“下次，也用这套风格。”',memoryDescription:'记下你确认过的偏好，让合作接得上。',possibilitiesKicker:'先从哪件事开始？',possibilitiesTitle:['你正好需要。','它正好拿手。'],casePrompt:'试着这样开口',weeklyTitle:'每周的老任务，也有人惦记。',weeklyDescription:'约好时间，把周报、资料整理安排给伙伴。',weeklyLink:'了解定时工作',questionsTitle:'还有几个小问题。',downloadKicker:'AelionBot',downloadTitle:['下一件事，','一起做。'],footerTagline:'有想法，就一起动手。',realProduct:'真实产品界面 · 示例内容',exampleContent:'示例内容',closeScreenshot:'关闭图片',previousScreenshot:'上一张图片',nextScreenshot:'下一张图片',expandProduct:'放大查看功能示意',productViewAria:'查看产品界面',sceneAria:'资料、创意和文件成果的视觉演示',tryPalette:'试试伙伴的配色'
  },
  'zh-TW':{
    blog:'部落格',github:'GitHub',download:'下載應用程式',closeNav:'關閉導覽',openNav:'開啟導覽',downloadWindows:'下載 Windows 版',downloadMacArm:'下載 Mac 版（Apple 晶片）',downloadMacIntel:'下載 Mac 版（Intel）',downloadAll:'查看全部版本',downloadWindowsShort:'Windows',downloadMacArmShort:'Mac · Apple 晶片',downloadMacIntelShort:'Mac · Intel',downloadMobileHint:'這是桌面應用程式，請在電腦上下載安裝。',downloadLinuxHint:'暫無 Linux 安裝包，可下載 Windows 或 Mac 版。',home:'AelionBot 首頁',mainNav:'主導覽',footerNav:'頁尾導覽',skip:'跳至主要內容',heroEyebrow:'AelionBot · 你的 AI 工作夥伴',heroTitle:['好點子。','一起做出來。'],heroDescription:'讓擅長不同事情的夥伴，來到你的桌面。',meet:'認識你的夥伴',seeCollab:'看看怎麼合作',castCaption:'各有本事。一起做事。',fromOne:'從一句話開始',workTitle:['聊著聊著，','事情就做出來了。'],workDescription:'單獨交代一件事，或讓幾位夥伴接力完成。',viewProduct:['和夥伴聊聊','讓團隊一起做'],productAlt:['AelionBot 目前版本的寫作對話，展示分享講稿和可儲存的檔案。','AelionBot 目前版本的群組聊天，資料、靈感和寫作夥伴共同準備分享講稿。'],productCaption:'目前版本介面 · 範例工作',makingKicker:'會想，也會動手',makingTitle:['讓成果，','從對話裡','走出來。'],makingDescription:['查資料、處理檔案、使用應用程式。','夥伴有自己的工作電腦。'],paperBack:'資料，變得有頭緒。',paperOverline:'寫下來的想法',paperTitle:['讓靈感，','有處可去。'],deliveryTitle:'分享講稿',deliverySubtitle:'準備好了，看看吧。',personalityKicker:'很有個性，也很合拍',personalityTitle:['你的夥伴。','你的樣子。'],personalityDescription:['名字、職責、配色，都由你決定。','寫作搭檔、資料助手，或隨時陪你聊靈感的朋友。'],paletteAria:'試試夥伴的配色',paletteNames:['暮光紫','晴空藍','薄荷綠','蜜桃粉'],paletteHint:'點一下，換個心情。',memoryQuote:'「下次，也用這套風格。」',memoryDescription:'記下你確認過的偏好，讓合作接得上。',possibilitiesKicker:'先從哪件事開始？',possibilitiesTitle:['你正好需要。','它正好拿手。'],casePrompt:'可以這樣開口',weeklyTitle:'每週的老工作，也有人惦記。',weeklyDescription:'約好時間，把週報、資料整理安排給夥伴。',weeklyLink:'了解排程工作',questionsTitle:'還有幾個小問題。',downloadKicker:'AelionBot',downloadTitle:['下一件事，','一起做。'],footerTagline:'有想法，就一起動手。',realProduct:'真實產品介面 · 範例內容',exampleContent:'範例內容',closeScreenshot:'關閉圖片',previousScreenshot:'上一張圖片',nextScreenshot:'下一張圖片',expandProduct:'放大查看功能示意',productViewAria:'查看產品介面',sceneAria:'資料、創意和檔案成果的視覺演示',tryPalette:'試試夥伴的配色'
  },
  en:{
    blog:'Blog',github:'GitHub',download:'Download app',closeNav:'Close navigation',openNav:'Open navigation',downloadWindows:'Download for Windows',downloadMacArm:'Download for Mac (Apple Silicon)',downloadMacIntel:'Download for Mac (Intel)',downloadAll:'See all downloads',downloadWindowsShort:'Windows',downloadMacArmShort:'Mac · Apple Silicon',downloadMacIntelShort:'Mac · Intel',downloadMobileHint:'This is a desktop app. Download it on a computer.',downloadLinuxHint:'No Linux build yet. You can download Windows or Mac.',home:'AelionBot home',mainNav:'Main navigation',footerNav:'Footer navigation',skip:'Skip to main content',heroEyebrow:'AelionBot · Your AI work partner',heroTitle:['Good ideas.','Made together.'],heroDescription:'Bring partners with different strengths to your desktop.',meet:'Meet your partner',seeCollab:'See how it works',castCaption:'Different strengths. One team.',fromOne:'Start with a sentence',workTitle:['Talk it through,','then make it real.'],workDescription:'Hand off one task, or let several partners take turns.',viewProduct:['Chat with a partner','Work as a team'],productAlt:['AelionBot writing conversation showing a shareable talk outline and saved files.','AelionBot group chat where research, ideas, and writing partners prepare a talk outline together.'],productCaption:'Current interface · Example task',makingKicker:'Thinks, then does',makingTitle:['Beyond chat.','Into the','real world.'],makingDescription:['Research, handle files, use apps.','Your partner has its own work computer.'],paperBack:'Make the material make sense.',paperOverline:'Ideas, written down',paperTitle:['Give ideas','somewhere to go.'],deliveryTitle:'Shareable outline',deliverySubtitle:'Ready when you are.',personalityKicker:'A little more you',personalityTitle:['Your partner.','Your style.'],personalityDescription:['You choose the name, role, and colors.','A writing partner, research assistant, or a friend for exploring ideas.'],paletteAria:'Try the partner colors',paletteNames:['Twilight violet','Clear sky blue','Mint green','Peach pink'],paletteHint:'Tap to change the mood.',memoryQuote:'“Use this style next time.”',memoryDescription:'Keep confirmed preferences so the next collaboration picks up naturally.',possibilitiesKicker:'What should you start with?',possibilitiesTitle:['Your everyday.','A little easier.'],casePrompt:'Try saying it this way',weeklyTitle:'Give the routine its own rhythm.',weeklyDescription:'Set a time and let a partner handle reports and research.',weeklyLink:'Explore scheduled work',questionsTitle:'Before you begin.',downloadKicker:'AelionBot',downloadTitle:['The next thing,','together.'],footerTagline:'Have an idea? Let’s make it.',realProduct:'Real product interface · Example content',exampleContent:'Example content',closeScreenshot:'Close image',previousScreenshot:'Previous image',nextScreenshot:'Next image',expandProduct:'Enlarge illustration',productViewAria:'View product interface',sceneAria:'A visual demonstration of research, ideas, and file results',tryPalette:'Try the partner colors'
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
  'zh-CN':[
    {question:'怎样开始和伙伴一起工作？',answer:'下载适合这台电脑的安装包，按引导连接你想使用的 AI 服务。给伙伴起个名字、安排职责，就能交给它第一件事。AI 服务的使用费用按你所选服务计算。'},
    {question:'可以决定伙伴能做哪些事吗？',answer:'可以。你决定它能接触哪些资料、怎样获得操作许可。任务过程中可以补充要求、暂停工作，也可以亲自接管它的工作电脑。'},
    {question:'定时工作需要一直开着应用吗？',answer:'任务执行时需要保持应用开启。你可以安排一次性的事情，也可以让伙伴每天或每周重复处理例行工作。'},
    {question:'有 Mac 版本吗？',answer:'有。下载区域会按这台电脑推荐 Windows、Apple 芯片或 Intel 安装包，也可以改选其他版本。'},
  ],
  'zh-TW':[
    {question:'怎樣開始和夥伴一起工作？',answer:'下載適合這台電腦的安裝包，依照引導連線你想使用的 AI 服務。替夥伴取名、安排職責，就能交給它第一件事。AI 服務費用依你選擇的服務計算。'},
    {question:'可以決定夥伴能做哪些事嗎？',answer:'可以。你決定它能接觸哪些資料、如何取得操作許可。工作過程中可以補充要求、暫停工作，也可以親自接管它的工作電腦。'},
    {question:'排程工作需要一直開著應用程式嗎？',answer:'執行工作時需要保持應用程式開啟。你可以安排一次性工作，也可以讓夥伴每天或每週重複處理例行工作。'},
    {question:'有 Mac 版本嗎？',answer:'有。下載區域會按這台電腦推薦 Windows、Apple 晶片或 Intel 安裝包，也可以改選其他版本。'},
  ],
  en:[
    {question:'How do I start working with a partner?',answer:'Download the installer for this computer and connect the AI service you want to use. Name your partner, give it a role, and hand it a first task. AI service charges depend on the service you choose.'},
    {question:'Can I decide what a partner is allowed to do?',answer:'Yes. You decide which materials it can access and how it asks for permission. Add requirements, pause the work, or take over its work computer at any time.'},
    {question:'Does scheduled work require the app to stay open?',answer:'The app needs to stay open while a task runs. Schedule one-off work, or have a partner repeat routine work daily or weekly.'},
    {question:'Is there a Mac version?',answer:'Yes. The download section recommends Windows, Apple Silicon, or Intel based on this computer. Other builds are linked underneath.'},
  ]
};
