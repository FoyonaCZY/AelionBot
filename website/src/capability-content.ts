import type {SiteLanguage} from './site-i18n';

interface Feature {kicker:string;title:string;description:string;points:string[];note:string;}
interface CapabilityCopy {
 nav:string[];design:Feature;vm:Feature;group:Feature;
 systemLabel:string;systemHint:string;prototype:string;deck:string;sampleTitle:string;sampleAction:string;
 vmLabel:string;vmStatus:string;workspace:string;terminal:string;
 groupLabel:string;researcher:string;analyst:string;user:string;messages:string[];handoff:string;
}
export const capabilityCopy:Record<SiteLanguage,CapabilityCopy>={
 'zh-CN':{
  nav:['多 Agent 协作','工作电脑','专业设计'],
  design:{kicker:'03 / 专业角色 · 设计师',title:'设计师，也是团队的一员。',description:'152 套设计系统预装在应用里。为设计师选好视觉方向，再把想法做成可交互的网页原型或可编辑的 PPT。',points:['配色、字体、布局与组件参考，围绕同一个方向展开。','每个任务独立选择设计系统，停止任务后可以更改，也可以不指定。','一边对话一边预览，框选、标注，或直接修改网页元素与源码。'],note:'设计师在默认工作目录的 designers 下工作，无需启动 VM。设计系统参考来自 OpenDesign，保留来源与许可；品牌风格参考不代表官方合作。'},
  vm:{kicker:'02 / Linux VM',title:'有一台电脑，才能真正动手。',description:'通用 Bot 可以使用受管理的 Linux 工作电脑，打开网页、处理文件、运行代码和操作桌面应用。你能看到它在做什么，也能暂停或接管。',points:['通用 Bot 各有工作目录和桌面，在同一台受管理的 VM 中工作。','浏览器、终端和办公应用，把调研、计算与文件处理接起来。','启动前按引导准备环境；本机文件与命令操作仍遵循你设置的权限。'],note:'VM 承接通用任务，设计师使用本机目录。任务要由谁处理，由你决定。'},
  group:{kicker:'01 / 多 AGENT 协作',title:'各有分工，在同一个群里接力。',description:'为研究、代码、数据分析和写作安排不同的 Agent，在同一个群里分工、交换文件、讨论结果。你可以随时补充方向，或 @ 指定伙伴接手。',points:['按职责、模型和工具配置伙伴，一人交代任务，多位 Agent 协作。','让资料收集、数据处理、代码实现和报告撰写沿着同一项任务推进。','伙伴也能互发私信；群聊使用群内上下文，不混入无关私聊记录。'],note:'以下是协作示意。Bot 类型不会被系统自动切换，分工和参与者由你选择。'},
  systemLabel:'选择视觉语言',systemHint:'点选，看看配色方向',prototype:'网页原型',deck:'PPT 演示',sampleTitle:'把好想法，做成作品。',sampleAction:'开始探索',vmLabel:'通用 Bot 的工作电脑',vmStatus:'功能示意',workspace:'工作目录',terminal:'终端',groupLabel:'从调研到分析',researcher:'资料伙伴 · 通用 Bot',analyst:'分析伙伴 · 通用 Bot',user:'你',messages:['比较三个产品，整理来源、关键数据和差异。','资料整理好了，案例与来源放在 research.md 里。','数据已核对，对比结果放在 comparison.xlsx，写作伙伴可以继续整理报告。'],handoff:'文件和上下文，接得上。'
 },
 'zh-TW':{
  nav:['多 Agent 協作','工作電腦','專業設計'],
  design:{kicker:'03 / 專業角色 · 設計師',title:'設計師，也是團隊的一員。',description:'152 套設計系統預裝在應用程式裡。為設計師選好視覺方向，再把點子做成可互動的網頁原型或可編輯的 PPT。',points:['配色、字型、版面與元件參考，圍繞同一個方向展開。','每個工作獨立選擇設計系統，停止工作後可以更改，也可以不指定。','一邊對話一邊預覽，框選、標註，或直接修改網頁元素與原始碼。'],note:'設計師在預設工作目錄的 designers 下工作，無需啟動 VM。設計系統參考來自 OpenDesign，保留來源與授權；品牌風格參考不代表官方合作。'},
  vm:{kicker:'02 / Linux VM',title:'有一台電腦，才能真正動手。',description:'通用 Bot 可以使用受管理的 Linux 工作電腦，開啟網頁、處理檔案、執行程式碼和操作桌面應用程式。你能看到它在做什麼，也能暫停或接管。',points:['通用 Bot 各有工作目錄和桌面，在同一台受管理的 VM 中工作。','瀏覽器、終端機和辦公應用程式，把調研、計算與檔案處理串起來。','啟動前依引導準備環境；本機檔案與命令操作仍遵循你設定的權限。'],note:'VM 承接通用工作，設計師使用本機目錄。工作要由誰處理，由你決定。'},
  group:{kicker:'01 / 多 AGENT 協作',title:'各有分工，在同一個群組裡接力。',description:'為研究、程式、資料分析和寫作安排不同的 Agent，在同一個群組裡分工、交換檔案、討論結果。你可以隨時補充方向，或 @ 指定夥伴接手。',points:['按職責、模型和工具設定夥伴，一人交代工作，多位 Agent 協作。','讓資料蒐集、資料處理、程式實作和報告撰寫沿著同一項工作推進。','夥伴也能互傳私訊；群組使用群內上下文，不混入無關私訊紀錄。'],note:'以下為協作示意。Bot 類型不會被系統自動切換，分工和參與者由你選擇。'},
  systemLabel:'選擇視覺語言',systemHint:'點選，看看配色方向',prototype:'網頁原型',deck:'PPT 簡報',sampleTitle:'把好點子，做成作品。',sampleAction:'開始探索',vmLabel:'通用 Bot 的工作電腦',vmStatus:'功能示意',workspace:'工作目錄',terminal:'終端機',groupLabel:'從調研到分析',researcher:'資料夥伴 · 通用 Bot',analyst:'分析夥伴 · 通用 Bot',user:'你',messages:['比較三個產品，整理來源、關鍵資料和差異。','資料整理好了，案例與來源放在 research.md 裡。','資料已核對，比較結果放在 comparison.xlsx，寫作夥伴可以繼續整理報告。'],handoff:'檔案與上下文，接得上。'
 },
 en:{
  nav:['Multi-agent teamwork','Work computer','Design role'],
  design:{kicker:'03 / SPECIALIST ROLE · DESIGNER',title:'Bring in a Designer when you need one.',description:'152 design systems come bundled with the app. Choose a direction for your Designer, then turn an idea into an interactive web prototype or an editable presentation.',points:['Keep color, typography, layout and component references working together.','Choose a system for each task, change it while the task is stopped, or leave it unspecified.','Preview alongside the conversation. Mark a region, annotate, or edit webpage elements and source.'],note:'Designers work locally under designers in your default workspace, without starting a VM. References come from OpenDesign with source and license notices retained; brand-inspired styles do not imply endorsement.'},
  vm:{kicker:'02 / LINUX VM',title:'A computer to get things done.',description:'General Bots can use a managed Linux work computer to browse, process files, run code and operate desktop apps. Watch the work, pause it, or take over when needed.',points:['General Bots have their own workspaces and desktops within one managed VM.','A browser, terminal and office apps connect research, computation and file work.','Prepare the environment through the setup guide. Host file and command access still follows your permission settings.'],note:'General work can use the VM; Designers use local project folders. You choose who handles the task.'},
  group:{kicker:'01 / MULTI-AGENT COLLABORATION',title:'Different roles. A shared conversation.',description:'Give research, coding, data analysis and writing their own agents. Bring them into one group to divide the work, exchange files and discuss results. Add a direction or @ a partner to take the next step.',points:['Configure partners with different roles, models and tools, then give the team a shared task.','Connect source gathering, data processing, implementation and report writing around the same objective.','Partners can also exchange private messages. Group context stays separate from unrelated private conversations.'],note:'The conversation shown is an example. Bot types are never switched automatically; you choose the participants and their roles.'},
  systemLabel:'Choose a visual language',systemHint:'Select a palette to explore',prototype:'Web prototype',deck:'Presentation',sampleTitle:'Make something worth sharing.',sampleAction:'Explore the idea',vmLabel:'A General Bot’s work computer',vmStatus:'Product illustration',workspace:'Workspace',terminal:'Terminal',groupLabel:'From research to analysis',researcher:'Research partner · General Bot',analyst:'Analysis partner · General Bot',user:'You',messages:['Compare three products, with sources, key data and differences.','The examples and sources are ready in research.md.','The data is checked. comparison.xlsx is ready for the writing partner to turn into a report.'],handoff:'The files move with the work.'
 }
};

/** A small selection from the bundled catalog; the website does not ship the full library. */
export const featuredSystems=[
 {name:'Apple',colors:['#000000','#f5f5f7','#0071e3'],accent:'#0071e3',surface:'#f5f5f7'},
 {name:'Airbnb',colors:['#ff385c','#222222','#92174d'],accent:'#ff385c',surface:'#fff1f3'},
 {name:'Binance.US',colors:['#222126','#f0b90b','#ffd000'],accent:'#b38600',surface:'#fff9e5'},
 {name:'Material',colors:['#6442d6','#c8b3fd','#16a34a'],accent:'#6442d6',surface:'#f1ecff'}
] as const;
