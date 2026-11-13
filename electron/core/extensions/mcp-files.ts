// Files for MCP tools served inside this app (the built-in apps). The model names a file the way message_attach does,
// by attachment ID or path; the tool layer reads it with the run's permissions, keeps it as an attachment, and passes
// that copy to the server in the request's `_meta`. Paths only ever travel from the app to its own server, never
// from the model, and remote or local third-party servers never receive them.

/** Tool `_meta`: which arguments name files. */
export const FILE_BRIDGE_META = 'aelion/files';
/** Request `_meta`: the resolved file of each file argument, by argument name. */
export const FILE_INPUTS_META = 'aelion/inputs';

export interface FileBridge {
  inputs: string[];
}
export interface BridgedFile {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/** The schema of a file argument, the same shape as one item of message_attach's attachments. */
export const fileArgument = (description: string) => ({
  type: 'object',
  description,
  properties: {
    attachmentId: { type: 'string', description: '已收到的附件 ID' },
    path: {
      type: 'string',
      description: '文件路径。默认是 Bot 工作目录相对路径；本机绝对路径或 location=host 读取用户电脑上的文件',
    },
    location: {
      type: 'string',
      enum: ['vm', 'host'],
      description: 'vm 为当前 Bot 工作目录，host 为用户本机。本机绝对路径可省略此项',
    },
  },
  additionalProperties: false,
});
