import { readFileSync } from 'node:fs';

export function readEventPayload<T>(): T {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) {
    throw new Error('GITHUB_EVENT_PATH is not set (are you running inside a workflow?)');
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}
