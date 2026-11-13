// Loads the built main.js against a minimal fake "obsidian" module to make sure
// the plugin registers everything and its commands work. Run `npm run build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = path.join(root, "main.js");

// --- tiny fakes -----------------------------------------------------------
class FakeEl {
	children: FakeEl[] = [];
	text = "";
	classes: string[] = [];
	handlers: (() => void)[] = [];
	tag: string;
	constructor(tag = "div") { this.tag = tag; }
	empty() { this.children = []; }
	addClass(c: string) { this.classes.push(c); }
	setText(t: string) { this.text = t; }
	createDiv(o: { cls?: string; text?: string } = {}) { return this.createEl("div", o); }
	createSpan(o: { cls?: string; text?: string } = {}) { return this.createEl("span", o); }
	createEl(tag: string, o: { cls?: string; text?: string } = {}) {
		const el = new FakeEl(tag);
		if (o.cls) el.classes.push(o.cls);
		if (o.text) el.text = o.text;
		this.children.push(el);
		return el;
	}
	onClickEvent(h: () => void) { this.handlers.push(h); }
	allText(): string { return this.text + this.children.map((c) => c.allText()).join(""); }
}

function makeEditor(initial: string) {
	let value = initial;
	const lines = () => value.split("\n");
	const offsetToPos = (off: number) => {
		let line = 0;
		let rest = off;
		for (const l of lines()) {
			if (rest <= l.length) return { line, ch: rest };
			rest -= l.length + 1;
			line++;
		}
		return { line: lines().length - 1, ch: lines()[lines().length - 1].length };
	};
	const posToOffset = (p: { line: number; ch: number }) =>
		lines().slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
	return {
		getValue: () => value,
		offsetToPos,
		posToOffset,
		transaction(t: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }) {
			const ch = t.changes
				.map((c) => ({ from: posToOffset(c.from), to: posToOffset(c.to), text: c.text }))
				.sort((a, b) => b.from - a.from);
			for (const c of ch) value = value.slice(0, c.from) + c.text + value.slice(c.to);
		},
		replaceRange(text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) {
			const a = posToOffset(from);
			const b = posToOffset(to);
			value = value.slice(0, a) + text + value.slice(b);
		},
		setSelection() {},
		scrollIntoView() {},
	};
}

const registered: Record<string, unknown[]> = { views: [], commands: [], extensions: [], tabs: [], events: [] };
const notices: string[] = [];

class MarkdownView {
	file = { basename: "テスト", path: "test.md" };
	leaf = {};
	editor = makeEditor("映画が見れる。少々お待ち下さい。ご確認ください。お待ちください。ＡＢＣ");
}
const mdView = new MarkdownView();
const viewLeaves: { view: unknown }[] = [];

const fakeObsidian = {
	Plugin: class {
		app: unknown;
		data: unknown = null;
		constructor(app: unknown) { this.app = app; }
		async loadData() { return this.data; }
		async saveData(d: unknown) { this.data = d; }
		registerView(type: string, factory: unknown) { registered.views.push([type, factory]); }
		registerEditorExtension(e: unknown) { registered.extensions.push(e); }
		addSettingTab(t: unknown) { registered.tabs.push(t); }
		addStatusBarItem() { return new FakeEl(); }
		addRibbonIcon() { return new FakeEl(); }
		addCommand(c: unknown) { registered.commands.push(c); return c; }
		registerEvent(e: unknown) { registered.events.push(e); }
	},
	ItemView: class {
		contentEl = new FakeEl();
		app: unknown;
		leaf: unknown;
		constructor(leaf: unknown) { this.leaf = leaf; }
	},
	PluginSettingTab: class {
		containerEl = new FakeEl();
		app: unknown;
		plugin: unknown;
		constructor(app: unknown, plugin: unknown) { this.app = app; this.plugin = plugin; }
	},
	Setting: class {
		constructor(_el: unknown) {}
		setName() { return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		addToggle(cb: (t: unknown) => void) {
			const t = { setValue: () => t, onChange: () => t };
			cb(t);
			return this;
		}
		addText(cb: (t: unknown) => void) {
			const t = { inputEl: {}, setValue: () => t, onChange: () => t };
			cb(t);
			return this;
		}
		addTextArea(cb: (t: unknown) => void) {
			const t = { inputEl: {}, setValue: () => t, onChange: () => t };
			cb(t);
			return this;
		}
		addButton(cb: (b: unknown) => void) {
			const b = { setButtonText: () => b, onClick: () => b };
			cb(b);
			return this;
		}
	},
	Notice: class { constructor(msg: string) { notices.push(msg); } },
	MarkdownView,
	debounce: (fn: () => void) => fn,
	editorInfoField: {},
	TFile: class {},
	WorkspaceLeaf: class {},
	App: class {},
};

const fakeCM = {
	RangeSetBuilder: class { add() {} finish() { return []; } },
	Decoration: { mark: (o: unknown) => o },
	ViewPlugin: { fromClass: (cls: unknown, spec: unknown) => ({ cls, spec }) },
	EditorView: class {},
};

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (request: unknown, ...rest: unknown[]) {
	if (request === "obsidian") return fakeObsidian;
	if (request === "@codemirror/state" || request === "@codemirror/view") return fakeCM;
	return origLoad.call(this, request, ...rest);
};

test("built plugin loads, registers and fixes text", { skip: !existsSync(mainJs) && "run npm run build first" }, async () => {
	const require = createRequire(import.meta.url);
	const mod = require(mainJs);
	const PluginClass = mod.default ?? mod;

	const app = {
		workspace: {
			on: (name: string) => ({ name }),
			onLayoutReady: (cb: () => void) => cb(),
			getActiveViewOfType: () => mdView,
			getLeavesOfType: () => viewLeaves,
			updateOptions() {},
		},
		metadataCache: {
			on: (name: string) => ({ name }),
			getFileCache: () => ({ frontmatter: {} }),
		},
	};
	const plugin = new PluginClass(app, {});
	await plugin.onload();

	assert.equal(registered.views.length, 1);
	assert.equal(registered.extensions.length, 1);
	assert.equal(registered.tabs.length, 1);
	const commandIds = (registered.commands as { id: string }[]).map((c) => c.id).sort();
	assert.deepEqual(commandIds, ["fix-all", "open-issues", "toggle-underline"]);
	for (const id of commandIds) assert.ok(!id.includes("japanese-prose-checker"), "command id must not include plugin id");

	// settings tab renders without throwing
	(registered.tabs[0] as { display(): void }).display();

	// the issues panel renders the current note
	const [, factory] = registered.views[0] as [string, (leaf: unknown) => { render: Function; contentEl: FakeEl }];
	const view = factory({});
	viewLeaves.push({ view });
	plugin.refresh();
	const panelText = view.contentEl.allText();
	assert.match(panelText, /ら抜き言葉/);
	assert.match(panelText, /表記ゆれ/);

	// fix-all command rewrites the note
	const fixAll = (registered.commands as { id: string; editorCallback: Function }[]).find((c) => c.id === "fix-all")!;
	fixAll.editorCallback(mdView.editor, { file: mdView.file });
	assert.equal(mdView.editor.getValue(), "映画が見られる。少々お待ちください。ご確認ください。お待ちください。ABC");
	assert.match(notices.at(-1)!, /3件を修正しました/);

	// a note with `prose-check: false` is skipped
	app.metadataCache.getFileCache = () => ({ frontmatter: { "prose-check": false } });
	fixAll.editorCallback(makeEditor("見れる"), { file: mdView.file });
	assert.match(notices.at(-1)!, /チェック対象外/);
});
