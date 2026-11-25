import { createHmac } from 'node:crypto';
import { AppError } from '../../../shared/errors';
import type { VideoProtocol, VideoSpecs } from '../../../shared/types/media-types';
import { validateModelEndpoint } from '../model/model';

export interface VideoSource {
  kind: 'image' | 'video';
  url?: string;
  bytes?: Buffer;
  mime?: string;
}
export interface VideoJob extends VideoSpecs {
  prompt: string;
  source?: VideoSource;
  input?: Record<string, unknown>;
  sourceField?: string;
}
export interface VideoAccess {
  baseUrl: string;
  key: string;
  model: string;
  protocol: VideoProtocol;
  defaults: VideoSpecs;
}
type Payload = Record<string, unknown> | FormData;
export interface VideoRequest {
  url: string;
  body?: Payload;
  headers?: Record<string, string>;
}
interface VideoResult {
  status?: string;
  url?: string;
  base64?: string;
  fileId?: string;
  resultPath?: string;
  contentPath?: string;
}
export interface VideoPlan {
  submit: VideoRequest;
  id: (data: any) => unknown;
  poll: (id: string) => VideoRequest;
  result: (data: any, id: string) => VideoResult;
  headers: () => Record<string, string>;
}

function unsupported(message: string): never {
  throw new AppError('video.input_unsupported', message);
}
function seconds(value?: string) {
  if (!value) return;
  const match = /^(-?\d+(?:\.\d+)?)\s*(?:s|秒)?$/i.exec(value);
  return match ? Number(match[1]) : value;
}
function pixels({ resolution, aspect }: VideoSpecs, separator: string) {
  if (!resolution && !aspect) return;
  const explicit = resolution?.match(/^(\d+)\s*[x×*:：]\s*(\d+)$/i);
  if (explicit) return explicit[1] + separator + explicit[2];
  // Legacy Wan sizes are pixel-area buckets (a square 720P clip is 960×960).
  if (separator === '*' && aspect) {
    const buckets: Record<string, Record<string, string>> = {
      '480p': { '16:9': '832*480', '9:16': '480*832', '1:1': '624*624' },
      '720p': { '1:1': '960*960', '4:3': '1088*832', '3:4': '832*1088' },
      '1080p': { '1:1': '1440*1440', '4:3': '1632*1248', '3:4': '1248*1632' },
    };
    const bucket = buckets[(resolution || '720p').toLowerCase()]?.[aspect];
    if (typeof bucket === 'string') return bucket;
  }
  const lines = /^(\d+)p$/i.exec(resolution || '720p');
  const ratio = /^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/.exec(aspect || '16:9');
  if (!lines || !ratio || !Number(ratio[1]) || !Number(ratio[2])) return resolution || aspect;
  const scale = Number(lines[1]) / Math.min(Number(ratio[1]), Number(ratio[2]));
  return [ratio[1], ratio[2]].map((n) => Math.round(Number(n) * scale)).join(separator);
}
function jwt(key: string) {
  const split = key.indexOf(':');
  if (split < 0) return key;
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token =
    encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ iss: key.slice(0, split), nbf: now - 5, exp: now + 1800 });
  return (
    token +
    '.' +
    createHmac('sha256', key.slice(split + 1))
      .update(token)
      .digest('base64url')
  );
}
export function videoSourceUrl(kind: 'image' | 'video', value: unknown): VideoSource {
  if (typeof value !== 'string' || !URL.canParse(value)) throw new AppError('video.input_invalid', '素材 URL 无效');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new AppError('video.input_invalid', '素材需要 HTTPS URL');
  return { kind, url: value };
}
function mediaUri(source: VideoSource, remoteOnly = false): string {
  if (source.url) return source.url;
  if (!remoteOnly && source.bytes && source.mime)
    return 'data:' + source.mime + ';base64,' + source.bytes.toString('base64');
  return unsupported('该接口需要服务端可访问的素材 URL');
}
// Preserve reverse-proxy prefixes. Chat endpoints may already carry a provider-specific version suffix.
function endpoint(value: string, prefix: string) {
  const url = new URL(validateModelEndpoint(value));
  const base = url.pathname
    .replace(/\/(?:compatible-mode\/v1|v1beta\/openai|api\/v[13]|ent\/v2|dream-machine\/v1|v1beta|v1|v2)\/?$/, '')
    .replace(/\/$/, '');
  return url.origin + base + prefix;
}
export function videoPlan(access: VideoAccess, request: VideoJob): VideoPlan {
  // Editing on these endpoints inherits the source clip's format. Send any explicit per-call overrides to the service.
  const inheritsSource = request.source?.kind === 'video' && ['xai', 'openai', 'luma'].includes(access.protocol);
  const job = inheritsSource ? request : { ...access.defaults, ...request };
  const { model, key, protocol } = access,
    { prompt, source, aspect, resolution, duration } = job;
  const tier = resolution && /^\d+p$/i.test(resolution) ? resolution.toUpperCase() : resolution;
  const number = seconds(duration),
    image = source?.kind === 'image',
    video = source?.kind === 'video';
  const root = (p: string) => endpoint(access.baseUrl, p);
  const get = (url: string): VideoRequest => ({ url });
  const post = (url: string, body: Payload): VideoRequest => ({ url, body });
  const headers = (): Record<string, string> => (key ? { Authorization: 'Bearer ' + key } : {});
  const common = { headers, id: (d: any) => d.id };
  if ((job.input || job.sourceField) && protocol !== 'fal' && protocol !== 'replicate')
    unsupported('模型自定义输入字段仅适用于 fal 或 Replicate');
  switch (protocol) {
    case 'fal':
    case 'replicate': {
      const fal = protocol === 'fal';
      const parts = model.split('/');
      if (parts.some((p) => !/^[-a-zA-Z0-9_.:]+$/.test(p) || p === '.' || p === '..') || parts.length < 2)
        unsupported('请输入平台提供的完整模型 ID');
      const base = root(fal ? '' : '/v1');
      const path = parts.map(encodeURIComponent).join('/');
      const queue =
        base +
        '/' +
        parts
          .slice(0, parts[0] === 'workflows' ? 3 : 2)
          .map(encodeURIComponent)
          .join('/') +
        '/requests/';
      const input = { prompt, aspect_ratio: aspect, resolution, duration: fal ? duration : number, ...job.input };
      if (source) {
        const field = job.sourceField || (fal ? source.kind + '_url' : source.kind);
        if (!/^\w+$/.test(field) || ['__proto__', 'constructor', 'prototype'].includes(field))
          unsupported('素材字段名无效');
        Object.assign(input, { [field]: mediaUri(source) });
      }
      return fal
        ? {
            ...common,
            headers: () => ({ Authorization: 'Key ' + key }),
            submit: post(base + '/' + path, input),
            id: (d) => d.request_id,
            poll: (id) => get(queue + id + '/status'),
            result: (d, id) => ({ status: d.status, resultPath: queue + id }),
          }
        : {
            ...common,
            submit: post(base + '/predictions', { version: model, input }),
            poll: (id) => get(base + '/predictions/' + id),
            result: (d) => ({
              status: d.status,
              url: Array.isArray(d.output) ? d.output[0] : d.output?.video?.url || d.output?.url || d.output,
            }),
          };
    }
    case 'minimax-v2':
    case 'seedance': {
      const h3 = protocol === 'minimax-v2';
      const url = h3 ? root('/v2/video_generation') : root('/api/v3/contents/generations/tasks');
      const content: unknown[] = [{ type: 'text', text: prompt }];
      if (source) {
        const type = image ? 'image_url' : 'video_url';
        content.push({ type, [type]: { url: mediaUri(source) }, role: image ? 'first_frame' : 'reference_video' });
      }
      return {
        ...common,
        submit: post(url, { model, content, ratio: aspect, resolution, duration: number }),
        id: (d) => (h3 ? d.task_id : d.id),
        poll: (id) => get((h3 ? root('/v2/query/video_generation') : url) + '/' + id),
        result: (d) =>
          h3 ? { status: d.task?.status, url: d.task?.content?.url } : { status: d.status, url: d.content?.video_url },
      };
    }
    case 'dashscope': {
      const base = root('/api/v1'),
        modern = /^wan(?:2\.7|[3-9])/.test(model);
      let input: Record<string, unknown> = { prompt };
      if (source) {
        const uri = mediaUri(source, video);
        if (modern)
          input.media = [
            {
              type: image
                ? 'first_frame'
                : model.includes('videoedit')
                  ? 'video'
                  : model.includes('-i2v')
                    ? 'first_clip'
                    : 'reference_video',
              url: uri,
            },
          ];
        else if (video || model.includes('-r2v')) input.reference_urls = [uri];
        else input.img_url = uri;
      }
      const parameters =
        modern || (image && !model.includes('-r2v'))
          ? { ratio: aspect, resolution: tier, duration: number }
          : { size: pixels(job, '*'), duration: number };
      return {
        ...common,
        submit: {
          ...post(base + '/services/aigc/video-generation/video-synthesis', { model, input, parameters }),
          headers: { 'X-DashScope-Async': 'enable' },
        },
        id: (d) => d.output?.task_id,
        poll: (id) => get(base + '/tasks/' + id),
        result: (d) => ({ status: d.output?.task_status, url: d.output?.video_url }),
      };
    }
    case 'runway': {
      const base = root('/v1'),
        path = image ? 'image_to_video' : video ? 'video_to_video' : 'text_to_video';
      const ratio = pixels(job, ':') || (!video ? '1280:720' : undefined);
      const body = {
        model,
        promptText: prompt,
        ratio,
        duration: number ?? (!source ? 5 : undefined),
        ...(source ? { [image ? 'promptImage' : 'videoUri']: mediaUri(source) } : {}),
      };
      return {
        ...common,
        headers: () => ({ ...headers(), 'X-Runway-Version': '2024-11-06' }),
        submit: post(base + '/' + path, body),
        poll: (id) => get(base + '/tasks/' + id),
        result: (d) => ({ status: d.status, url: d.output?.[0] }),
      };
    }
    case 'kling': {
      const path = video || /(?:-o1|-o3|omni)/i.test(model) ? 'omni-video' : image ? 'image2video' : 'text2video',
        url = root('/v1/videos/' + path);
      const body: Record<string, unknown> = {
        model_name: model,
        prompt,
        aspect_ratio: aspect,
        duration: duration && String(number),
      };
      if (resolution)
        body.mode =
          ({ '720p': 'std', '1080p': 'pro', '2160p': '4k', '4k': '4k' } as Record<string, string>)[
            resolution.toLowerCase()
          ] || resolution;
      if (source) {
        const uri = mediaUri(source, video);
        if (video) body.video_list = [{ video_url: uri, refer_type: 'base' }];
        else if (path === 'omni-video')
          body.image_list = [{ image_url: source.bytes?.toString('base64') || uri, type: 'first_frame' }];
        else body.image = source.bytes ? source.bytes.toString('base64') : uri;
      }
      return {
        ...common,
        headers: () => ({ Authorization: 'Bearer ' + jwt(key) }),
        submit: post(url, body),
        id: (d) => d.data?.task_id,
        poll: (id) => get(url + '/' + id),
        result: (d) => ({ status: d.data?.task_status, url: d.data?.task_result?.videos?.[0]?.url }),
      };
    }
    case 'vidu': {
      const base = root('/ent/v2'),
        path = video ? 'reference2video' : image ? 'img2video' : 'text2video';
      const body = {
        model,
        prompt,
        aspect_ratio: aspect,
        resolution,
        duration: number,
        ...(image ? { images: [mediaUri(source!)] } : video ? { videos: [mediaUri(source!)] } : {}),
      };
      return {
        ...common,
        headers: () => ({ Authorization: 'Token ' + key }),
        submit: post(base + '/' + path, body),
        id: (d) => d.task_id,
        poll: (id) => get(base + '/tasks/' + id + '/creations'),
        result: (d) => ({ status: d.state, url: d.creations?.[0]?.url }),
      };
    }
    case 'minimax': {
      if (video) unsupported('海螺 video_generation 接口支持文字和首帧图片');
      const base = root('/v1');
      return {
        ...common,
        submit: post(base + '/video_generation', {
          model,
          prompt,
          duration: number,
          resolution: tier,
          aspect_ratio: aspect,
          ...(source ? { first_frame_image: mediaUri(source) } : {}),
        }),
        id: (d) => d.task_id,
        poll: (id) => get(base + '/query/video_generation?task_id=' + id),
        result: (d) => ({ status: d.status, fileId: d.file_id }),
      };
    }
    case 'luma': {
      const url = root('/dream-machine/v1/generations');
      const body = video
        ? {
            generation_type: 'modify_video',
            model,
            prompt,
            mode: 'flex_1',
            aspect_ratio: aspect,
            resolution,
            duration: typeof number === 'number' ? number + 's' : duration,
            media: { url: mediaUri(source!, true) },
          }
        : {
            model,
            prompt,
            aspect_ratio: aspect,
            resolution,
            duration: typeof number === 'number' ? number + 's' : duration,
            ...(source ? { keyframes: { frame0: { type: 'image', url: mediaUri(source, true) } } } : {}),
          };
      return {
        ...common,
        submit: post(url + (video ? '/video/modify' : '/video'), body),
        poll: (id) => get(url + '/' + id),
        result: (d) => ({ status: d.state, url: d.assets?.video }),
      };
    }
    case 'xai': {
      const url = root('/v1/videos');
      return {
        ...common,
        submit: post(url + (video ? '/edits' : '/generations'), {
          model,
          prompt,
          aspect_ratio: aspect,
          resolution,
          duration: number,
          ...(source ? { [source.kind]: { url: mediaUri(source) } } : {}),
        }),
        id: (d) => d.request_id,
        poll: (id) => get(url + '/' + id),
        result: (d) => ({ status: d.status, url: d.video?.url }),
      };
    }
    case 'openai': {
      const url = root('/v1/videos'),
        form = new FormData();
      form.set('prompt', prompt);
      if (!video) form.set('model', model);
      if (duration) form.set('seconds', String(number));
      const size = pixels(job, 'x');
      if (size) form.set('size', size);
      if (source) {
        if (!source.bytes) unsupported('OpenAI 视频文件输入需要附件或工作目录文件');
        form.set(
          video ? 'video' : 'input_reference',
          new Blob([new Uint8Array(source.bytes!)], { type: source.mime }),
          video ? 'source.mp4' : 'frame.' + (source.mime?.split('/')[1] || 'png'),
        );
      }
      return {
        ...common,
        submit: post(url + (video ? '/edits' : ''), form),
        poll: (id) => get(url + '/' + id),
        result: (d, id) => ({ status: d.status, contentPath: url + '/' + id + '/content' }),
      };
    }
    case 'gemini': {
      const url = root('/v1beta/interactions');
      const input = source
        ? [
            {
              type: source.kind,
              ...(source.bytes
                ? { data: source.bytes.toString('base64'), mime_type: source.mime }
                : { uri: source.url }),
            },
            { type: 'text', text: prompt },
          ]
        : prompt;
      return {
        ...common,
        headers: () => ({ 'x-goog-api-key': key }),
        submit: post(url, {
          model,
          input,
          background: true,
          response_format: {
            type: 'video',
            aspect_ratio: aspect,
            resolution,
            duration: typeof number === 'number' ? number + 's' : duration,
            delivery: 'uri',
          },
        }),
        poll: (id) => get(url + '/' + id),
        result: (d) => {
          const outputs = (d.steps || [])
            .filter((s: any) => s.type === 'model_output')
            .flatMap((s: any) => s.content || []);
          const videoPart = outputs.find((part: any) => part.type === 'video') || d.output_video;
          return { status: d.status, base64: videoPart?.data, url: videoPart?.uri };
        },
      };
    }
    case 'vertex': {
      const base =
        validateModelEndpoint(access.baseUrl).replace(/\/models\/?$/, '') + '/models/' + encodeURIComponent(model);
      const instance: Record<string, unknown> = { prompt };
      if (source) {
        if (!source.bytes) unsupported('Vertex AI 视频输入需要附件或工作目录文件');
        instance[source.kind] = { bytesBase64Encoded: source.bytes!.toString('base64'), mimeType: source.mime };
      }
      return {
        ...common,
        submit: post(base + ':predictLongRunning', {
          instances: [instance],
          parameters: { sampleCount: 1, aspectRatio: aspect, resolution, durationSeconds: number },
        }),
        id: (d) => d.name,
        poll: (id) => post(base + ':fetchPredictOperation', { operationName: decodeURIComponent(id) }),
        result: (d) => ({
          status: d.error ? 'failed' : d.done ? 'succeeded' : 'running',
          base64: d.response?.videos?.[0]?.bytesBase64Encoded,
        }),
      };
    }
  }
}
