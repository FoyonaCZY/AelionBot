// Headless entry: runs one Bot task against a host workspace without Electron.
// node dist-electron/cli.cjs "fix the failing test" --workspace . --permission auto
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runHeadless, type HeadlessEvent, type HeadlessPermission } from './core/headless';
import type { ModelProtocol } from '../src/model-types';

const usage = `用法: aelion-headless [任务] [选项]
  任务可作为参数，或从标准输入读取。

选项:
  -w, --workspace <dir>    本机项目目录（默认当前目录）
  -d, --data-dir <dir>     headless 数据目录（默认 ~/.aelion/headless；不要与正在运行的桌面端共用）
  -b, --bot <id|名称>      使用的 Bot（默认第一个 Bot）
  -p, --permission <mode>  workspace（默认：只放行项目内普通读写和已保存规则）| auto（再加审核模型）| full
      --model <name>       模型名称（或 AELION_MODEL）
      --base-url <url>     API 地址（或 AELION_BASE_URL，默认 https://api.openai.com/v1）
      --protocol <p>       chat | responses | anthropic | gemini（或 AELION_PROTOCOL）
      --context <tokens>   模型上下文窗口（或 AELION_CONTEXT_TOKENS）
      --timeout <seconds>  超时后停止任务
      --json               输出一个 JSON 结果对象
  -q, --quiet              不输出工具进度
  -h, --help               显示帮助

API Key 只从环境变量 AELION_API_KEY 读取。需要人确认的操作一律拒绝并返回给模型。
退出码: 0 完成，1 失败，2 参数错误，3 超时，130 中断。`;

async function stdinText() {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function fail(message: string): never {
  process.stderr.write(message + '\n\n' + usage + '\n');
  process.exit(2);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        workspace: { type: 'string', short: 'w' },
        'data-dir': { type: 'string', short: 'd' },
        bot: { type: 'string', short: 'b' },
        permission: { type: 'string', short: 'p' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        protocol: { type: 'string' },
        context: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    fail((error as Error).message);
  }
  const { values, positionals } = parsed,
    env = process.env;
  if (values.help) {
    process.stdout.write(usage + '\n');
    return 0;
  }
  const prompt = (positionals.join(' ') || (await stdinText())).trim();
  if (!prompt) fail('缺少任务内容');
  const permission = (values.permission || 'workspace') as HeadlessPermission;
  if (!['workspace', 'auto', 'full'].includes(permission)) fail('--permission 需要 workspace、auto 或 full');
  const protocol = (values.protocol || env.AELION_PROTOCOL) as ModelProtocol | undefined;
  if (protocol && !['chat', 'responses', 'anthropic', 'gemini'].includes(protocol)) fail('--protocol 无效');
  const context = values.context || env.AELION_CONTEXT_TOKENS,
    contextTokens = context ? Number(context) : undefined;
  if (contextTokens !== undefined && (!Number.isInteger(contextTokens) || contextTokens < 4000))
    fail('--context 需要不小于 4000 的整数');
  const timeout = values.timeout ? Number(values.timeout) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) fail('--timeout 需要正数秒');
  const modelName = values.model || env.AELION_MODEL;
  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    if (++interrupts > 1) process.exit(130);
    process.stderr.write('\n正在停止任务…（再按一次 Ctrl+C 立即退出）\n');
    controller.abort();
  });
  const log = (event: HeadlessEvent) => {
    if (values.quiet || values.json) return;
    if (event.type === 'started') process.stderr.write(`▶ ${event.botName} 开始任务 ${event.runId}\n`);
    else if (event.type === 'tool')
      process.stderr.write(
        `${event.status === 'done' ? '✓' : '✗'} ${event.tool}${event.detail ? ' · ' + event.detail : ''}\n`,
      );
    else
      process.stderr.write(
        `⊘ 已拒绝 ${event.tool || event.operation}${event.target ? '：' + event.target.slice(0, 160) : ''}\n`,
      );
  };
  const result = await runHeadless({
    prompt,
    permission,
    workspaceDir: resolve(values.workspace || process.cwd()),
    dataDir: resolve(values['data-dir'] || env.AELION_HEADLESS_DATA_DIR || join(homedir(), '.aelion', 'headless')),
    botId: values.bot,
    apiKey: env.AELION_API_KEY,
    runtimeDir: __dirname,
    timeoutMs: timeout ? timeout * 1000 : undefined,
    signal: controller.signal,
    onEvent: log,
    ...(modelName
      ? {
          model: {
            model: modelName,
            baseUrl: values['base-url'] || env.AELION_BASE_URL || 'https://api.openai.com/v1',
            protocol,
            contextTokens,
            reasoningEffort: env.AELION_REASONING_EFFORT,
          },
        }
      : {}),
  });
  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    if (result.reply) process.stdout.write(result.reply.trimEnd() + '\n');
    if (result.error)
      process.stderr.write(`任务${result.status === 'cancelled' ? '已停止' : '失败'}：${result.error}\n`);
  }
  if (result.status === 'completed') return 0;
  if (controller.signal.aborted) return 130;
  return result.status === 'cancelled' && timeout ? 3 : 1;
}
main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`headless 启动失败：${(error as Error).message}\n`);
    process.exit(1);
  },
);
