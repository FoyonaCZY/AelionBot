import { VAULT_CATEGORIES, VAULT_ACCESS_POLICIES, type VaultFieldKind } from '../../../../../shared/types/vault-types';
import type { ToolDefinition } from '../../../model/model';
import { tool } from './shared';

const VAULT_FIELD_KINDS: VaultFieldKind[] = [
  'text',
  'password',
  'email',
  'phone',
  'card_number',
  'cvv',
  'totp',
  'multiline_key',
];

const bindingArraySchema = {
  type: 'array',
  maxItems: 16,
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['domain', 'app', 'mcp', 'host'] },
      value: { type: 'string', maxLength: 200 },
    },
    required: ['kind', 'value'],
    additionalProperties: false,
  },
  description: '绑定的域名、应用名、MCP 服务名或主机名（用于自动放行或范围校验）',
};

export const VAULT_TOOLS: ToolDefinition[] = [
  tool(
    'vault_list',
    '查看或搜索用户保险库中的可用条目元数据（仅返回 id/slug/分类/绑定/字段掩码预览与策略，绝不返回明文）。',
    {
      query: { type: 'string', maxLength: 200, description: '按标题、slug、域名、备注或标签搜索' },
      category: { type: 'string', enum: [...VAULT_CATEGORIES], description: '按分类过滤' },
      domain: { type: 'string', maxLength: 200, description: '按绑定域名或主机过滤（如 github.com）' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回条目数量（1–50）' },
    },
    [],
  ),
  tool(
    'vault_save',
    '将用户在对话中明确告知的个人联系信息、登录凭据、支付卡、SSH 密钥或 API Key 加密保存或更新到保险库。保存后系统会自动隐藏对话与工具记录中的明文。若用户尚未提供高敏凭据，请使用 vault_request 而非在对话中索要明文。',
    {
      id: { type: 'string', maxLength: 100, description: '已有条目 ID（更新已有条目时传入）' },
      slug: {
        type: 'string',
        maxLength: 64,
        description: '英文短标识（用于 {{vault:slug.field}} 引用，省略时自动生成）',
      },
      category: { type: 'string', enum: [...VAULT_CATEGORIES], description: '条目分类' },
      title: { type: 'string', maxLength: 120, description: '条目标题，如 "GitHub 账号" 或 "常用收货地址"' },
      notes: { type: 'string', maxLength: 300, description: '简短备注（不要包含任何密码或密钥明文）' },
      tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 32 }, description: '标签列表' },
      bindings: bindingArraySchema,
      fields: {
        type: 'object',
        additionalProperties: { type: 'string', maxLength: 32000 },
        description: '待加密保存的字段键值对，如 { username, password, totpSecret } 或 { email, phone, address }',
      },
      policy: {
        type: 'string',
        enum: [...VAULT_ACCESS_POLICIES],
        description: '使用审批策略（card 类别强制 always-ask）',
      },
    },
    ['category', 'title', 'fields'],
  ),
  tool(
    'vault_request',
    '向用户弹出加密安全录入卡片，由用户亲自填写密码、银行卡、SSH 私钥或 API Key 等敏感信息。用户输入内容直接加密入库，不会进入对话历史或模型上下文。仅交互式会话可用。',
    {
      title: { type: 'string', maxLength: 120, description: '录入卡标题，如 "保存 GitHub 登录凭据"' },
      reason: { type: 'string', maxLength: 500, description: '向用户说明需要此凭据的原因与用途' },
      category: { type: 'string', enum: [...VAULT_CATEGORIES], description: '条目分类' },
      suggestedSlug: { type: 'string', maxLength: 64, description: '建议的短标识 slug（可选）' },
      bindings: bindingArraySchema,
      existingItemId: { type: 'string', maxLength: 100, description: '若向已有条目补充或更新字段，传入其 ID（可选）' },
      fields: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', maxLength: 48, description: '字段键名，如 username、password、privateKey' },
            label: { type: 'string', maxLength: 80, description: '展示给用户的字段名称' },
            kind: { type: 'string', enum: VAULT_FIELD_KINDS, description: '字段类型（决定掩码输入与预览方式）' },
            required: { type: 'boolean', description: '是否必填' },
            placeholder: { type: 'string', maxLength: 120, description: '输入框占位提示' },
          },
          required: ['key', 'label'],
          additionalProperties: false,
        },
        description: '需要用户在安全表单中填写的字段清单',
      },
    },
    ['title', 'reason', 'category', 'fields'],
  ),
];
