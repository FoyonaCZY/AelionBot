// Instructions the run loop adds when the model tries to finish before its work is actually done.

export const prematureAnswer = (count: number, instruction: string) =>
  `本次答复尚未交付（连续第 ${count} 次）。${instruction}`;
export const runningTerminals = (terminals: unknown[]) =>
  '以下终端仍在运行，请 terminal_read 检查或 terminal_stop 停止，不能仅凭启动成功交付：' + JSON.stringify(terminals);
export const missingDelegationReceipt = (task: unknown) =>
  '当前委托还没有执行回执。请先调用 delegation_receipt，逐项说明验收结果并引用实际证据；遇到阻碍则记录 blocked。委托内容：' +
  JSON.stringify(task);
export const unfinishedPython = (sessions: unknown[]) =>
  'Python 代码仍未核对完成，请用 python_session poll 取回结果，不要重新执行：' + JSON.stringify(sessions);
export const unfinishedProcesses = (processes: unknown[]) =>
  '以下后台任务尚未核对完成，请用 process_wait/status 检查状态、日志与退出码，不能仅凭启动成功交付：' +
  JSON.stringify(processes);
export const GROUP_PLAN_INCOMPLETE =
  '群任务计划仍有未完成步骤。继续实际执行并用 plan_update 保存真实证据，或明确记录阻碍；不要只回复稍后处理。';
export const PLAN_INCOMPLETE =
  '任务清单仍有未完成步骤，请继续执行并更新 task_update 或 plan_update。不要提前宣称完成；无法继续时用 goal_update(status=blocked) 说明阻碍。';
export const GROUP_TASK_WORKING =
  '你认领的群任务仍为 working。继续执行并用 group_task_update 更新完成依据，或标记 blocked 并说明阻碍；不要只承诺稍后再做。';
export const PLAN_NOT_SAVED = '请先调用 plan_update 保存具体计划，再结束规划。';
export const GOAL_INCOMPLETE =
  '目标尚未完成。请继续执行；实际验收后用 goal_update 标记完成，无法继续则报告 blocked 及阻碍。';
export const MEMORY_NEEDS_MAIN_TASK =
  '用户明确要求记住这项偏好。请先调用 start_main_task 进入自己的主会话，再实际保存记忆，不能仅口头承诺。';
export const MEMORY_NOT_SAVED =
  '原始用户明确要求你记住这项偏好，但还没有成功的 memory 操作。请调用 memory 保存到自己的记忆，确认 saved 或 duplicate 后再回复。';
export const unresolvedFailures = (failures: Array<[string, string]>) =>
  `执行环境确认以下操作仍有未解决记录：${JSON.stringify(failures)}。不要宣称已完成。同一目标重试成功可解决原失败；采用替代方案时，用 execution_resolve 引用后续成功执行的 executionId 并说明依据。用 execution_list 核对。另一文件或无关命令成功不能证明问题已解决。用户已经看到刚才的可见答复，不要说「上一轮已经说过」来代替；若还要补充，直接写给用户。`;
export const mentionCheckFailed = (message: string) =>
  '应用的 @ 身份检查未通过：' +
  message +
  '。请修正最终回复里的成员提及，使用群上下文中的准确 ID；不要重复已执行的工作。';
export const REACTION_NEEDS_REPLY =
  '用户新增的 emoji 是一次对你的发言，需要得到回应。请用 chat_pin 在原消息下回应，或根据表情给出简短自然的文字。不要返回静默标记。';
export const DUPLICATE_REACTION = '这个表态已经存在，尚未回应本次新发言。请用简短文字回应用户。';
export const PIN_NOT_COMPLETION =
  '表情已经添加，当前工作尚未因此完成。继续处理用户的任务，核对已有工具结果后给出最终答复，不要重复已经执行的操作。';
