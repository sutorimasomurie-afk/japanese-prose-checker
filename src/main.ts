import {
	App,
	debounce,
	editorInfoField,
	ItemView,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { check, CheckOptions, DEFAULT_OPTIONS, Issue, planFixes, RuleId, RULES } from "./rules";

const VIEW_TYPE = "japanese-prose-checker-issues";
/** Notes larger than this are not checked live, to keep typing responsive. */
const MAX_LIVE_LENGTH = 300_000;
/** Front matter property that turns checking off for a note: `prose-check: false`. */
const DISABLE_PROPERTY = "prose-check";

interface PluginSettings extends CheckOptions {
	underline: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	...DEFAULT_OPTIONS,
	enabled: { ...DEFAULT_OPTIONS.enabled },
	underline: true,
};

const RULE_NAME = new Map(RULES.map((r) => [r.id, r.name]));

export default class JapaneseProseChecker extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	/** Bumped whenever settings change so editor decorations know to recompute. */
	settingsVersion = 0;
	private lastMarkdownView: MarkdownView | null = null;
	private statusEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new IssuesView(leaf, this));
		this.registerEditorExtension(this.buildEditorExtension());
		this.addSettingTab(new ProseCheckerSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("jpc-status");
		this.statusEl.onClickEvent(() => void this.activateView());

		this.addRibbonIcon("spell-check", "日本語チェック：問題の一覧を開く", () => void this.activateView());

		this.addCommand({
			id: "open-issues",
			name: "問題の一覧を開く",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "fix-all",
			name: "このノートの自動修正できる問題をすべて直す",
			editorCallback: (editor, ctx) => {
				const file = ctx.file;
				if (file && this.isDisabledFor(file)) {
					new Notice(`このノートは ${DISABLE_PROPERTY}: false でチェック対象外です。`);
					return;
				}
				const n = this.fixAll(editor.getValue(), (changes) => editor.transaction({ changes }), editor);
				new Notice(n === 0 ? "自動修正できる問題はありません。" : `${n}件を修正しました。`);
			},
		});
		this.addCommand({
			id: "toggle-underline",
			name: "エディタの下線表示を切り替える",
			callback: async () => {
				this.settings.underline = !this.settings.underline;
				await this.saveSettings();
				new Notice(this.settings.underline ? "下線表示：オン" : "下線表示：オフ");
			},
		});

		const refreshSoon = debounce(() => this.refresh(), 400, true);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
				refreshSoon();
			}),
		);
		this.registerEvent(this.app.workspace.on("editor-change", () => refreshSoon()));
		this.registerEvent(this.app.metadataCache.on("changed", () => refreshSoon()));

		this.app.workspace.onLayoutReady(() => {
			this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
			this.refresh();
		});
	}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Partial<PluginSettings>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			enabled: { ...DEFAULT_SETTINGS.enabled, ...(saved.enabled ?? {}) },
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingsVersion++;
		// Reconfigure editors so the decoration plugin sees the new version.
		this.app.workspace.updateOptions();
		this.refresh();
	}

	isDisabledFor(file: TFile | null): boolean {
		if (!file) return false;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const value: unknown = fm?.[DISABLE_PROPERTY];
		return value === false || value === "false" || value === "off";
	}

	/** The Markdown view the user is working in, even while the issues panel has focus. */
	getTargetView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		if (this.lastMarkdownView?.file) return this.lastMarkdownView;
		return null;
	}

	checkText(text: string): Issue[] {
		return check(text, this.settings);
	}

	fixAll(
		text: string,
		transaction: (changes: { from: CodeMirrorPos; to: CodeMirrorPos; text: string }[]) => void,
		editor: { offsetToPos(offset: number): CodeMirrorPos },
	): number {
		const chosen = planFixes(this.checkText(text));
		if (chosen.length === 0) return 0;
		transaction(
			chosen.map((i) => ({
				from: editor.offsetToPos(i.from),
				to: editor.offsetToPos(i.to),
				text: i.replacement ?? "",
			})),
		);
		return chosen.length;
	}

	refresh() {
		const view = this.getTargetView();
		let issues: Issue[] = [];
		let disabled = false;
		if (view?.file) {
			disabled = this.isDisabledFor(view.file);
			if (!disabled) issues = this.checkText(view.editor.getValue());
		}
		if (this.statusEl) {
			if (!view || disabled) this.statusEl.setText("");
			else this.statusEl.setText(issues.length === 0 ? "日本語チェック ✓" : `日本語チェック ${issues.length}件`);
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof IssuesView) leaf.view.render(view, issues, disabled);
		}
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			leaf = right;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		this.refresh();
	}

	private buildEditorExtension() {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const plugin = this;
		return ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				version = plugin.settingsVersion;
				dirty = false;
				timer: number | null = null;

				constructor(view: EditorView) {
					this.decorations = this.build(view);
				}

				update(u: ViewUpdate) {
					if (this.dirty) {
						// A debounced recheck asked for this (empty) update.
						this.dirty = false;
						this.decorations = this.build(u.view);
					} else if (this.version !== plugin.settingsVersion) {
						this.version = plugin.settingsVersion;
						this.decorations = this.build(u.view);
					} else if (u.docChanged) {
						// Keep existing underlines in place while typing, recheck shortly after.
						this.decorations = this.decorations.map(u.changes);
						this.schedule(u.view);
					}
				}

				schedule(view: EditorView) {
					if (this.timer !== null) window.clearTimeout(this.timer);
					this.timer = window.setTimeout(() => {
						this.timer = null;
						this.dirty = true;
						view.dispatch({});
					}, 300);
				}

				destroy() {
					if (this.timer !== null) window.clearTimeout(this.timer);
				}

				build(view: EditorView): DecorationSet {
					const builder = new RangeSetBuilder<Decoration>();
					if (!plugin.settings.underline) return builder.finish();
					const file = view.state.field(editorInfoField, false)?.file ?? null;
					if (plugin.isDisabledFor(file)) return builder.finish();
					if (view.state.doc.length > MAX_LIVE_LENGTH) return builder.finish();
					const issues = plugin.checkText(view.state.doc.toString());
					for (const i of issues) {
						if (i.to <= i.from) continue;
						builder.add(
							i.from,
							i.to,
							Decoration.mark({
								class: `jpc-issue jpc-${i.severity}`,
								attributes: { title: `${RULE_NAME.get(i.ruleId) ?? i.ruleId}：${i.message}` },
							}),
						);
					}
					return builder.finish();
				}
			},
			{ decorations: (v) => v.decorations },
		);
	}
}

type CodeMirrorPos = { line: number; ch: number };

// ---------------------------------------------------------------------------

class IssuesView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: JapaneseProseChecker,
	) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "日本語チェック";
	}

	getIcon() {
		return "spell-check";
	}

	async onOpen() {
		this.plugin.refresh();
	}

	render(target: MarkdownView | null, issues: Issue[], disabled: boolean) {
		const root = this.contentEl;
		root.empty();
		root.addClass("jpc-panel");

		if (!target?.file) {
			root.createDiv({ cls: "jpc-empty", text: "Markdownノートを開くと、ここに問題が表示されます。" });
			return;
		}
		const header = root.createDiv({ cls: "jpc-header" });
		header.createDiv({ cls: "jpc-file", text: target.file.basename });

		if (disabled) {
			root.createDiv({ cls: "jpc-empty", text: `このノートは ${DISABLE_PROPERTY}: false のためチェックしていません。` });
			return;
		}

		const fixable = planFixes(issues).length;
		header.createDiv({
			cls: "jpc-summary",
			text: issues.length === 0 ? "問題は見つかりませんでした。" : `${issues.length}件（自動修正できるもの ${fixable}件）`,
		});
		if (fixable > 0) {
			const btn = header.createEl("button", { text: "すべて自動修正", cls: "mod-cta" });
			btn.onClickEvent(() => {
				const editor = target.editor;
				const n = this.plugin.fixAll(editor.getValue(), (changes) => editor.transaction({ changes }), editor);
				new Notice(`${n}件を修正しました。`);
				this.plugin.refresh();
			});
		}

		const text = target.editor.getValue();
		const list = root.createDiv({ cls: "jpc-list" });
		for (const issue of issues) {
			const item = list.createDiv({ cls: `jpc-item jpc-item-${issue.severity}` });
			const pos = target.editor.offsetToPos(issue.from);
			const top = item.createDiv({ cls: "jpc-item-top" });
			top.createSpan({ cls: "jpc-rule", text: RULE_NAME.get(issue.ruleId) ?? issue.ruleId });
			top.createSpan({ cls: "jpc-line", text: `${pos.line + 1}行目` });

			const excerpt = item.createDiv({ cls: "jpc-excerpt" });
			const before = text.slice(Math.max(0, issue.from - 12), issue.from).replace(/\n/g, " ");
			const hit = text.slice(issue.from, Math.min(issue.to, issue.from + 60)).replace(/\n/g, " ");
			const after = text.slice(issue.to, issue.to + 12).replace(/\n/g, " ");
			excerpt.createSpan({ text: before });
			excerpt.createSpan({ cls: "jpc-hit", text: hit + (issue.to - issue.from > 60 ? "…" : "") });
			excerpt.createSpan({ text: after });
			if (issue.replacement !== undefined) {
				excerpt.createSpan({ cls: "jpc-arrow", text: " → " });
				excerpt.createSpan({ cls: "jpc-replacement", text: issue.replacement === "" ? "（削除）" : issue.replacement });
			}

			item.createDiv({ cls: "jpc-message", text: issue.message });

			item.onClickEvent(() => this.reveal(target, issue));
			if (issue.replacement !== undefined) {
				const fixBtn = item.createEl("button", { text: "修正", cls: "jpc-fix" });
				fixBtn.onClickEvent((evt) => {
					evt.stopPropagation();
					this.fixOne(target, issue);
				});
			}
		}
	}

	private reveal(target: MarkdownView, issue: Issue) {
		const editor = target.editor;
		const from = editor.offsetToPos(issue.from);
		const to = editor.offsetToPos(issue.to);
		this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}

	private fixOne(target: MarkdownView, issue: Issue) {
		const editor = target.editor;
		// Re-check so we never apply a stale range after the note was edited.
		const current = this.plugin
			.checkText(editor.getValue())
			.find((i) => i.ruleId === issue.ruleId && i.from === issue.from && i.to === issue.to);
		if (!current || current.replacement === undefined) {
			new Notice("ノートが変更されたため修正できませんでした。一覧を更新します。");
			this.plugin.refresh();
			return;
		}
		editor.replaceRange(current.replacement, editor.offsetToPos(current.from), editor.offsetToPos(current.to));
		this.plugin.refresh();
	}
}

// ---------------------------------------------------------------------------

class ProseCheckerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: JapaneseProseChecker,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("エディタに下線を表示")
			.setDesc("問題のある箇所に波線を引きます。マウスを乗せると内容が表示されます。")
			.addToggle((t) => t.setValue(s.underline).onChange((v) => { s.underline = v; save(); }));

		new Setting(containerEl).setName("基本ルール").setHeading();
		for (const rule of RULES.filter((r) => !r.novel)) this.ruleToggle(containerEl, rule.id, rule.name, rule.description);

		new Setting(containerEl)
			.setName("一文の最大文字数")
			.setDesc("「長すぎる文」の基準です。")
			.addText((t) => this.numberInput(t, s.maxSentenceLength, 20, (v) => (s.maxSentenceLength = v)));
		new Setting(containerEl)
			.setName("一文の最大読点数")
			.setDesc("「読点が多すぎる文」の基準です。")
			.addText((t) => this.numberInput(t, s.maxCommas, 1, (v) => (s.maxCommas = v)));
		new Setting(containerEl)
			.setName("同じ文末が何回続いたら指摘するか")
			.addText((t) => this.numberInput(t, s.sameEndingRun, 2, (v) => (s.sameEndingRun = v)));

		new Setting(containerEl).setName("小説作法ルール").setHeading();
		const novelRules = RULES.filter((r) => r.novel);
		new Setting(containerEl)
			.setName("まとめて切り替え")
			.setDesc("Web小説・原稿用の表記ルールをまとめてオン／オフします。")
			.addButton((b) =>
				b.setButtonText("すべてオン").onClick(() => {
					novelRules.forEach((r) => (s.enabled[r.id] = true));
					save();
					this.display();
				}),
			)
			.addButton((b) =>
				b.setButtonText("すべてオフ").onClick(() => {
					novelRules.forEach((r) => (s.enabled[r.id] = false));
					save();
					this.display();
				}),
			);
		for (const rule of novelRules) this.ruleToggle(containerEl, rule.id, rule.name, rule.description);

		new Setting(containerEl).setName("カスタマイズ").setHeading();
		new Setting(containerEl)
			.setName("独自の表記ゆれ")
			.setDesc("1行に1組、「/」区切りで書きます。例：メール/Eメール")
			.addTextArea((t) => {
				t.setValue(s.customVariants).onChange((v) => { s.customVariants = v; save(); });
				t.inputEl.rows = 5;
			});
		new Setting(containerEl)
			.setName("無視する語")
			.setDesc("1行に1語。この語にかかる指摘は表示しません。")
			.addTextArea((t) => {
				t.setValue(s.ignoreWords).onChange((v) => { s.ignoreWords = v; save(); });
				t.inputEl.rows = 5;
			});
		new Setting(containerEl)
			.setName("ノートごとに無効にする")
			.setDesc(`ノートのプロパティに「${DISABLE_PROPERTY}: false」を書くと、そのノートはチェックしません。`);
	}

	private ruleToggle(el: HTMLElement, id: RuleId, name: string, desc: string) {
		const s = this.plugin.settings;
		new Setting(el)
			.setName(name)
			.setDesc(desc)
			.addToggle((t) =>
				t.setValue(s.enabled[id] ?? false).onChange((v) => {
					s.enabled[id] = v;
					void this.plugin.saveSettings();
				}),
			);
	}

	private numberInput(
		t: { setValue(v: string): unknown; onChange(cb: (v: string) => unknown): unknown; inputEl: HTMLInputElement },
		value: number,
		min: number,
		set: (v: number) => void,
	) {
		t.inputEl.type = "number";
		t.inputEl.min = String(min);
		t.setValue(String(value));
		t.onChange((raw) => {
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n) && n >= min) {
				set(n);
				void this.plugin.saveSettings();
			}
		});
	}
}
