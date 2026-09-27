export class GroupUpdated extends Error {
  constructor() {
    super('有新的群发事件，已保留执行结果并重新接收消息');
  }
}
export class InputUpdated extends Error {
  constructor() {
    super('已收到用户的新输入，旧生成已取消，执行结果已保留');
  }
}
