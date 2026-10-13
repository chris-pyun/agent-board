export const statuses = ['todo', 'in_progress', 'review', 'done'] as const;
export type Status = typeof statuses[number];
export interface Agent { id: string; name: string; icon: string; createdAt: string; updatedAt: string }
export interface Task { id: string; title: string; description: string; agentId: string; status: Status; version: number; createdAt: string; updatedAt: string }
export interface Result { summary: string; changedFiles: string[]; tests: {name: string; status: 'passed'|'failed'|'not_run'; details: string}[] }
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function input(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_INPUT', 'JSON 객체가 필요합니다.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new AppError(400, 'INVALID_INPUT', '허용되지 않은 필드입니다.');
  return data;
}
export function textField(value: unknown, name: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new AppError(400, 'INVALID_INPUT', `${name} 형식 또는 길이가 잘못되었습니다.`);
  return value.trim();
}
