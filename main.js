'use strict';

const obsidian = require('obsidian');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const DEFAULT_SETTINGS = {
  harnessRoot: '~/.ai-harness',
  refineAgent: 'codex-cli',
  defaultRefineLimit: 3,
  wikiNowRelative: '8000_DEV/8100_Super-Power/8140_llm-wiki-launcher/wiki-now.sh',
};
const SETTINGS_SAVE_DEBOUNCE_MS = 500;
const LOG_SCROLL_DEBOUNCE_MS = 16;
const MAX_PENDING_CHARS = 64 * 1024;
const MAX_LOG_CHARS = 256 * 1024;

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function vaultBasePath(app) {
  const adapter = app.vault.adapter;
  if (adapter instanceof obsidian.FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return adapter.basePath || '';
}

function buildPathEnv() {
  const home = os.homedir();
  const parts = [
    path.join(home, '.asdf', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    process.env.PATH || '/usr/bin:/bin',
  ];
  return [...new Set(parts)].join(':');
}

async function fileAccessible(targetPath, mode) {
  try {
    await fsp.access(targetPath, mode);
    return (await fsp.stat(targetPath)).isFile();
  } catch (_) {
    return false;
  }
}

function normalizeTargetDate(value) {
  const match = String(value).trim().match(/^(\d{4})([-/])(\d{2})\2(\d{2})$/);
  if (!match) throw new Error('날짜는 YYYY/MM/DD 형식으로 입력하세요');
  const [, year, , month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 12);
  if (Number(year) < 1000 || date.getFullYear() !== Number(year)
      || date.getMonth() + 1 !== Number(month) || date.getDate() !== Number(day)) {
    throw new Error('유효한 날짜를 입력하세요');
  }
  return `${year}-${month}-${day}`;
}

async function todayJournalInfo(vaultRoot, now = new Date()) {
  if (typeof now === 'string') now = new Date(`${normalizeTargetDate(now)}T12:00:00`);
  const y = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${mm}-${dd}`;
  const monthDir = path.join(vaultRoot, '0000_JOURNAL', String(y), mm);
  // ISO weeks use Thursday to determine their year, including January boundaries.
  const thursday = new Date(Date.UTC(y, now.getMonth(), now.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  const journalDir = path.join(monthDir, `W${String(week).padStart(2, '0')}`, today);
  const names = new Set();
  try {
    for (const dir of [journalDir, path.join(monthDir, today), monthDir]) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const match = entry.name.match(new RegExp(`^${today}-(\\d+)(?:-.*)?\\.md$`));
        if (entry.isFile() && match && Number(match[1]) > 0) names.add(entry.name);
      }
    }
  } catch (error) {
    return { today, count: null, journalDir, error: error.message };
  }
  return { today, count: names.size, journalDir };
}

class ProgressModal extends obsidian.Modal {
  constructor(app, title) {
    super(app);
    this.title = title;
    this.done = false;
    this.childProcess = null;
    this.scrollTimer = null;
    this.followOutput = true;
  }

  onOpen() {
    this.modalEl.addClass('llm-wiki-bridge-modal');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.title });
    const toolbar = contentEl.createEl('div', { cls: 'llm-wiki-bridge-actions' });
    const follow = toolbar.createEl('button', { text: '자동 스크롤: 켬' });
    follow.addEventListener('click', () => {
      this.followOutput = !this.followOutput;
      follow.setText(`자동 스크롤: ${this.followOutput ? '켬' : '끔'}`);
      if (this.followOutput) this.scheduleScroll();
    });
    const wrap = toolbar.createEl('button', { text: '줄바꿈: 켬' });
    let wrapped = true;
    wrap.addEventListener('click', () => {
      wrapped = !wrapped;
      this.logEl?.toggleClass('is-nowrap', !wrapped);
      wrap.setText(`줄바꿈: ${wrapped ? '켬' : '끔'}`);
    });
    this.statusEl = contentEl.createEl('p', { cls: 'llm-wiki-bridge-hint', text: '최근 256 Ki 문자 표시 · 창 모서리를 끌어 크기를 조절할 수 있습니다.' });
    this.logEl = contentEl.createEl('div', { cls: 'llm-wiki-bridge-log' });
    this.logEl.setText('시작 중…\n');
    const actions = contentEl.createEl('div', { cls: 'llm-wiki-bridge-actions' });
    this.closeBtn = actions.createEl('button', { text: '닫기', cls: 'mod-cta' });
    this.closeBtn.disabled = true;
    this.closeBtn.addEventListener('click', () => this.close());
  }

  append(line) {
    if (!this.logEl) return;
    this.logEl.appendText(`${line}\n`);
    if (this.logEl.textContent.length > MAX_LOG_CHARS) {
      this.logEl.textContent = this.logEl.textContent.slice(-MAX_LOG_CHARS);
      this.statusEl?.setText('로그가 길어 이전 출력 일부를 생략했습니다. 최근 256 Ki 문자만 표시합니다.');
    }
    this.scheduleScroll();
  }

  scheduleScroll() {
    if (!this.logEl || !this.followOutput || this.scrollTimer !== null) return;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (!this.logEl || !this.followOutput) return;
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }, LOG_SCROLL_DEBOUNCE_MS);
  }

  attachProcess(childProcess) {
    this.childProcess = childProcess;
  }

  clearProcess(childProcess) {
    if (!childProcess || this.childProcess === childProcess) {
      this.childProcess = null;
    }
  }

  finish(code, isError) {
    this.done = true;
    const failed = isError || code !== 0;
    if (failed) this.logEl?.addClass('is-error');
    this.append(!failed ? '\n✓ 완료' : `\n⚠ 실행 실패 (종료 코드: ${code})`);
    if (this.closeBtn) this.closeBtn.disabled = false;
  }

  onClose() {
    if (this.scrollTimer !== null) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.contentEl.empty();
    this.logEl = null;
    this.closeBtn = null;
    this.statusEl = null;
  }
}

class ConfirmRefineModal extends obsidian.Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.resolved = false;
    this.targetDate = opts.today;
    this.dateValid = !opts.journalError;
    this.dateRequest = 0;
  }

  onOpen() {
    const { limit, mode } = this.opts;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.opts.title });
    new obsidian.Setting(contentEl)
      .setName('대상 날짜')
      .setDesc('YYYY/MM/DD · 선택 날짜의 저널만 처리합니다')
      .addText((t) => t.setValue(this.targetDate.replace(/-/g, '/'))
        .setPlaceholder('YYYY/MM/DD')
        .onChange((value) => this.updateTargetDate(value)));
    this.summaryEl = contentEl.createEl('p', { cls: 'llm-wiki-bridge-hint' });
    this.renderSummary();

    if (mode !== 'full') {
      new obsidian.Setting(contentEl)
        .setName('위키 생성 건수 (1~20)')
        .addText((t) => {
          t.setValue(String(limit))
            .onChange((v) => {
              const n = parseInt(String(v).trim(), 10);
              if (Number.isInteger(n) && n >= 1 && n <= 20) {
                this.opts.limit = n;
                this.renderSummary();
              }
            });
        });
    }

    const actions = contentEl.createEl('div', { cls: 'llm-wiki-bridge-actions' });
    actions
      .createEl('button', { text: '취소' })
      .addEventListener('click', () => {
        this.resolved = true;
        this.resolve(false);
        this.close();
      });
    this.executeBtn = actions.createEl('button', { text: '실행', cls: 'mod-cta' });
    this.executeBtn.disabled = !this.dateValid;
    this.executeBtn.addEventListener('click', () => {
      if (!this.dateValid) return;
      this.resolved = true;
      this.resolve(true);
      this.close();
    });
  }

  renderSummary() {
    const { mode, count, limit, agent, journalError } = this.opts;
    const lines = [`대상: ${this.targetDate} · 저널 ${count === null ? '집계 실패' : `${count}건`}`];
    if (mode !== 'refine') lines.push('1단계: 선택 날짜 export → 후보 스캔 → 전체 위키 점검');
    if (mode !== 'full') lines.push(`${mode === 'oneshot' ? '2단계: ' : ''}같은 날짜의 승격 후보 상위 ${limit}건 → ${agent} 위키 생성`);
    if (journalError) lines.push(journalError);
    lines.push('건당 LLM API 비용이 발생할 수 있습니다.');
    this.summaryEl?.setText(lines.join('\n'));
  }

  async updateTargetDate(value) {
    const request = ++this.dateRequest;
    this.dateValid = false;
    this.executeBtn.disabled = true;
    try {
      const targetDate = normalizeTargetDate(value);
      this.summaryEl.setText(`${targetDate} 저널 집계 중…`);
      const info = await this.opts.loadJournalInfo(targetDate);
      if (request !== this.dateRequest) return;
      this.targetDate = targetDate;
      this.opts.count = info.count;
      this.opts.journalError = info.error;
      this.dateValid = info.count !== null && !info.error;
      this.executeBtn.disabled = !this.dateValid;
      this.renderSummary();
    } catch (error) {
      if (request === this.dateRequest) this.summaryEl?.setText(error.message);
    }
  }

  resolve(ok) {
    if (typeof this.opts.onResolve === 'function') this.opts.onResolve(ok, this.opts.limit, this.targetDate);
  }

  onClose() {
    this.dateRequest++;
    if (!this.resolved && typeof this.opts.onResolve === 'function') {
      this.opts.onResolve(false, this.opts.limit, this.targetDate);
    }
    this.contentEl.empty();
  }
}

class HarnessExecutor {
  constructor(plugin) {
    this.plugin = plugin;
  }

  paths() {
    const vault = vaultBasePath(this.plugin.app);
    const harness = expandHome(this.plugin.settings.harnessRoot);
    const wikiBin = path.join(harness, 'bin', 'wiki');
    const wikiNow = path.join(vault, this.plugin.settings.wikiNowRelative);
    return { vault, harness, wikiBin, wikiNow };
  }

  baseEnv() {
    const { vault, harness, wikiBin } = this.paths();
    return {
      ...process.env,
      _ZO_DOCTOR: '0',
      HARNESS_ROOT: harness,
      VAULT_ROOT: vault,
      WIKI_BIN: wikiBin,
      WIKI_AGENT: this.plugin.settings.refineAgent,
      PATH: buildPathEnv(),
    };
  }

  async preflight(mode, targetDate) {
    const { harness, wikiBin, wikiNow } = this.paths();
    const issues = [];
    if (!await fileAccessible(wikiBin, fs.constants.X_OK)) {
      issues.push(`wiki 파일 없음 또는 실행 불가: ${wikiBin}`);
    }
    if (mode !== 'refine' && !await fileAccessible(wikiNow, fs.constants.R_OK)) {
      issues.push(`wiki-now.sh 파일 없음 또는 읽기 불가: ${wikiNow}`);
    }
    if (mode === 'refine' || mode === 'oneshot') {
      const agent = this.plugin.settings.refineAgent;
      if (!/^[a-z][a-z0-9-]*$/.test(agent)) {
        issues.push('Refine 에이전트 이름이 올바르지 않습니다');
      } else {
        const refiner = path.join(harness, 'wiki', 'ingest', `refine-${agent}.sh`);
        if (!await fileAccessible(refiner, fs.constants.X_OK)) {
          issues.push(`지원하지 않거나 실행 불가한 에이전트: ${agent}`);
        }
        if (agent === 'codex-cli' && !await this.which('codex')) {
          issues.push('codex CLI 없음 — 설치와 PATH 확인');
        }
      }
    }
    if (targetDate) {
      const dateScripts = [path.join(harness, 'wiki', 'ingest', 'rag-intake-router.sh')];
      if (mode !== 'refine') dateScripts.push(wikiNow);
      if (mode === 'refine' || mode === 'oneshot') dateScripts.push(path.join(harness, 'wiki', 'ingest', 'refine-scan.sh'));
      for (const script of dateScripts) {
        try {
          if (!(await fsp.readFile(script, 'utf8')).includes('# wiki-bridge: target-date-v1')) {
            issues.push(`날짜 지정 지원 업데이트 필요: ${path.basename(script)}`);
          }
        } catch (_) {
          issues.push(`날짜 지정 지원 파일을 읽을 수 없음: ${path.basename(script)}`);
        }
      }
      if (!await fileAccessible(path.join(harness, 'wiki', 'lib', 'journal_date.py'), fs.constants.R_OK)) {
        issues.push('날짜 지정 지원 업데이트 필요: 하네스 저널 선택 도구');
      }
    }
    return issues;
  }

  which(cmd) {
    return new Promise((resolve) => {
      execFile('which', [cmd], { env: this.baseEnv() }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || '').trim() || null);
      });
    });
  }

  runStreaming(command, args, options, onLine) {
    const { vault } = this.paths();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || vault,
        env: this.baseEnv(),
        shell: false,
      });
      options.modal?.attachProcess(child);
      const pending = { stdout: '', stderr: '' };
      const flush = (stream, chunk) => {
        pending[stream] += chunk;
        const lines = pending[stream].split('\n');
        pending[stream] = lines.pop() || '';
        for (const line of lines) onLine(line);
        if (pending[stream].length > MAX_PENDING_CHARS) {
          const overflow = pending[stream].slice(0, pending[stream].length - MAX_PENDING_CHARS);
          if (overflow.length) onLine(overflow);
          pending[stream] = pending[stream].slice(-MAX_PENDING_CHARS);
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => flush('stdout', chunk));
      child.stderr.on('data', (chunk) => flush('stderr', chunk));
      child.on('error', (error) => {
        options.modal?.clearProcess(child);
        reject(error);
      });
      child.on('close', (code) => {
        options.modal?.clearProcess(child);
        for (const tail of Object.values(pending)) if (tail.length) onLine(tail);
        resolve(code ?? 1);
      });
    });
  }

  async runWikiNow(modal, targetDate) {
    const { wikiNow } = this.paths();
    const dateArgs = targetDate ? ['--date', normalizeTargetDate(targetDate)] : [];
    modal.append(`▶ wiki-now.sh (전체 정제) ${dateArgs.join(' ')}`);
    return this.runStreaming('bash', [wikiNow, ...dateArgs], { modal }, (line) => modal.append(line));
  }

  async runWikiNowSafe(modal) {
    const { wikiNow } = this.paths();
    modal.append('▶ wiki-now.sh --safe');
    return this.runStreaming('bash', [wikiNow, '--safe'], { modal }, (line) => modal.append(line));
  }

  async runRefineScan(modal, limit, targetDate) {
    const { wikiBin } = this.paths();
    const agent = this.plugin.settings.refineAgent;
    const dateArgs = targetDate ? ['--date', normalizeTargetDate(targetDate)] : [];
    modal.append(`▶ wiki refine-scan --limit ${limit} --agent ${agent} ${dateArgs.join(' ')}`);
    return this.runStreaming(
      wikiBin,
      ['refine-scan', '--limit', String(limit), '--agent', agent, '--yes', ...dateArgs],
      { modal },
      (line) => modal.append(line),
    );
  }
}

class LlmWikiBridgeSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'LLM Wiki Bridge' });

    new obsidian.Setting(containerEl)
      .setName('Harness 루트')
      .setDesc('~/.ai-harness 경로')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.harnessRoot)
          .onChange(async (v) => {
            this.plugin.settings.harnessRoot = v;
            await this.plugin.scheduleSaveSettings();
          }),
      );

    new obsidian.Setting(containerEl)
      .setName('Refine 에이전트')
      .setDesc('위키 LLM 생성 엔진 (기본: codex-cli)')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.refineAgent)
          .onChange(async (v) => {
            this.plugin.settings.refineAgent = v.trim() || 'codex-cli';
            await this.plugin.scheduleSaveSettings();
          }),
      );

    new obsidian.Setting(containerEl)
      .setName('기본 위키 생성 건수')
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.defaultRefineLimit))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (Number.isInteger(n) && n >= 1 && n <= 20) {
              this.plugin.settings.defaultRefineLimit = n;
              await this.plugin.scheduleSaveSettings();
            }
          }),
      );

    new obsidian.Setting(containerEl)
      .setName('wiki-now.sh 상대 경로')
      .setDesc('볼트 루트 기준')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.wikiNowRelative)
          .onChange(async (v) => {
            this.plugin.settings.wikiNowRelative = v.trim();
            await this.plugin.scheduleSaveSettings();
          }),
      );

    new obsidian.Setting(containerEl)
      .setName('사전 점검')
      .setDesc('wiki · wiki-now.sh · 선택한 Refine 에이전트 (로그인 상태는 실행 시 확인)')
      .addButton((b) =>
        b.setButtonText('테스트').setCta().onClick(async () => {
          const issues = await this.plugin.executor.preflight('oneshot');
          if (issues.length === 0) new obsidian.Notice('✓ LLM Wiki Bridge 사전 점검 통과');
          else new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
        }),
      );
  }
}

class LlmWikiBridgePlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.executor = new HarnessExecutor(this);

    this.addRibbonIcon('book-open', 'LLM Wiki 원샷', () => this.runOneshot());

    this.addCommand({
      id: 'wiki-safe-check',
      name: '③ 정제 안전 점검 (lint+doctor)',
      callback: () => this.runSafe(),
    });
    this.addCommand({
      id: 'wiki-full-refine',
      name: '③ 전체 정제 (export→scan→lint)',
      callback: () => this.runFull(),
    });
    this.addCommand({
      id: 'wiki-refine-scan',
      name: '③ refine-scan 위키 생성',
      callback: () => this.runRefineOnly(),
    });
    this.addCommand({
      id: 'wiki-full-refine-oneshot',
      name: '③ 전체 정제 + 위키 생성 (원샷)',
      callback: () => this.runOneshot(),
    });

    this.addSettingTab(new LlmWikiBridgeSettingTab(this.app, this));
  }

  async confirm(mode) {
    const { today, count, error } = await todayJournalInfo(vaultBasePath(this.app));
    const limit = this.settings.defaultRefineLimit;
    return new Promise((resolve) => {
      const titles = {
        full: '🚀 LLM-Wiki 전체 정제',
        refine: '🦭 LLM-Wiki 위키 생성',
        oneshot: '🚀🦭 전체 정제 + 위키 생성',
      };
      const modal = new ConfirmRefineModal(this.app, {
        title: titles[mode] || 'LLM Wiki',
        mode,
        today,
        count,
        journalError: error,
        agent: this.settings.refineAgent,
        limit,
        loadJournalInfo: (date) => todayJournalInfo(vaultBasePath(this.app), date),
        onResolve: (ok, n, targetDate) => resolve({ ok, limit: n, targetDate }),
      });
      modal.open();
    });
  }

  async runSafe() {
    const issues = await this.executor.preflight('safe');
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, '🔄 LLM-Wiki 안전 점검');
    modal.open();
    try {
      const code = await this.executor.runWikiNowSafe(modal);
      modal.finish(code, code !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async runFull() {
    const { ok, targetDate } = await this.confirm('full');
    if (!ok) return;
    const issues = await this.executor.preflight('full', targetDate);
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, `🚀 LLM-Wiki 전체 정제 (${targetDate})`);
    modal.open();
    try {
      const code = await this.executor.runWikiNow(modal, targetDate);
      modal.finish(code, code !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async runRefineOnly() {
    const { ok, limit, targetDate } = await this.confirm('refine');
    if (!ok) return;
    const issues = await this.executor.preflight('refine', targetDate);
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, `🦭 위키 생성 (${targetDate}, ${this.settings.refineAgent}, ${limit}건)`);
    modal.open();
    try {
      const code = await this.executor.runRefineScan(modal, limit, targetDate);
      modal.finish(code, code !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async runOneshot() {
    const { ok, limit, targetDate } = await this.confirm('oneshot');
    if (!ok) return;
    const issues = await this.executor.preflight('oneshot', targetDate);
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, `🚀🦭 전체 정제 + 위키 생성 (${targetDate})`);
    modal.open();
    try {
      modal.append('══ 1/2 전체 정제 ══');
      const code1 = await this.executor.runWikiNow(modal, targetDate);
      if (code1 !== 0) modal.append('⚠ 1단계 비정상 종료 — 2단계 계속 시도');
      modal.append('\n══ 2/2 위키 생성 ══');
      const code2 = await this.executor.runRefineScan(modal, limit, targetDate);
      modal.finish(code1 !== 0 ? code1 : code2, code1 !== 0 || code2 !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (this.settings.harnessRoot === '~/.ai_harness') {
      this.settings.harnessRoot = DEFAULT_SETTINGS.harnessRoot;
    }
  }

  scheduleSaveSettings() {
    return new Promise((resolve, reject) => {
      this.pendingSaveWaiters = this.pendingSaveWaiters || [];
      this.pendingSaveWaiters.push({ resolve, reject });
      if (this.pendingSaveTimer) clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = setTimeout(async () => {
        this.pendingSaveTimer = null;
        const waiters = this.pendingSaveWaiters.splice(0);
        try {
          await this.saveSettings();
          waiters.forEach(({ resolve: done }) => done());
        } catch (error) {
          waiters.forEach(({ reject: fail }) => fail(error));
        }
      }, SETTINGS_SAVE_DEBOUNCE_MS);
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async onunload() {
    if (!this.pendingSaveTimer) return;
    clearTimeout(this.pendingSaveTimer);
    this.pendingSaveTimer = null;
    const waiters = this.pendingSaveWaiters?.splice(0) || [];
    try {
      await this.saveSettings();
      waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      waiters.forEach(({ reject }) => reject(error));
    }
  }
}

module.exports = LlmWikiBridgePlugin;
