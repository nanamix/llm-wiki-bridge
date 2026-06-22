'use strict';

const obsidian = require('obsidian');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_SETTINGS = {
  harnessRoot: '~/.ai_harness',
  refineAgent: 'codex-cli',
  defaultRefineLimit: 3,
  wikiNowRelative: '8000_DEV/8100_Super-Power/8140_llm-wiki-launcher/wiki-now.sh',
};

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

function todayJournalInfo(vaultRoot) {
  const now = new Date();
  const y = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${mm}-${dd}`;
  const journalDir = path.join(vaultRoot, '0000_JOURNAL', String(y), mm);
  let count = 0;
  try {
    if (fs.existsSync(journalDir)) {
      count = fs
        .readdirSync(journalDir)
        .filter((f) => f.startsWith(`${today}-`) && f.endsWith('.md')).length;
    }
  } catch (_) {
    /* ignore */
  }
  return { today, count, journalDir };
}

class ProgressModal extends obsidian.Modal {
  constructor(app, title) {
    super(app);
    this.title = title;
    this.done = false;
  }

  onOpen() {
    this.modalEl.addClass('llm-wiki-bridge-modal');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.title });
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
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  finish(code, isError) {
    this.done = true;
    if (isError) this.logEl?.addClass('is-error');
    this.append(code === 0 ? '\n✓ 완료' : `\n⚠ 종료 코드: ${code}`);
    if (this.closeBtn) this.closeBtn.disabled = false;
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmRefineModal extends obsidian.Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.resolved = false;
  }

  onOpen() {
    const { today, count, limit, mode } = this.opts;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.opts.title });

    const body = [];
    if (mode === 'oneshot' || mode === 'full') {
      body.push(`1단계: 오늘(${today}) 저널 ${count}건 → export→ingest→lint→doctor`);
    }
    if (mode === 'oneshot' || mode === 'refine') {
      body.push(
        `${mode === 'oneshot' ? '2단계: ' : ''}승격 후보 상위 ${limit}건 → Codex CLI 위키 생성`,
      );
    }
    body.push('건당 LLM API 비용이 발생할 수 있습니다.');
    contentEl.createEl('p', { text: body.join('\n'), cls: 'llm-wiki-bridge-hint' });

    if (mode !== 'full') {
      new obsidian.Setting(contentEl)
        .setName('위키 생성 건수 (1~20)')
        .addText((t) => {
          t.setValue(String(limit))
            .onChange((v) => {
              const n = parseInt(String(v).trim(), 10);
              if (Number.isInteger(n) && n >= 1 && n <= 20) this.opts.limit = n;
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
    actions
      .createEl('button', { text: '실행', cls: 'mod-cta' })
      .addEventListener('click', () => {
        this.resolved = true;
        this.resolve(true);
        this.close();
      });
  }

  resolve(ok) {
    if (typeof this.opts.onResolve === 'function') this.opts.onResolve(ok, this.opts.limit);
  }

  onClose() {
    if (!this.resolved && typeof this.opts.onResolve === 'function') {
      this.opts.onResolve(false, this.opts.limit);
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

  async preflight(requireCodex) {
    const { wikiBin, wikiNow } = this.paths();
    const issues = [];
    if (!fs.existsSync(wikiBin)) issues.push(`wiki 없음: ${wikiBin}`);
    if (!fs.existsSync(wikiNow)) issues.push(`wiki-now.sh 없음: ${wikiNow}`);
    if (requireCodex) {
      const codex = await this.which('codex');
      if (!codex) issues.push('codex CLI 없음 — 로그인/설치 확인');
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
      let pending = '';
      const flush = (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.length) onLine(line);
        }
      };
      child.stdout.on('data', (d) => flush(d.toString()));
      child.stderr.on('data', (d) => flush(d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (pending.trim()) onLine(pending.trim());
        resolve(code ?? 1);
      });
    });
  }

  async runWikiNow(modal) {
    const { wikiNow } = this.paths();
    modal.append('▶ wiki-now.sh (전체 정제)');
    return this.runStreaming('bash', [wikiNow], {}, (line) => modal.append(line));
  }

  async runWikiNowSafe(modal) {
    const { wikiNow } = this.paths();
    modal.append('▶ wiki-now.sh --safe');
    return this.runStreaming('bash', [wikiNow, '--safe'], {}, (line) => modal.append(line));
  }

  async runRefineScan(modal, limit) {
    const { wikiBin } = this.paths();
    const agent = this.plugin.settings.refineAgent;
    modal.append(`▶ wiki refine-scan --limit ${limit} --agent ${agent}`);
    return this.runStreaming(
      wikiBin,
      ['refine-scan', '--limit', String(limit), '--agent', agent, '--yes'],
      {},
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
      .setDesc('~/.ai_harness 경로')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.harnessRoot)
          .onChange(async (v) => {
            this.plugin.settings.harnessRoot = v;
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
              await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          }),
      );

    new obsidian.Setting(containerEl)
      .setName('사전 점검')
      .setDesc('wiki · wiki-now.sh · codex CLI')
      .addButton((b) =>
        b.setButtonText('테스트').setCta().onClick(async () => {
          const issues = await this.plugin.executor.preflight(true);
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
      name: '③ refine-scan 위키 생성 (Codex)',
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
    const { today, count } = todayJournalInfo(vaultBasePath(this.app));
    const limit = this.settings.defaultRefineLimit;
    return new Promise((resolve) => {
      const titles = {
        full: '🚀 LLM-Wiki 전체 정제',
        refine: '🦭 LLM-Wiki 위키 생성 (Codex)',
        oneshot: '🚀🦭 전체 정제 + 위키 생성',
      };
      const modal = new ConfirmRefineModal(this.app, {
        title: titles[mode] || 'LLM Wiki',
        mode,
        today,
        count,
        limit,
        onResolve: (ok, n) => resolve({ ok, limit: n }),
      });
      modal.open();
    });
  }

  async runSafe() {
    const issues = await this.executor.preflight(false);
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
    const { ok } = await this.confirm('full');
    if (!ok) return;
    const issues = await this.executor.preflight(false);
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, '🚀 LLM-Wiki 전체 정제');
    modal.open();
    try {
      const code = await this.executor.runWikiNow(modal);
      modal.finish(code, code !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async runRefineOnly() {
    const { ok, limit } = await this.confirm('refine');
    if (!ok) return;
    const issues = await this.executor.preflight(true);
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, `🦭 위키 생성 (Codex, ${limit}건)`);
    modal.open();
    try {
      const code = await this.executor.runRefineScan(modal, limit);
      modal.finish(code, code !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async runOneshot() {
    const { ok, limit } = await this.confirm('oneshot');
    if (!ok) return;
    const issues = await this.executor.preflight(true);
    if (issues.length) {
      new obsidian.Notice(`⚠ ${issues.join(' · ')}`, 8000);
      return;
    }
    const modal = new ProgressModal(this.app, '🚀🦭 전체 정제 + 위키 생성');
    modal.open();
    try {
      modal.append('══ 1/2 전체 정제 ══');
      const code1 = await this.executor.runWikiNow(modal);
      if (code1 !== 0) modal.append('⚠ 1단계 비정상 종료 — 2단계 계속 시도');
      modal.append('\n══ 2/2 위키 생성 ══');
      const code2 = await this.executor.runRefineScan(modal, limit);
      modal.finish(code2, code1 !== 0 || code2 !== 0);
    } catch (e) {
      modal.append(String(e.message || e));
      modal.finish(1, true);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = LlmWikiBridgePlugin;
