# 工作区媒体模型

在「设置 → 模型 → Providers」添加连接，填写服务地址和凭据，勾选用途，并在对应页选择协议。一个连接可以服务于多个用途。媒体专用连接允许手动填写模型 ID。「模型分配」分别设置图像生成、语音识别、语音合成和视频生成。各 Bot 共用这些分配与合成音色，对话模型仍可在 Bot 资料中选择。

升级时，已有工作区语音设置优先。如果以前为不同 Bot 指定过不同生图模型，采用 Bot 列表中第一个仍有效的选择作为工作区默认，同时把旧选择保存在对应连接的模型目录中。以后导入 Bot 使用本工作区的媒体配置。

## 按次选择

Bot 可用 `list_media_models` 列出已启用对应能力的本地 Provider ID、模型和默认分配。`generate_image`、`design_image` 和 `generate_video` 可传 `providerId` 和 `model`。省略时使用工作区默认值。手填模型名适用于尚未进入目录的模型。

```json
{
  "providerId": "<list_media_models 返回的 ID>",
  "model": "<该平台的模型或已部署的端点 ID>",
  "prompt": "保持构图，镜头缓慢向海面移动",
  "image": { "attachmentId": "<会话中的首帧图片>" },
  "aspect": "21:9",
  "resolution": "1080p",
  "duration": "8"
}
```

省略素材可文生视频。使用 `image` 进行图生视频，使用 `video` 进行视频编辑、参考生成或续写。每次选择一种素材，可按 `attachmentId`、工作目录 `path` 或 HTTPS `url` 引用。连接会使用自身的凭据提交和查询任务。成功的 MP4 或 WebM 会作为回复附件交付，沿用应用的单文件 25 MB 限额。查询或下载中断时，可带原 `taskId` 和相同模型、素材参数继续查询。

画幅、分辨率、时长均支持自由输入。使用数字秒数、`8s`、`-1` 或服务原生规格取决于所选模型。只接收像素尺寸的接口可直接填 `4096x1536`。服务可能按源素材决定可用的输出规格。模型分配中的「测试视频模型」会提交真实的生成请求，按平台规则计费。「停止等待」停止本地查询。

## 视频协议

| 协议 | 配置与素材 |
| --- | --- |
| [DashScope / 万相](https://help.aliyun.com/zh/model-studio/video-generate-edit-model/) | 填所属地域的百炼地址和 Key。根据具体模型使用 t2v、i2v、r2v、videoedit 或统一生成模型。源视频使用 HTTPS URL。 |
| [火山方舟 / Seedance](https://docs.byteplus.com/en/docs/ModelArk/create-video-generation-task-api) | 方舟区域地址，使用模型 ID 或部署端点。首帧使用 first_frame，视频参考使用 reference_video。 |
| [可灵](https://kling.ai/document-api/api/video/omni-video) | 填区域 API 地址，凭据填 Access Key:Secret Key 或有效的 JWT。支持首帧及 Omni 视频编辑，编辑使用源视频 URL。 |
| [MiniMax 海螺](https://platform.minimax.io/docs/api-reference/video-generation-t2v) / [H3 v2](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) | 海螺旧接口支持文本和首帧。H3 选择 v2 协议，支持文本、首帧及视频参考。 |
| [Vidu](https://platform.vidu.com/docs/api-reference/video-models/vidu-q2/reference-to-video) | 文字、首帧和视频参考使用对应端点；视频参考需要支持该模式的模型。 |
| [Runway](https://docs.dev.runwayml.com/api/) | 根据素材选择 text_to_video、image_to_video 或 video_to_video。 |
| [Luma Dream Machine](https://docs.lumalabs.ai/reference/modifyvideo) | 图片用首帧 URL，源视频用 Modify Video 的 URL。 |
| [Gemini Omni](https://aistudio.google.com/docs/omni) | 填 Gemini API 地址及 Key，使用 Interactions API。 |
| [Vertex AI / Veo](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation) | 服务地址填至 /v1/projects/PROJECT/locations/LOCATION/publishers/google，凭据填有效的 Google Cloud OAuth 访问令牌。支持附件首帧，以及模型允许的源视频续写。 |
| [xAI](https://docs.x.ai/developers/rest-api-reference/inference/videos) | 文字及首帧使用 generations，源视频使用 edits，并继承源视频规格。 |
| [OpenAI Videos 兼容协议](https://developers.openai.com/api/docs/guides/video-generation) | 供实现 /videos、/videos/edits、/videos/{id}/content 的兼容服务使用，参考素材以本地文件或附件上传。 |
| [Higgsfield](https://open.higgsfield.ai/quick-start) | 选择 Higgsfield 视频协议。服务地址填 `https://api.higgsfield.ai`，API Key 填控制台复制的完整凭据（不用加 `Key ` 前缀）。模型 ID 填官方端点路径，例如 `bytedance/seedance-2.0/text-to-video`、`bytedance/seedance-2.0/image-to-video` 或 `bytedance/seedance-2.0/reference-to-video`。本地素材通过平台签名地址上传，模型专用字段可通过 `input` 填写。 |
| [fal Queue](https://fal.ai/docs/documentation/model-apis/inference/queue) | 填 https://queue.fal.run，模型填完整端点路径（包括图生或视频编辑子路径）。模型专用参数放在工具的 input，sourceField 可选择输入素材字段。 |
| [Replicate Predictions](https://replicate.com/docs/reference/http) | 模型填 owner/model 或 owner/model:version。模型专用输入和素材字段由相应模型定义。 |

具体模型、地区、权限及输出规格以服务端为准。每个平台的接口独立维护，兼容网关应选择其实际暴露的协议。
