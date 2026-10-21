'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const requirePlugin = createRequire(path.join(__dirname, '../main.js'));

class Element {
  constructor() { this.textContent = ''; this.classes = new Set(); }
  addClass(c) { this.classes.add(c); }
  empty() { this.textContent = ''; }
  setText(s) { this.textContent = s; }
  appendText(s) { this.textContent += s; }
  createEl() { return new Element(); }
  addEventListener() {}
}
class Modal {
  constructor() { this.modalEl = new Element(); this.contentEl = new Element(); }
  open() { this.onOpen(); }
  close() { this.onClose(); }
}
async function loadPlugin() {
  const source = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
  const context = { module: { exports: {} }, console, process, setTimeout, clearTimeout,
    require: (name) => name === 'obsidian'
      ? { Modal, Plugin: class {}, PluginSettingTab: class {}, FileSystemAdapter: class {}, Notice: class {} }
      : requirePlugin(name) };
  vm.runInNewContext(source + '\nmodule.exports = { Plugin: LlmWikiBridgePlugin, HarnessExecutor, ProgressModal, todayJournalInfo };', context);
  return context.module.exports;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-wiki-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, rel, mode = 0o644) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode });
  return file;
}
async function executorFixture(t, agent = 'codex-cli') {
  const root = await fixture(t);
  await write(root, 'harness/bin/wiki', 0o755);
  await write(root, `harness/wiki/ingest/refine-${agent}.sh`, 0o755);
  const api = await loadPlugin();
  const executor = new api.HarnessExecutor({
    app: { vault: { adapter: { basePath: root } } },
    settings: { harnessRoot: path.join(root, 'harness'), wikiNowRelative: 'launcher.sh', refineAgent: agent },
  });
  return { root, executor, ...api };
}

test('신규 설정은 공통 하네스 경로를 사용한다', async () => {
  const { Plugin, HarnessExecutor } = await loadPlugin();
  const plugin = new Plugin(); plugin.loadData = async () => null;
  await plugin.loadSettings(); plugin.app = { vault: { adapter: { basePath: '/vault' } } };
  assert.equal(new HarnessExecutor(plugin).paths().wikiBin, path.join(os.homedir(), '.ai-harness/bin/wiki'));
});
test('저장된 legacy 기본 경로를 이관하고 사용자 지정 경로는 보존한다', async () => {
  const { Plugin } = await loadPlugin();
  for (const [stored, want] of [['~/.ai_harness', '~/.ai-harness'], ['/custom/harness', '/custom/harness']]) {
    const p = new Plugin(); p.loadData = async () => ({ harnessRoot: stored });
    await p.loadSettings(); assert.equal(p.settings.harnessRoot, want);
  }
});
test('주차 날짜 폴더 저널을 집계하고 인덱스와 복사본은 제외한다', async (t) => {
  const root = await fixture(t); const { todayJournalInfo } = await loadPlugin();
  await write(root, '0000_JOURNAL/2026/10/W43/2026-10-21/2026-10-21-01-work.md');
  await write(root, '0000_JOURNAL/2026/10/W43/2026-10-21/2026-10-21-00.md');
  await write(root, '0000_JOURNAL/2026/10/2026-10-21-01-work.md');
  await write(root, '0000_JOURNAL/2026/10/2026-10-21-02-other.md');
  await fs.mkdir(path.join(root, '0000_JOURNAL/2026/10/2026-10-21-03-directory.md'));
  const result = await todayJournalInfo(root, new Date(2026, 9, 21));
  assert.equal(result.count, 2);
});
test('연초의 ISO 주차를 계산하고 없을 때는 0건을 반환한다', async (t) => {
  const root = await fixture(t); const { todayJournalInfo } = await loadPlugin();
  await write(root, '0000_JOURNAL/2027/01/W53/2027-01-01/2027-01-01-01-work.md');
  assert.equal((await todayJournalInfo(root, new Date(2027, 0, 1))).count, 1);
  assert.equal((await todayJournalInfo(root, new Date(2027, 0, 2))).count, 0);
});
test('저널 읽기 실패를 0건으로 보고하지 않는다', async (t) => {
  const root = await fixture(t); const { todayJournalInfo } = await loadPlugin();
  await write(root, '0000_JOURNAL/2026/10');
  const result = await todayJournalInfo(root, new Date(2026, 9, 21));
  assert.equal(result.count, null); assert.ok(result.error);
});
test('refine-only는 런처 없이 선택한 API 에이전트를 점검한다', async (t) => {
  const { executor } = await executorFixture(t, 'deepseek');
  executor.which = async () => { throw Error('API 에이전트에는 CLI가 필요하지 않음'); };
  assert.equal((await executor.preflight('refine')).length, 0);
});
test('codex-cli 선택 시 Codex 바이너리 부재를 보고한다', async (t) => {
  const { executor } = await executorFixture(t);
  executor.which = async () => null;
  const issues = await executor.preflight('refine');
  assert.equal(issues.length, 1); assert.match(issues[0], /codex/);
});
test('정제 명령은 읽을 수 있는 런처가 필요하고 에이전트는 요구하지 않는다', async (t) => {
  const { root, executor } = await executorFixture(t);
  assert.ok((await executor.preflight('full')).some((s) => s.includes('wiki-now')));
  await write(root, 'launcher.sh');
  assert.equal((await executor.preflight('full')).length, 0);
});
test('실행권한 없는 wiki와 미지원 refiner를 사전 차단한다', async (t) => {
  const { root, executor } = await executorFixture(t, 'deepseek');
  await fs.chmod(path.join(root, 'harness/bin/wiki'), 0o644);
  assert.ok((await executor.preflight('refine')).some((s) => s.includes('wiki')));
  await fs.chmod(path.join(root, 'harness/bin/wiki'), 0o755);
  await fs.unlink(path.join(root, 'harness/wiki/ingest/refine-deepseek.sh'));
  assert.ok((await executor.preflight('refine')).some((s) => s.includes('deepseek')));
});
test('원샷 첫 단계 실패 후 두 번째 성공을 전체 성공으로 표시하지 않는다', async (t) => {
  const { Plugin, ProgressModal } = await executorFixture(t);
  const p = new Plugin(); p.app = {};
  p.confirm = async () => ({ ok: true, limit: 3 });
  const calls = [];
  p.executor = { preflight: async () => [], runWikiNow: async () => { calls.push('full'); return 7; },
    runRefineScan: async () => { calls.push('refine'); return 0; } };
  let result;
  const finish = ProgressModal.prototype.finish;
  ProgressModal.prototype.finish = function(code, isError) {
    finish.call(this, code, isError); result = { code, isError, text: this.logEl.textContent };
  };
  await p.runOneshot();
  assert.deepEqual(calls, ['full', 'refine']);
  assert.equal(result.code, 7); assert.equal(result.isError, true); assert.doesNotMatch(result.text, /✓ 완료/);
});
test('오류 상태와 성공 종료 코드가 함께 와도 완료라고 표시하지 않는다', async () => {
  const { ProgressModal } = await loadPlugin(); const m = new ProgressModal({}, 'test'); m.open();
  m.finish(0, true); assert.doesNotMatch(m.logEl.textContent, /✓ 완료/);
  m.close();
});
test('장시간 로그는 최근 출력만 남겨 화면 메모리를 제한한다', async () => {
  const { ProgressModal } = await loadPlugin(); const m = new ProgressModal({}, 'test'); m.open();
  m.append('x'.repeat(400000)); m.append('마지막 로그');
  assert.ok(m.logEl.textContent.length <= 262144); assert.ok(m.logEl.textContent.endsWith('마지막 로그\n'));
  m.close();
});

test('원샷 성공·실패 조합의 최종 상태와 예외 중단을 보존한다', async () => {
  for (const [first, second, want] of [[0, 0, 0], [0, 9, 9], [7, 9, 7]]) {
    const { Plugin, ProgressModal } = await loadPlugin();
    const p = new Plugin(); p.app = {}; p.confirm = async () => ({ ok: true, limit: 2 });
    p.executor = { preflight: async () => [], runWikiNow: async () => first, runRefineScan: async () => second };
    let observed;
    ProgressModal.prototype.finish = (code, isError) => { observed = [code, isError]; };
    await p.runOneshot(); assert.deepEqual(observed, [want, want !== 0]);
  }
  const { Plugin, ProgressModal } = await loadPlugin();
  const p = new Plugin(); p.app = {}; p.confirm = async () => ({ ok: true, limit: 2 });
  p.executor = { preflight: async () => [], runWikiNow: async () => { throw Error('spawn failed'); },
    runRefineScan: async () => { assert.fail('프로세스 시작 실패 후에는 다음 단계를 실행하지 않음'); } };
  let observed;
  ProgressModal.prototype.finish = (code, isError) => { observed = [code, isError]; };
  await p.runOneshot(); assert.deepEqual(observed, [1, true]);
});

test('위키 생성 명령은 실제 자식 프로세스에 인자와 볼트 환경을 전달한다', async (t) => {
  const { root, executor } = await executorFixture(t, 'deepseek');
  await fs.writeFile(path.join(root, 'harness/bin/wiki'),
    '#!/bin/sh\nprintf "%s\\n" "$VAULT_ROOT" "$WIKI_AGENT" "$@"\nexit 3\n');
  const lines = []; let attached; let cleared;
  const code = await executor.runRefineScan({ append: (line) => lines.push(line),
    attachProcess: (child) => { attached = child; }, clearProcess: (child) => { cleared = child; } }, 4);
  assert.equal(code, 3);
  assert.ok(lines.includes(root)); assert.ok(lines.includes('deepseek'));
  assert.ok(lines.includes('refine-scan')); assert.ok(lines.includes('--limit'));
  assert.ok(lines.includes('4')); assert.ok(lines.includes('--agent')); assert.ok(lines.includes('--yes'));
  assert.ok(attached); assert.equal(attached, cleared);
});

test('refine-only 공개 명령은 선택 에이전트와 분리된 점검 모드로 실행한다', async (t) => {
  const { root, executor, Plugin, ProgressModal } = await executorFixture(t, 'deepseek');
  await fs.writeFile(path.join(root, 'harness/bin/wiki'), '#!/bin/sh\nexit 0\n');
  const p = new Plugin(); p.app = {}; p.settings = { refineAgent: 'deepseek' };
  p.executor = executor; p.confirm = async () => ({ ok: true, limit: 1 });
  let observed;
  const finish = ProgressModal.prototype.finish;
  ProgressModal.prototype.finish = function(code, isError) {
    finish.call(this, code, isError); observed = [code, this.title];
  };
  await p.runRefineOnly();
  assert.equal(observed[0], 0); assert.match(observed[1], /deepseek/);
});
