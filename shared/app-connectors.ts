// Apps a Bot can work in through their official remote MCP servers. Each entry was checked against the live
// server: OAuth entries use dynamic registration or a public client metadata document to sign in in the browser.
// Token entries take a token the person creates; Google needs an OAuth client in the person's own Cloud project.

/**
 * - `oauth`: sign in in the browser; the app identifies itself to the service.
 * - `token`: the person pastes an access token.
 * - `google`: sign in with an OAuth client the person creates in Google Cloud.
 * - `none`: no account needed.
 */
type AppConnectorAuth = 'oauth' | 'token' | 'google' | 'none';
export type AppConnectorGroup = 'google' | 'work' | 'dev' | 'analytics' | 'design' | 'sales' | 'commerce' | 'reference';

export interface AppConnector {
  id: string;
  name: string;
  /** Simplified Chinese, used as the i18n key. */
  description: string;
  group: AppConnectorGroup;
  url: string;
  auth: AppConnectorAuth;
  /** Requested instead of everything the server lists, where that would ask for more than the tools need. */
  scope?: string;
  /** Public OAuth client metadata document; its redirect must match OAUTH_REDIRECT_URL. */
  clientMetadataUrl?: string;
  /** Where the person creates a token, for `token` entries. */
  tokenUrl?: string;
  /** Runs on this computer, inside another app. */
  local?: boolean;
  /** Served inside this app over the service's own API; `url` names the API and keys the stored token. */
  builtin?: boolean;
}

export const APP_CONNECTOR_GROUPS: Array<{ id: AppConnectorGroup; name: string }> = [
  { id: 'work', name: '文档与协作' },
  { id: 'google', name: 'Google' },
  { id: 'dev', name: '开发与数据' },
  { id: 'analytics', name: '产品分析' },
  { id: 'design', name: '设计与内容' },
  { id: 'sales', name: '销售与营销' },
  { id: 'commerce', name: '支付与商务' },
  { id: 'reference', name: '资料检索' },
];

/** The redirect the app listens on while someone signs in. Google clients must list it exactly. */
export const OAUTH_REDIRECT_PORT = 47391;
export const OAUTH_REDIRECT_URL = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`;

const google = (id: string, name: string, description: string, host: string, scopes: string[]): AppConnector => ({
  id,
  name,
  description,
  group: 'google',
  url: `https://${host}.googleapis.com/mcp/v1`,
  auth: 'google',
  scope: scopes.map((scope) => 'https://www.googleapis.com/auth/' + scope).join(' '),
});
const DRIVE = ['drive.readonly', 'drive.file'];
const app = (
  id: string,
  name: string,
  description: string,
  group: AppConnectorGroup,
  url: string,
  auth: AppConnectorAuth = 'oauth',
): AppConnector => ({ id, name, description, group, url, auth });

export const APP_CONNECTORS: AppConnector[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: '搜索和编辑 Notion 页面与数据库',
    group: 'work',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: '查看和更新 Linear 的 issue 与项目',
    group: 'work',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  },
  {
    id: 'atlassian',
    name: 'Jira 与 Confluence',
    description: '读写 Jira issue 和 Confluence 页面',
    group: 'work',
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: 'oauth',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: '读写 Airtable 的表格和记录',
    group: 'work',
    url: 'https://mcp.airtable.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: '管理 monday.com 的看板和任务',
    group: 'work',
    url: 'https://mcp.monday.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    description: '查看 Intercom 的对话和客户',
    group: 'work',
    url: 'https://mcp.intercom.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: '通过 Zapier 使用上千个应用的操作',
    group: 'work',
    url: 'https://mcp.zapier.com/api/mcp/mcp',
    auth: 'oauth',
  },
  google('gmail', 'Gmail', '搜索和阅读邮件，起草回复', 'gmailmcp', ['gmail.readonly', 'gmail.compose']),
  google('google-drive', 'Google Drive', '查找、读取和上传 Drive 文件', 'drivemcp', DRIVE),
  google('google-calendar', 'Google 日历', '查看日程和空闲时间', 'calendarmcp', [
    'calendar.calendarlist.readonly',
    'calendar.events.freebusy',
    'calendar.events.readonly',
  ]),
  google('google-docs', 'Google 文档', '读取和编辑 Google 文档', 'docsmcp', [
    ...DRIVE,
    'documents.readonly',
    'documents',
  ]),
  google('google-sheets', 'Google 表格', '读取和编辑 Google 表格', 'sheetsmcp', [
    ...DRIVE,
    'spreadsheets.readonly',
    'spreadsheets',
  ]),
  google('google-slides', 'Google 幻灯片', '读取和编辑 Google 幻灯片', 'slidesmcp', [
    ...DRIVE,
    'presentations.readonly',
    'presentations',
  ]),
  {
    id: 'github',
    name: 'GitHub',
    description: '查看和管理仓库、issue 与 pull request',
    group: 'dev',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: '管理 Supabase 项目、数据库和 Edge Functions',
    group: 'dev',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'neon',
    name: 'Neon',
    description: '管理 Neon 的 Postgres 数据库',
    group: 'dev',
    url: 'https://mcp.neon.tech/mcp',
    auth: 'oauth',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: '查看 Vercel 项目、部署和日志',
    group: 'dev',
    url: 'https://mcp.vercel.com',
    auth: 'oauth',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: '管理 Cloudflare Workers、KV、R2 和 D1',
    group: 'dev',
    url: 'https://bindings.mcp.cloudflare.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: '查看 Sentry 的错误、事件和问题',
    group: 'dev',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: '搜索 Hugging Face 的模型、数据集和 Spaces',
    group: 'dev',
    url: 'https://huggingface.co/mcp',
    auth: 'none',
  },
  {
    id: 'canva',
    name: 'Canva',
    description: '搜索、创建和编辑 Canva 设计',
    group: 'design',
    url: 'https://mcp.canva.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'miro',
    name: 'Miro',
    description: '读取和编辑 Miro 白板',
    group: 'design',
    url: 'https://mcp.miro.com/',
    auth: 'oauth',
  },
  {
    id: 'webflow',
    name: 'Webflow',
    description: '管理 Webflow 网站和 CMS 内容',
    group: 'design',
    url: 'https://mcp.webflow.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'figma-desktop',
    name: 'Figma 桌面版',
    description: '读取 Figma 桌面版里打开的设计',
    group: 'design',
    url: 'http://127.0.0.1:3845/mcp',
    auth: 'none',
    local: true,
  },
  {
    id: 'binance',
    name: 'Binance',
    description: '查看币安行情与账户，按授权交易和划转 Agentic 子账户资金',
    group: 'commerce',
    url: 'https://agent.binance.com/mcp/agentic',
    auth: 'oauth',
    // Binance advertises CIMD + PKCE, without dynamic client registration (checked 2026-10-18).
    clientMetadataUrl: 'https://aelion.chat/oauth/client-metadata.json',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: '查询 Stripe 的客户、付款和订阅',
    group: 'commerce',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: '查询 PayPal 的交易、发票和订单',
    group: 'commerce',
    url: 'https://mcp.paypal.com/mcp',
    auth: 'oauth',
  },
  {
    id: 'square',
    name: 'Square',
    description: '查询 Square 的商品、订单和付款',
    group: 'commerce',
    url: 'https://mcp.squareup.com/mcp',
    auth: 'oauth',
  },
  // Checked 2026-10-15: each OAuth server registers the app and opens its sign-in page; each open one lists tools.
  app('asana', 'Asana', '查看和更新 Asana 的任务与项目', 'work', 'https://mcp.asana.com/sse'),
  app('clickup', 'ClickUp', '管理 ClickUp 的任务、文档和空间', 'work', 'https://mcp.clickup.com/mcp'),
  app('todoist', 'Todoist', '查看和添加 Todoist 待办', 'work', 'https://ai.todoist.net/mcp'),
  app('dropbox', 'Dropbox', '查找和读取 Dropbox 文件', 'work', 'https://mcp.dropbox.com/mcp'),
  app('guru', 'Guru', '搜索 Guru 知识库', 'work', 'https://mcp.api.getguru.com/mcp'),
  app('calcom', 'Cal.com', '查看和预约 Cal.com 日程', 'work', 'https://mcp.cal.com/mcp'),
  app('granola', 'Granola', '查看 Granola 的会议笔记', 'work', 'https://mcp.granola.ai/mcp'),
  app('otter', 'Otter.ai', '搜索 Otter 的会议转写和摘要', 'work', 'https://mcp.otter.ai/mcp'),
  app('fireflies', 'Fireflies', '搜索 Fireflies 的会议记录', 'work', 'https://api.fireflies.ai/mcp'),
  app('make', 'Make', '运行和管理 Make 自动化场景', 'work', 'https://mcp.make.com/mcp'),
  app('gitlab', 'GitLab', '查看 GitLab 的项目、issue 和合并请求', 'dev', 'https://gitlab.com/api/v4/mcp'),
  app('netlify', 'Netlify', '创建和部署 Netlify 网站', 'dev', 'https://netlify-mcp.netlify.app/mcp'),
  app('prisma', 'Prisma Postgres', '管理 Prisma Postgres 数据库', 'dev', 'https://mcp.prisma.io/mcp'),
  app('planetscale', 'PlanetScale', '查询和管理 PlanetScale 数据库', 'dev', 'https://mcp.pscale.dev/mcp/planetscale'),
  app('postman', 'Postman', '管理 Postman 的集合和 API', 'dev', 'https://mcp.postman.com/mcp'),
  app('jam', 'Jam', '查看 Jam 的错误录屏和日志', 'dev', 'https://mcp.jam.dev/mcp'),
  app('semgrep', 'Semgrep', '扫描代码里的安全问题', 'dev', 'https://mcp.semgrep.ai/mcp'),
  app('socket', 'Socket', '检查依赖包的安全风险', 'dev', 'https://mcp.socket.dev/', 'none'),
  app('apify', 'Apify', '运行 Apify 的网页抓取工具', 'dev', 'https://mcp.apify.com/'),
  app(
    'cloudflare-observability',
    'Cloudflare 可观测性',
    '查看 Cloudflare Workers 的日志和指标',
    'dev',
    'https://observability.mcp.cloudflare.com/mcp',
  ),
  app(
    'cloudflare-browser',
    'Cloudflare 浏览器渲染',
    '抓取网页内容和截图',
    'dev',
    'https://browser.mcp.cloudflare.com/mcp',
  ),
  app(
    'cloudflare-radar',
    'Cloudflare Radar',
    '查询互联网流量和攻击趋势',
    'dev',
    'https://radar.mcp.cloudflare.com/mcp',
  ),
  app('amplitude', 'Amplitude', '查询 Amplitude 的图表和用户数据', 'analytics', 'https://mcp.amplitude.com/mcp'),
  app('mixpanel', 'Mixpanel', '查询 Mixpanel 的事件和报表', 'analytics', 'https://mcp.mixpanel.com/mcp'),
  app('posthog', 'PostHog', '查询 PostHog 的分析、功能开关和错误', 'analytics', 'https://mcp.posthog.com/mcp'),
  app('honeycomb', 'Honeycomb', '查询 Honeycomb 的追踪和指标', 'analytics', 'https://mcp.honeycomb.io/mcp'),
  app('hex', 'Hex', '查找和运行 Hex 的数据项目', 'analytics', 'https://app.hex.tech/mcp'),
  app('lucid', 'Lucid', '查找和创建 Lucid 图表', 'design', 'https://mcp.lucid.app/mcp'),
  app('mermaid', 'Mermaid Chart', '创建和编辑 Mermaid 图表', 'design', 'https://mcp.mermaidchart.com/mcp'),
  app(
    'cloudinary',
    'Cloudinary',
    '管理 Cloudinary 的图片和视频',
    'design',
    'https://asset-management.mcp.cloudinary.com/mcp',
  ),
  app('sanity', 'Sanity', '读写 Sanity 的内容和文档', 'design', 'https://mcp.sanity.io/'),
  app('wix', 'Wix', '管理 Wix 网站和内容', 'design', 'https://mcp.wix.com/mcp'),
  app('attio', 'Attio', '查看和更新 Attio 的客户记录', 'sales', 'https://mcp.attio.com/mcp'),
  app('close', 'Close', '查看和更新 Close 的线索与商机', 'sales', 'https://mcp.close.com/mcp'),
  app('apollo', 'Apollo.io', '搜索 Apollo 的公司和联系人', 'sales', 'https://mcp.apollo.io/mcp'),
  app('klaviyo', 'Klaviyo', '查看 Klaviyo 的营销活动和受众', 'sales', 'https://mcp.klaviyo.com/mcp'),
  app('customerio', 'Customer.io', '查看 Customer.io 的用户和消息', 'sales', 'https://mcp.customer.io/mcp'),
  app('ahrefs', 'Ahrefs', '查询 Ahrefs 的 SEO 和外链数据', 'sales', 'https://api.ahrefs.com/mcp/mcp'),
  app('plaid', 'Plaid', '查看 Plaid 集成的状态和数据', 'commerce', 'https://api.dashboard.plaid.com/mcp/sse'),
  app('ramp', 'Ramp', '查询 Ramp 的消费、卡片和报销', 'commerce', 'https://mcp.ramp.com/mcp'),
  app('mercury', 'Mercury', '查询 Mercury 的账户和交易', 'commerce', 'https://mcp.mercury.com/mcp'),
  app('context7', 'Context7', '查最新的库和框架文档', 'reference', 'https://mcp.context7.com/mcp', 'none'),
  app('deepwiki', 'DeepWiki', '了解 GitHub 开源仓库的结构和用法', 'reference', 'https://mcp.deepwiki.com/mcp', 'none'),
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: '用 DeepSeek 搜索和读取网页、识别文档和图片里的文字',
    group: 'reference',
    url: 'https://api.deepseek.com/v1/tools',
    auth: 'token',
    tokenUrl: 'https://platform.deepseek.com/api_keys',
    builtin: true,
  },
  app('exa', 'Exa', '用 Exa 搜索网页和抓取内容', 'reference', 'https://mcp.exa.ai/mcp', 'none'),
  app(
    'microsoft-learn',
    'Microsoft Learn',
    '搜索微软官方文档和代码示例',
    'reference',
    'https://learn.microsoft.com/api/mcp',
    'none',
  ),
  app(
    'aws-knowledge',
    'AWS 文档',
    '搜索 AWS 官方文档和区域信息',
    'reference',
    'https://knowledge-mcp.global.api.aws',
    'none',
  ),
  app(
    'cloudflare-docs',
    'Cloudflare 文档',
    '搜索 Cloudflare 官方文档',
    'reference',
    'https://docs.mcp.cloudflare.com/mcp',
    'none',
  ),
];

/** The same address however it was written: case of the host and a trailing slash do not matter. */
export function sameServerUrl(a: string, b: string) {
  const normal = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      return value;
    }
  };
  return normal(a) === normal(b);
}
export const appConnectorFor = (url?: string) =>
  url ? APP_CONNECTORS.find((item) => sameServerUrl(item.url, url)) : undefined;
