import type { ToolDefinition } from '../model/model';
import { DECK_LAYOUTS } from './designer-deck';
import { designerPlaybookNames } from './designer-playbooks';
import { IMAGE_ASPECTS, IMAGE_QUALITIES } from '../../../shared/types/image-types';
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const str = { type: 'string' };
export const DESIGN_TOOLS = [
  tool('design_tasks', '列出当前会话的设计任务；多个候选时先确认目标，不要修改其他会话。', {}, []),
  tool(
    'design_start',
    '开始一个独立设计任务。prototype 交付可运行 HTML；ppt 交付可编辑 PPTX；clone 按公开网页做本地视觉复刻并写 NOTES.md；mobile 为设备框里的 HTML；document 为多页 HTML 文档。仅在用户或已核验的委派要求实际设计工作时使用。当前运行已绑定任务时不要再调用；未选设计系统请用 design_system。',
    {
      kind: { enum: ['prototype', 'ppt', 'clone', 'mobile', 'document'], type: 'string' },
      title: str,
      brief: str,
      systemId: { type: 'string' },
      plugins: { type: 'array', items: str, maxItems: 8 },
    },
    ['kind', 'title', 'brief'],
  ),
  tool('design_use', '继续当前会话内已有设计任务。', { id: str }, ['id']),
  tool(
    'design_system',
    '为当前已绑定任务选择或清除设计系统。运行中也可以调用。不要为此再调用 design_start。',
    { systemId: str },
    [],
  ),
  tool(
    'design_file_create',
    '创建当前设计任务的新 UTF-8 文件。无需哈希，不覆盖已有文件；已有文件请先读取再用 host_file_patch。',
    {
      path: str,
      content: { type: 'string', maxLength: 256000 },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    ['path', 'content', 'reason'],
  ),
  tool(
    'design_spec',
    '简要保存用户要求的设计范围与视觉约定。保留用户约束，不自行扩展功能、复杂验收或测试清单。',
    { spec: str, constraints: { type: 'array', items: str, maxItems: 30 } },
    ['spec', 'constraints'],
  ),
  tool(
    'design_resource',
    '按清单读取当前设计系统的文件，或将选中版本准备到任务目录。未选择设计系统时不要调用。',
    { action: { type: 'string', enum: ['read', 'materialize'] }, path: str },
    ['action'],
  ),
  tool(
    'design_publish',
    '读取并校验当前任务的真实产物后交付。不会把图片包装的 PPT 当成可编辑 PPT。HTML 禁止远程字体和套话占位；其它静态问题作为 warnings 返回。可同时提供 HTML 预览与 PPTX。',
    { paths: { type: 'array', items: str, minItems: 1, maxItems: 12 } },
    ['paths'],
  ),
  tool(
    'design_deck',
    '本机生成可编辑文字与形状的 PPTX 和同名 HTML 预览，无需 Python 或 Office。布局：title、agenda（items）、split、statement、quote、compare（left/right）、timeline（items）、stat（metric）、cta。没有真实数据时 metric 写成「—」并标明占位。',
    {
      title: str,
      path: str,
      background: str,
      foreground: str,
      accent: str,
      slides: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            title: str,
            body: str,
            accent: str,
            kicker: str,
            left: str,
            right: str,
            metric: str,
            caption: str,
            items: { type: 'array', items: str, minItems: 2, maxItems: 6 },
            layout: { type: 'string', enum: [...DECK_LAYOUTS] },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    ['title', 'path', 'slides'],
  ),
  tool(
    'design_skill',
    '读取当前任务的专用工作流。无需搜索或安装默认技能。polish 是初稿之后的第二遍：审视已有产物、去掉套模板痕迹、收紧层级与状态，不重做项目。',
    { name: { type: 'string', enum: designerPlaybookNames() } },
    ['name'],
  ),
  tool(
    'design_check',
    '仅在用户要求截图验收时记录实际检查；只能引用本任务成功的 view_image 观察。不要求为初版交付执行此工具。',
    { executionId: str, note: str },
    ['executionId', 'note'],
  ),
  tool(
    'design_image',
    '按用户许可在当前任务 assets/ 生成一张图。aspect 决定画幅：hero 横幅用 16:9，竖版海报用 9:16，头像或图标用 1:1，卡片配图用 4:3；不填按生图模型的默认值。referenceAttachmentIds 可传入用户给的图片作为参考图（部分协议不支持，会明确报错）。只在需要真实插图时调用；没有返回的图像字节时必须失败，禁止假装已经出图。失败结果里的 nextStep 是唯一的恢复依据：只有 retry-later 可以原样重试一次，其余一律不要重试，改用 .ph-img 占位图完成排版，不要把版面留空。',
    {
      prompt: { type: 'string', minLength: 1, maxLength: 4000 },
      filename: str,
      aspect: { type: 'string', enum: [...IMAGE_ASPECTS] },
      quality: { type: 'string', enum: [...IMAGE_QUALITIES] },
      negativePrompt: { type: 'string', maxLength: 1000 },
      referenceAttachmentIds: { type: 'array', items: str, maxItems: 4 },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    ['prompt', 'reason'],
  ),
  tool(
    'design_fonts',
    '设计师可根据当前设计任务自主搜索、选择并下载开源字体，不需要用户先操作字体面板。尊重用户指定的字体与品牌要求；下载遵守当前任务权限。search 从 Fontsource 查找开源字体；acquire 按需下载并缓存指定字体；import 导入已保存到当前任务目录的字体文件（用户附件先 attachment_save）；list 返回项目中的实际字体；check 检查文件和文字覆盖。获取后用 design_font_apply 应用到 HTML，或按 cssPath 引用本地 fonts.css。不要只写一个不存在的 font-family。',
    {
      action: { type: 'string', enum: ['list', 'search', 'acquire', 'import', 'check'] },
      query: str,
      fontId: str,
      weights: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 900 }, maxItems: 9 },
      styles: { type: 'array', items: { type: 'string', enum: ['normal', 'italic'] }, maxItems: 2 },
      subsets: { type: 'array', items: str, maxItems: 8 },
      path: str,
      text: { type: 'string', maxLength: 20000 },
      family: str,
      reason: { type: 'string', maxLength: 1000 },
    },
    ['action'],
  ),
  tool(
    'design_font_apply',
    '把已加入当前项目的字体应用为 HTML 的正文、标题或代码字体。只更新受管字体样式，保留其余源代码；PPTX 字体嵌入不在此工具支持范围。',
    {
      fontId: str,
      role: { type: 'string', enum: ['body', 'display', 'mono'] },
      path: str,
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    ['fontId', 'role', 'reason'],
  ),
  tool(
    'design_export_project',
    '将当前任务 HTML 与它实际引用的本地字体、CSS、图片及授权文件导出为可移植 ZIP，写入任务目录。动态构建项目请先构建静态产物；不会打包无关文件。',
    { path: str, output: str, reason: { type: 'string', minLength: 1, maxLength: 1000 } },
    ['path', 'reason'],
  ),
  tool(
    'design_export_pdf',
    '把当前任务的 HTML 预览打印为本机 PDF，写入任务目录。用于演示或文档导出，不改写 PPTX。',
    { path: str, output: str, reason: { type: 'string', minLength: 1, maxLength: 1000 } },
    ['path', 'reason'],
  ),
  tool(
    'design_plugin',
    '列出或读取可选的第一方设计插件（不是通用技能），或为当前任务启用/停用。',
    { action: { type: 'string', enum: ['list', 'read', 'enable', 'disable'] }, id: str },
    ['action'],
  ),
];
