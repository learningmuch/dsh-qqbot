import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BindingStore } from './binding-store.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qqbot-bind-'));
  file = join(dir, 'bindings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('BindingStore', () => {
  it('初始为空：未绑定的 peer 返回 undefined', () => {
    const store = new BindingStore({ filePath: file });
    expect(store.get('qqbot:app:c2c:p1')).toBeUndefined();
    expect(store.entries()).toEqual([]);
  });

  it('set 后落盘，新实例能读回（重启后绑定仍然有效）', () => {
    const first = new BindingStore({ filePath: file });
    first.set('qqbot:app:c2c:p1', 'session-aaa');

    const second = new BindingStore({ filePath: file });
    expect(second.get('qqbot:app:c2c:p1')).toBe('session-aaa');

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { bindings: Record<string, string> };
    expect(onDisk.bindings['qqbot:app:c2c:p1']).toBe('session-aaa');
  });

  it('重复 set 覆盖旧绑定（一个 peer 只绑一个会话）', () => {
    const store = new BindingStore({ filePath: file });
    store.set('qqbot:app:c2c:p1', 'session-aaa');
    store.set('qqbot:app:c2c:p1', 'session-bbb');
    expect(store.get('qqbot:app:c2c:p1')).toBe('session-bbb');
    expect(store.peersFor('session-aaa')).toEqual([]);
  });

  it('clear 返回是否曾经存在，并同步落盘', () => {
    const store = new BindingStore({ filePath: file });
    store.set('qqbot:app:group:g1', 'session-aaa');

    expect(store.clear('qqbot:app:group:g1')).toBe(true);
    expect(store.clear('qqbot:app:group:g1')).toBe(false);
    expect(new BindingStore({ filePath: file }).get('qqbot:app:group:g1')).toBeUndefined();
  });

  it('peersFor 支持多个 peer 绑定同一会话（群里多人看同一份）', () => {
    const store = new BindingStore({ filePath: file });
    store.set('qqbot:app:c2c:p1', 'session-aaa');
    store.set('qqbot:app:group:g1', 'session-aaa');
    store.set('qqbot:app:c2c:p2', 'session-bbb');

    expect(store.peersFor('session-aaa').sort()).toEqual(['qqbot:app:c2c:p1', 'qqbot:app:group:g1']);
    expect(store.peersFor('session-bbb')).toEqual(['qqbot:app:c2c:p2']);
    expect(store.peersFor('session-zzz')).toEqual([]);
  });

  it('绑定文件损坏时视为空表，不抛错', () => {
    writeFileSync(file, '{ this is not json', 'utf8');
    const store = new BindingStore({ filePath: file });
    expect(store.entries()).toEqual([]);
  });

  it('目录不存在时自动创建（首次绑定）', () => {
    const nested = join(dir, 'a', 'b', 'bindings.json');
    const store = new BindingStore({ filePath: nested });
    store.set('qqbot:app:c2c:p1', 'session-aaa');
    expect(new BindingStore({ filePath: nested }).get('qqbot:app:c2c:p1')).toBe('session-aaa');
  });

  it('忽略非字符串值的脏数据条目', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ bindings: { good: 'session-ok', bad: 42, empty: '' } }), 'utf8');
    const store = new BindingStore({ filePath: file });
    expect(store.entries()).toEqual([{ peerKey: 'good', sessionId: 'session-ok' }]);
  });
});
