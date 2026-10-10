import { AppError } from '../../../shared/errors';

const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/** Approval text is derived from the operation. A caller may still pass reason; the model schema does not ask for it. */
export function approvalReason(args: Record<string, unknown>, fallback: string) {
  const given = typeof args.reason === 'string' ? args.reason.trim() : '';
  const text = (given || fallback).replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text || forbidden.test(text)) throw new AppError('input.invalid', '无效参数：reason');
  return text;
}

/** Omitted location is the user's computer. Only an explicit vm enters the Linux work computer. */
export function toolLocation(args: Record<string, unknown>): 'host' | 'vm' {
  if (args.location === undefined || args.location === 'host') return 'host';
  if (args.location === 'vm') return 'vm';
  throw new AppError('input.invalid', 'location 只能是 host 或 vm，省略表示本机');
}
