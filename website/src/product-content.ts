export const workExamples=[
  {name:'准备分享',prompt:'把这些材料，变成一场十分钟的分享。',result:'帮你把重点讲清楚。',file:'分享讲稿.docx',tone:'violet'},
  {name:'整理资料',prompt:'帮我读完这些资料，留下真正值得看的。',result:'重点与出处，都替你整理好。',file:'主题资料整理.pdf',tone:'blue'},
  {name:'看懂报表',prompt:'这几份表格里，有哪些变化值得关注？',result:'让一整页数字变得有头绪。',file:'本周数据汇总.xlsx',tone:'mint'},
  {name:'做个小工具',prompt:'我想做一个自己用着顺手的小工具。',result:'边聊边调整，让想法可以用。',file:'我的小工具.html',tone:'peach'},
] as const;

export const questions=[
  {question:'怎样开始和伙伴一起工作？',answer:'下载 Windows 版，按引导连接你想使用的 AI 服务。给伙伴起个名字、安排职责，就能交给它第一件事。AI 服务的使用费用按你所选服务计算。'},
  {question:'可以决定伙伴能做哪些事吗？',answer:'可以。你决定它能接触哪些资料、怎样获得操作许可。任务过程中可以补充要求、暂停工作，也可以亲自接管它的工作电脑。'},
  {question:'定时工作需要一直开着应用吗？',answer:'任务执行时需要保持应用开启。你可以安排一次性的事情，也可以让伙伴每天或每周重复处理例行工作。'},
  {question:'有 Mac 版本吗？',answer:'有 Mac 预览版，可在下载页面的历史版本中找到。当前版本优先提供 Windows 版；Mac 的使用说明见下载区域的预览版说明。'},
];
