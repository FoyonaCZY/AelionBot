import type { ToolDefinition } from '../../../model/model';
import { tool } from './shared';

export const MESSAGE_BLOCK_TOOLS: ToolDefinition[] = [
  tool(
    'message_block',
    '在回复里插入一个结构化块：图表、指标、表格、时间线、提示或可交互计算器。适合趋势、对比、占比，以及结果取决于用户自己数字（工资、费率、贷款、税档）、值得让用户自己改数重算的场景。只放数据，不放 HTML/JS。必须调用本工具才会显示内容；只在正文里写 [[block:id]] 不会渲染任何东西。调用成功后复制返回值里的 marker（不要自己起名字）单独一行放在正文中希望显示的位置，块会穿插在段落之间；不写标记时块显示在回答末尾。一次回答最多 4 个块，块不能代替文字结论。' +
      ' chart spec：{chartType: line|bar|area|stacked-bar|pie|donut|sparkline, categories:[string], series:[{name, values:[number|null]}], unit?, highlight?}；' +
      ' calculator spec：{inputs:[{id,label,type:number|percent|money,value,unit?,min?,max?,step?}], taxableFormula?, brackets?:[{upTo:number|null,rate:number,quickDeduction?}], formula?, outputs:[{label,formula,unit?,format?}], note?}；' +
      ' table spec：{columns:[{label,align?,format?}], rows:[[cell]]}；metrics spec：{items:[{label,value,delta?,tone?}]}；timeline spec：{items:[{time?,title,detail?,state?}]}；callout spec：{tone:info|warning|success|danger,title?,text}。' +
      '公式只支持数字、输入 id、+ - * /、括号和 min/max/round/floor/ceil/abs；字段错误会在结果里指出路径。',
    {
      type: { type: 'string', enum: ['chart', 'metrics', 'table', 'timeline', 'callout', 'calculator'] },
      title: { type: 'string', maxLength: 120, description: '块标题，简短说明这张图/这个计算器是什么' },
      spec: { type: 'object', description: '按 type 提供的数据；字段说明见工具描述' },
      fallback: {
        type: 'string',
        maxLength: 600,
        description: '纯文本摘要：连接器、复制、导出和块渲染失败时使用。必须能独立说明关键数字。',
      },
    },
    ['type', 'spec', 'fallback'],
  ),
];
