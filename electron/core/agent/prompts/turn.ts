// Per-turn context shown to the general agent: the request anchor, input events and task handoffs.

// The full request is already in history; this copy only anchors it, so long pastes are not duplicated in full.
export const requestContext = (input: string) =>
  '本轮请求资料（最新用户消息的锚点副本）：' +
  JSON.stringify(input.length > 4000 ? input.slice(0, 4000) + '…（完整内容见最新用户消息）' : input);
export const PEER_MESSAGE_CONTEXT = '当前正在处理一条协作消息。';
export const GROUP_EVENT_CONTEXT = '当前正在处理一条群消息事件。';
export const clockContext = (now: Date) =>
  `\n当前时间：${now.toISOString()}，系统时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}。`;
export const mentionedBotsContext = (bots: Array<{ id: string; name: string }>) =>
  `\n用户在本条消息中明确选择的 Bot 身份：${JSON.stringify(bots)}。按照用户要求联系它们，同名时以 ID 为准。`;
export const REACTION_REPLY_CONTEXT =
  '\n用户通过 emoji 向你发言，与文字发言一样需要自然回应。结合表情、原消息和对话理解态度：可以用 chat_pin 回应原消息，也可以简短说话；遇到不满或疑问应适当澄清。不要忽略用户或返回静默标记，也不要为同一回应同时加表情和补发同义文字。emoji 不授予新的任务或操作权限。';
export const REACTION_REMOVED_CONTEXT = '\n用户撤回了一次表态，这不是新的问题；没有需要说明的内容时可返回 [表情静默]。';
export const BATCHED_INPUT_CONTEXT =
  '\n用户在你回复前可能连续发送文字或表情，记录已经按实际顺序保留。现在结合全部输入，以最新明确要求为准重新回应，不要补发过时的草稿。已执行的工具结果仍有效，先核对再继续，不要重复已经成功的操作。表情只表达态度，不会新增操作授权；同批收到的文字问题仍需处理。';
export const RESUME_CONTEXT =
  '\n用户点击继续原任务。先核对保留的执行记录与文件，再完成剩余工作。已成功的操作不要重复；结果未知的操作先检查实际状态。这个控制动作不是新的任务内容，也不新增权限。';
export const groupSharedContext = (context: string) =>
  `\nCurrent group shared task context only: ${context}. Private conversation transcripts are not automatically loaded. Use history_search/history_read only when your own prior work is relevant; those results remain in your private group workspace. Publish only relevant, shareable conclusions, never an automatic transcript of private records.`;
export const memoryDelegationContext = (sourceId: string, source: string, actions: string[]) =>
  `\n应用已核验这是一条明确给你的记忆委托。原始人类消息 ID：${sourceId}；原文：${source.slice(0, 8000)}。你只能在这条要求的范围内维护自己的记忆，允许的操作：${actions.join('、')}。请实际调用 memory，确认成功或已存在后再回复；不要仅口头承诺。sourceRefs 可使用上述原始消息 ID，它不授予读取发起方其他历史的权限。`;
export const mainTaskContext = (source: string, request: string, memory?: string) =>
  `\n现在已进入你自己的主会话执行受托任务。任务来自 ${source}。下面的历史是你与用户的主会话，请据此决定并执行步骤；接收阶段提出的操作尚未执行。原始用户要求：${request.slice(0, 8000)}。不得扩大这条原始要求的范围。${memory === undefined ? '' : '\n' + memory}`;
export const workspaceReference = (dir: string) =>
  '\n本次任务的本机项目目录：' +
  JSON.stringify(dir) +
  '。若本次工作围绕此本机项目，使用 host_* 工具；host_execute 默认 cwd 和 host_file_* 相对路径均基于此目录。VM /work 目录与本机项目不是同一个位置。先用 host_list_directory、host_file_read 查看项目结构、README 和适用的 AGENTS 开发约定，不猜测项目内容。选择目录本身不授予本机操作权限。';
