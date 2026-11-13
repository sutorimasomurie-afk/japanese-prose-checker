// Pure rule engine for Japanese prose checks.
// This file must not import "obsidian" so it can be unit-tested with plain Node.

export type Severity = "error" | "warning" | "info";

export interface Issue {
	ruleId: RuleId;
	from: number; // offset in the original text (UTF-16 code units)
	to: number;
	message: string;
	severity: Severity;
	/** If set, replacing text[from, to) with this string fixes the issue. */
	replacement?: string;
}

export type RuleId =
	| "ra-nuki"
	| "double-honorific"
	| "redundant"
	| "variant"
	| "fullwidth-alnum"
	| "halfwidth-kana"
	| "ellipsis"
	| "dash"
	| "punct-mix"
	| "space-between-ja"
	| "long-sentence"
	| "many-commas"
	| "same-ending"
	| "space-after-mark"
	| "period-before-bracket"
	| "indent";

export interface RuleInfo {
	id: RuleId;
	name: string;
	description: string;
	defaultOn: boolean;
	/** Rules that follow Japanese fiction-manuscript conventions. */
	novel: boolean;
}

export const RULES: RuleInfo[] = [
	{ id: "ra-nuki", name: "ら抜き言葉", description: "「見れる」「来れる」などを「見られる」「来られる」に。", defaultOn: true, novel: false },
	{ id: "double-honorific", name: "二重敬語", description: "「おっしゃられる」「ご覧になられる」など。", defaultOn: true, novel: false },
	{ id: "redundant", name: "重複表現", description: "「頭痛が痛い」「馬から落馬」「一番最初」など。", defaultOn: true, novel: false },
	{ id: "variant", name: "表記ゆれ", description: "同じノートの中で「下さい／ください」「サーバ／サーバー」などが混在。少ない方を指摘。", defaultOn: true, novel: false },
	{ id: "fullwidth-alnum", name: "全角英数字", description: "「ＡＢＣ１２３」を半角に。", defaultOn: true, novel: false },
	{ id: "halfwidth-kana", name: "半角カナ", description: "「ｶﾀｶﾅ」を全角に。", defaultOn: true, novel: false },
	{ id: "ellipsis", name: "三点リーダー", description: "「...」「・・・」や奇数個の「…」を「……」に。", defaultOn: true, novel: false },
	{ id: "dash", name: "ダッシュ", description: "奇数個の「―」や、長音符「ーー」で代用したダッシュを「――」に。", defaultOn: true, novel: false },
	{ id: "punct-mix", name: "句読点の混在", description: "「、。」と「，．」が混在しているとき、少ない方を指摘。", defaultOn: true, novel: false },
	{ id: "space-between-ja", name: "日本語の間の半角スペース", description: "「日本 語」のような不要なスペース。", defaultOn: true, novel: false },
	{ id: "long-sentence", name: "長すぎる文", description: "一文の文字数が上限を超えている。", defaultOn: true, novel: false },
	{ id: "many-commas", name: "読点が多すぎる文", description: "一文の読点の数が上限を超えている。", defaultOn: true, novel: false },
	{ id: "same-ending", name: "同じ文末の連続", description: "「〜た。〜た。〜た。〜た。」のように同じ文末が続いている。", defaultOn: true, novel: false },
	{ id: "space-after-mark", name: "！？の後の全角スペース", description: "（小説作法）文中の「！」「？」の後に全角スペースを入れる。", defaultOn: false, novel: true },
	{ id: "period-before-bracket", name: "閉じかっこ前の句点", description: "（小説作法）「〜です。」を「〜です」に。", defaultOn: false, novel: true },
	{ id: "indent", name: "段落頭の字下げ", description: "（小説作法）地の文の段落頭に全角スペースを入れる。", defaultOn: false, novel: true },
];

export interface CheckOptions {
	enabled: Partial<Record<RuleId, boolean>>;
	maxSentenceLength: number;
	maxCommas: number;
	sameEndingRun: number;
	/** One group per line, variants separated by "/" (e.g. "メール/Eメール"). */
	customVariants: string;
	/** One word per line. Issues whose matched text contains one of these are dropped. */
	ignoreWords: string;
}

export const DEFAULT_OPTIONS: CheckOptions = {
	enabled: Object.fromEntries(RULES.map((r) => [r.id, r.defaultOn])) as Record<RuleId, boolean>,
	maxSentenceLength: 100,
	maxCommas: 4,
	sameEndingRun: 4,
	customVariants: "",
	ignoreWords: "",
};

// ---------------------------------------------------------------------------
// Character classes

const KANA_KANJI = "\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3005";
const JA_RE = new RegExp(`[${KANA_KANJI}]`);
const KATAKANA_TAIL_RE = /[ァ-ヺー]/;
/** Placeholder written over Markdown syntax that must not be checked. */
export const MASK = "\u0001";

function isJa(ch: string | undefined): boolean {
	return ch !== undefined && JA_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Masking: hide code, front matter, links, HTML, math and comments while
// keeping every offset (and every newline) intact.

export function maskMarkdown(text: string): string {
	const chars = text.split("");
	const blank = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = MASK;
	};
	const blankAll = (re: RegExp, group = 0) => {
		for (const m of text.matchAll(re)) {
			if (m.index === undefined) continue;
			if (group === 0) {
				blank(m.index, m.index + m[0].length);
			} else if (m[group] !== undefined) {
				const start = m.index + m[0].indexOf(m[group]);
				blank(start, start + m[group].length);
			}
		}
	};

	// Front matter
	const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
	if (fm) blank(0, fm[0].length);
	// Fenced code blocks (``` or ~~~), unterminated fences run to the end
	blankAll(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm);
	// Math blocks and inline math
	blankAll(/\$\$[\s\S]*?\$\$/g);
	blankAll(/(?<![\\$])\$(?![\s$])[^$\n]+?(?<!\s)\$(?!\d)/g);
	// Obsidian comments
	blankAll(/%%[\s\S]*?%%/g);
	// HTML comments and tags
	blankAll(/<!--[\s\S]*?-->/g);
	blankAll(/<\/?[A-Za-z][^>\n]*>/g);
	// Inline code
	blankAll(/(`+)[^`\n][\s\S]*?\1/g);
	// Wikilinks / embeds: [[target|alias]] -> keep alias text only
	for (const m of text.matchAll(/!?\[\[([^\]\n]*)\]\]/g)) {
		if (m.index === undefined) continue;
		const inner = m[1];
		const bar = inner.lastIndexOf("|");
		if (bar >= 0 && !m[0].startsWith("!")) {
			blank(m.index, m.index + 2 + bar + 1);
			blank(m.index + m[0].length - 2, m.index + m[0].length);
		} else {
			blank(m.index, m.index + m[0].length);
		}
	}
	// Markdown link targets and bare URLs
	blankAll(/\]\(([^)\n]*)\)/g);
	blankAll(/\b(?:https?|ftp|file|obsidian):\/\/[^\s<>)\]]+/g);
	// Ruby readings: 漢字《かんじ》 and {漢字|かんじ}
	blankAll(/《([^《》\n]*)》/g, 1);
	blankAll(/\{[^{}|\n]+\|([^{}\n]*)\}/g, 1);
	// Tags like #タグ
	blankAll(/(?<=^|\s)#[^\s#]+/gm);

	return chars.join("");
}

// ---------------------------------------------------------------------------
// Rule data

const RA_NUKI_STEMS = [
	"着替え", "見つけ", "起き", "生き", "過ぎ", "落ち", "降り", "借り", "浴び", "信じ", "感じ", "閉じ",
	"食べ", "考え", "決め", "止め", "辞め", "変え", "覚え", "教え", "答え", "調べ", "比べ", "投げ",
	"逃げ", "受け", "続け", "開け", "建て", "捨て", "育て", "忘れ", "入れ", "始め", "集め", "求め",
	"認め", "伝え", "加え", "越え", "超え", "耐え", "迎え", "見せ", "乗せ", "任せ", "寄せ", "避け",
	"見", "来", "出", "寝", "着", "居", "似", "煮", "干", "射",
];
const RA_NUKI_RE = new RegExp(
	`(${RA_NUKI_STEMS.join("|")})れ(る|ない|なかった|なく|た|ます|ません|ず|て)`,
	"g",
);

interface Phrase {
	pattern: RegExp;
	message: string;
	replacement?: string;
}

const DOUBLE_HONORIFIC: Phrase[] = [
	{ pattern: /おっしゃられ/g, message: "二重敬語です。「おっしゃる」で十分です。" },
	{ pattern: /(?:お|ご)[぀-ゟ一-鿿]{1,6}?になられ/g, message: "二重敬語です。「お〜になる」または「〜られる」のどちらか一方にします。" },
	{ pattern: /拝見させていただ/g, message: "過剰な敬語です。「拝見します」で十分です。" },
	{ pattern: /お伺いさせていただ/g, message: "過剰な敬語です。「伺います」で十分です。" },
	{ pattern: /お伺いいたし/g, message: "二重敬語です。「伺います」で十分です。" },
];

const REDUNDANT: Phrase[] = [
	{ pattern: /頭痛が痛い/g, message: "重複表現です。", replacement: "頭が痛い" },
	{ pattern: /馬から落馬/g, message: "重複表現です。", replacement: "落馬" },
	{ pattern: /後で後悔/g, message: "重複表現です。", replacement: "後悔" },
	{ pattern: /一番最初/g, message: "重複表現です。", replacement: "最初" },
	{ pattern: /一番最後/g, message: "重複表現です。", replacement: "最後" },
	{ pattern: /まず最初に/g, message: "重複表現です。", replacement: "最初に" },
	{ pattern: /まず初めに/g, message: "重複表現です。", replacement: "初めに" },
	{ pattern: /今の現状/g, message: "重複表現です。", replacement: "現状" },
	{ pattern: /今現在/g, message: "重複表現です。", replacement: "現在" },
	{ pattern: /必ず必要/g, message: "重複表現です。", replacement: "必要" },
	{ pattern: /日本に来日/g, message: "重複表現です。", replacement: "来日" },
	{ pattern: /色が変色/g, message: "重複表現です。", replacement: "変色" },
	{ pattern: /従来から/g, message: "重複表現です。", replacement: "従来" },
	{ pattern: /炎天下の下/g, message: "重複表現です。", replacement: "炎天下" },
	{ pattern: /違和感を感じ/g, message: "重複表現です。「違和感を覚え〜」などに言い換えます。" },
	{ pattern: /被害を被/g, message: "重複表現です。「被害を受け〜」などに言い換えます。" },
	{ pattern: /犯罪を犯/g, message: "重複表現です。「罪を犯〜」などに言い換えます。" },
	{ pattern: /過半数を超え/g, message: "重複表現です。「過半数を占め〜」などに言い換えます。" },
	{ pattern: /挙式を挙げ/g, message: "重複表現です。「式を挙げ〜」などに言い換えます。" },
	{ pattern: /内定が決ま/g, message: "重複表現です。「内定する」などに言い換えます。" },
	{ pattern: /射程距離/g, message: "重複表現です。", replacement: "射程" },
	{ pattern: /製造メーカー/g, message: "重複表現です。", replacement: "メーカー" },
];

/** Each group lists variants; each variant lists parallel forms (same index = same meaning). */
type VariantGroup = string[][];

const BUILTIN_VARIANTS: VariantGroup[] = [
	[["下さい"], ["ください"]],
	[["出来る", "出来な", "出来た", "出来ま", "出来て"], ["できる", "できな", "できた", "できま", "できて"]],
	[["頂く", "頂き", "頂け", "頂い"], ["いただく", "いただき", "いただけ", "いただい"]],
	[["致し"], ["いたし"]],
	[["宜しく"], ["よろしく"]],
	[["全て"], ["すべて"]],
	[["様々"], ["さまざま"]],
	[["沢山"], ["たくさん"]],
	[["殆ど"], ["ほとんど"]],
	[["予め"], ["あらかじめ"]],
	[["但し"], ["ただし"]],
	[["及び"], ["および"]],
	[["又は"], ["または"]],
	[["例えば"], ["たとえば"]],
	[["一緒"], ["いっしょ"]],
	[["綺麗"], ["きれい"]],
	[["分かる", "分から", "分かり", "分かっ"], ["わかる", "わから", "わかり", "わかっ"]],
	[["子供"], ["子ども"]],
	[["友達"], ["友だち"]],
	[["時々"], ["ときどき"]],
	[["何故"], ["なぜ"]],
	[["既に"], ["すでに"]],
	[["更に"], ["さらに"]],
	[["コンピュータ"], ["コンピューター"]],
	[["サーバ"], ["サーバー"]],
	[["ユーザ"], ["ユーザー"]],
	[["メモリ"], ["メモリー"]],
	[["プリンタ"], ["プリンター"]],
	[["ブラウザ"], ["ブラウザー"]],
	[["フォルダ"], ["フォルダー"]],
	[["パラメータ"], ["パラメーター"]],
	[["エディタ"], ["エディター"]],
	[["ヴァイオリン"], ["バイオリン"]],
];

export function parseCustomVariants(src: string): VariantGroup[] {
	const groups: VariantGroup[] = [];
	for (const line of src.split(/\r?\n/)) {
		const parts = line
			.split(/[\/／,，、]/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const unique = [...new Set(parts)];
		if (unique.length >= 2) groups.push(unique.map((p) => [p]));
	}
	return groups;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Rule implementations

type Ctx = { text: string; masked: string; opts: CheckOptions; out: Issue[] };

function push(ctx: Ctx, issue: Issue) {
	// Drop issues that touch masked (non-prose) characters.
	for (let i = issue.from; i < issue.to; i++) if (ctx.masked[i] === MASK) return;
	ctx.out.push(issue);
}

function ruleRaNuki(ctx: Ctx) {
	for (const m of ctx.masked.matchAll(RA_NUKI_RE)) {
		const from = m.index!;
		const stem = m[1];
		// Avoid matching the tail of a longer word, e.g. 「出来れ」 inside 「出来れる」 is not ra-nuki of 来.
		const prev = ctx.masked[from - 1];
		if (stem === "来" && prev === "出") continue;
		if (stem.length === 1 && prev !== undefined && /[一-鿿]/.test(prev)) continue;
		push(ctx, {
			ruleId: "ra-nuki",
			from,
			to: from + m[0].length,
			severity: "warning",
			message: `ら抜き言葉です。「${stem}られ${m[2]}」が標準的です。`,
			replacement: `${stem}られ${m[2]}`,
		});
	}
}

function rulePhrases(ctx: Ctx, list: Phrase[], ruleId: RuleId, severity: Severity) {
	for (const p of list) {
		p.pattern.lastIndex = 0;
		for (const m of ctx.masked.matchAll(p.pattern)) {
			const from = m.index!;
			const suggestion = p.replacement ? `「${p.replacement}」にします。` : "";
			push(ctx, {
				ruleId,
				from,
				to: from + m[0].length,
				severity,
				message: p.message + suggestion,
				replacement: p.replacement,
			});
		}
	}
}

function ruleVariants(ctx: Ctx) {
	const groups = [...BUILTIN_VARIANTS, ...parseCustomVariants(ctx.opts.customVariants)];
	for (const group of groups) {
		// form -> [variantIndex, formIndex]
		const lookup = new Map<string, [number, number]>();
		group.forEach((forms, vi) => forms.forEach((f, fi) => lookup.set(f, [vi, fi])));
		const alts = [...lookup.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
		const re = new RegExp(alts.join("|"), "g");
		const hits: { from: number; to: number; vi: number; fi: number }[] = [];
		const counts = new Array<number>(group.length).fill(0);
		for (const m of ctx.masked.matchAll(re)) {
			const from = m.index!;
			const to = from + m[0].length;
			const last = m[0][m[0].length - 1];
			// Katakana words must end at a word boundary (ユーザ vs ユーザビリティ).
			if (KATAKANA_TAIL_RE.test(last) && KATAKANA_TAIL_RE.test(ctx.masked[to] ?? "")) continue;
			const [vi, fi] = lookup.get(m[0])!;
			hits.push({ from, to, vi, fi });
			counts[vi]++;
		}
		const used = counts.filter((c) => c > 0).length;
		if (used < 2) continue;
		let major = 0;
		counts.forEach((c, i) => {
			if (c > counts[major]) major = i;
		});
		const majorLabel = group[major][0];
		for (const h of hits) {
			if (h.vi === major) continue;
			const forms = group[major];
			const replacement = forms[h.fi] ?? forms[0];
			push(ctx, {
				ruleId: "variant",
				from: h.from,
				to: h.to,
				severity: "info",
				message: `表記ゆれです。このノートでは「${majorLabel}」が多く使われています（${counts[major]}回）。`,
				replacement,
			});
		}
	}
}

function ruleRegexReplace(
	ctx: Ctx,
	re: RegExp,
	ruleId: RuleId,
	severity: Severity,
	message: (m: string) => string,
	replace: (m: string, from: number) => string | null,
) {
	for (const m of ctx.masked.matchAll(re)) {
		const from = m.index!;
		const r = replace(m[0], from);
		if (r === null) continue;
		push(ctx, { ruleId, from, to: from + m[0].length, severity, message: message(m[0]), replacement: r });
	}
}

function ruleCharForms(ctx: Ctx) {
	const { enabled } = ctx.opts;
	if (enabled["fullwidth-alnum"])
		ruleRegexReplace(ctx, /[Ａ-Ｚａ-ｚ０-９]+/g, "fullwidth-alnum", "info",
			() => "全角英数字です。半角にします。", (m) => m.normalize("NFKC"));
	if (enabled["halfwidth-kana"])
		ruleRegexReplace(ctx, /[｡-ﾟ]+/g, "halfwidth-kana", "warning",
			() => "半角カナです。全角にします。", (m) => m.normalize("NFKC"));
	if (enabled["ellipsis"]) {
		ruleRegexReplace(ctx, /\.{3,}|・{2,}|…+/g, "ellipsis", "info",
			(m) => (m[0] === "…" ? "三点リーダーは2つ続けて「……」と書くのが一般的です。" : "三点リーダー「……」を使います。"),
			(m, from) => {
				if (m[0] === "…") return m.length % 2 === 0 ? null : "…".repeat(m.length + 1);
				if (m[0] === "." && !isJa(ctx.masked[from - 1]) && !isJa(ctx.masked[from + m.length])) return null;
				return "……";
			});
	}
	if (enabled["dash"]) {
		ruleRegexReplace(ctx, /―+/g, "dash", "info",
			() => "ダッシュは2つ続けて「――」と書くのが一般的です。",
			(m) => (m.length % 2 === 0 ? null : "―".repeat(m.length + 1)));
		ruleRegexReplace(ctx, /(?<![ァ-ヺー])ー{2,}/g, "dash", "info",
			() => "長音符「ー」がダッシュの代わりに使われています。「――」にします。",
			(m) => "―".repeat(m.length % 2 === 0 ? m.length : m.length + 1));
	}
	if (enabled["space-between-ja"])
		ruleRegexReplace(ctx, new RegExp(`(?<=[${KANA_KANJI}]) +(?=[${KANA_KANJI}])`, "g"), "space-between-ja", "warning",
			() => "日本語の間に半角スペースがあります。", () => "");
}

function rulePunctMix(ctx: Ctx) {
	const ja = (ctx.masked.match(/[、。]/g) ?? []).length;
	const western = (ctx.masked.match(/[，．]/g) ?? []).length;
	if (ja === 0 || western === 0) return;
	const toJa = ja >= western;
	const re = toJa ? /[，．]/g : /[、。]/g;
	const map: Record<string, string> = { "，": "、", "．": "。", "、": "，", "。": "．" };
	ruleRegexReplace(ctx, re, "punct-mix", "info",
		() => `句読点が混在しています。このノートでは「${toJa ? "、。" : "，．"}」が多く使われています。`,
		(m) => map[m]);
}

interface Sentence {
	from: number;
	to: number; // exclusive, includes the terminator
	body: string; // masked text of the sentence
	terminator: string;
}

function splitSentences(masked: string): Sentence[] {
	const out: Sentence[] = [];
	let start = 0;
	let depth = 0; // nesting inside 「」『』（） so 。 inside quotes does not end the outer sentence
	const open = "「『（(";
	const close = "」』）)";
	for (let i = 0; i <= masked.length; i++) {
		const ch = masked[i];
		if (ch !== undefined && open.includes(ch)) depth++;
		else if (ch !== undefined && close.includes(ch)) depth = Math.max(0, depth - 1);
		const isEnd = ch === undefined || ch === "\n" || (depth === 0 && /[。！？!?]/.test(ch));
		if (!isEnd) continue;
		let end = ch === undefined || ch === "\n" ? i : i + 1;
		// absorb repeated terminators like ！？
		while (ch !== "\n" && end < masked.length && /[！？!?]/.test(masked[end])) end++;
		let from = start;
		while (from < end && /[\s　]/.test(masked[from])) from++;
		if (from < end) {
			out.push({
				from,
				to: end,
				body: masked.slice(from, end),
				terminator: ch === undefined || ch === "\n" ? "" : masked.slice(i, end),
			});
		}
		if (ch === "\n") depth = 0;
		const next = ch === undefined || ch === "\n" ? i + 1 : end;
		start = next;
		i = next - 1;
	}
	return out;
}

function proseLength(s: string): number {
	let n = 0;
	for (const ch of s) if (ch !== MASK && !/\s/.test(ch)) n++;
	return n;
}

function ruleSentences(ctx: Ctx) {
	const { enabled, maxSentenceLength, maxCommas, sameEndingRun } = ctx.opts;
	const sentences = splitSentences(ctx.masked).filter((s) => JA_RE.test(s.body) && !s.body.includes("|"));
	for (const s of sentences) {
		if (enabled["long-sentence"]) {
			const len = proseLength(s.body);
			if (len > maxSentenceLength)
				push(ctx, { ruleId: "long-sentence", from: s.from, to: s.to, severity: "info",
					message: `一文が${len}文字あります（上限${maxSentenceLength}文字）。分けると読みやすくなります。` });
		}
		if (enabled["many-commas"]) {
			const commas = (s.body.match(/[、，]/g) ?? []).length;
			if (commas > maxCommas)
				push(ctx, { ruleId: "many-commas", from: s.from, to: s.to, severity: "info",
					message: `一文に読点が${commas}個あります（上限${maxCommas}個）。` });
		}
	}
	if (enabled["same-ending"] && sameEndingRun >= 2) {
		let run: Sentence[] = [];
		let key = "";
		const flush = () => {
			if (run.length >= sameEndingRun) {
				const s = run[run.length - 1];
				const endAt = s.to - 1;
				push(ctx, { ruleId: "same-ending", from: endAt - 1, to: s.to, severity: "info",
					message: `「〜${key}。」で終わる文が${run.length}回続いています。文末に変化をつけると読みやすくなります。` });
			}
			run = [];
		};
		for (let idx = 0; idx < sentences.length; idx++) {
			const s = sentences[idx];
			const prev = sentences[idx - 1];
			const gap = prev ? ctx.masked.slice(prev.to, s.from) : "";
			if (/\n\s*\n/.test(gap) || s.terminator !== "。") {
				flush();
				if (s.terminator !== "。") continue;
			}
			const k = s.body[s.body.length - 2] ?? "";
			if (!isJa(k)) { flush(); continue; }
			if (k !== key) { flush(); key = k; }
			run.push(s);
		}
		flush();
	}
}

function ruleNovel(ctx: Ctx) {
	const { enabled } = ctx.opts;
	if (enabled["space-after-mark"]) {
		for (const m of ctx.masked.matchAll(/[！？!?]+/g)) {
			const from = m.index!;
			const to = from + m[0].length;
			if (/[!?]/.test(m[0][0]) && !isJa(ctx.masked[from - 1])) continue;
			const next = ctx.masked[to];
			if (next === undefined || /[\s　」』）)\]〉》】…―\n]/.test(next) || next === MASK) continue;
			push(ctx, { ruleId: "space-after-mark", from, to, severity: "info",
				message: "（小説作法）文中の「！」「？」の後には全角スペースを入れます。",
				replacement: m[0] + "　" });
		}
	}
	if (enabled["period-before-bracket"]) {
		for (const m of ctx.masked.matchAll(/。(?=[」』])/g)) {
			push(ctx, { ruleId: "period-before-bracket", from: m.index!, to: m.index! + 1, severity: "info",
				message: "（小説作法）閉じかっこの直前の句点は省きます。", replacement: "" });
		}
	}
	if (enabled["indent"]) {
		let offset = 0;
		for (const line of ctx.masked.split("\n")) {
			const first = line[0];
			if (first !== undefined && isJa(first) && !/^[「『（〈《【―…]/.test(line)) {
				push(ctx, { ruleId: "indent", from: offset, to: offset + 1, severity: "info",
					message: "（小説作法）段落の頭は全角スペースで字下げします。",
					replacement: "　" + first });
			}
			offset += line.length + 1;
		}
	}
}

// ---------------------------------------------------------------------------
// Public API

export function check(text: string, options: Partial<CheckOptions> = {}): Issue[] {
	const opts: CheckOptions = {
		...DEFAULT_OPTIONS,
		...options,
		enabled: { ...DEFAULT_OPTIONS.enabled, ...(options.enabled ?? {}) },
	};
	const masked = maskMarkdown(text);
	const ctx: Ctx = { text, masked, opts, out: [] };
	const on = opts.enabled;
	if (on["ra-nuki"]) ruleRaNuki(ctx);
	if (on["double-honorific"]) rulePhrases(ctx, DOUBLE_HONORIFIC, "double-honorific", "warning");
	if (on["redundant"]) rulePhrases(ctx, REDUNDANT, "redundant", "warning");
	if (on["variant"]) ruleVariants(ctx);
	ruleCharForms(ctx);
	if (on["punct-mix"]) rulePunctMix(ctx);
	ruleSentences(ctx);
	ruleNovel(ctx);

	const ignore = opts.ignoreWords.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	let issues = ctx.out;
	if (ignore.length > 0) {
		issues = issues.filter((i) => !ignore.some((w) => overlaps(text, w, i)));
	}
	return issues.sort((a, b) => a.from - b.from || a.to - b.to);
}

function overlaps(text: string, word: string, issue: Issue): boolean {
	let idx = text.indexOf(word, Math.max(0, issue.from - word.length));
	while (idx !== -1 && idx < issue.to) {
		if (idx + word.length > issue.from) return true;
		idx = text.indexOf(word, idx + 1);
	}
	return false;
}

/** Apply every non-overlapping fix. Returns the new text and how many fixes were applied. */
export function applyFixes(text: string, issues: Issue[]): { text: string; applied: number } {
	const chosen = planFixes(issues);
	let out = text;
	for (const i of [...chosen].reverse()) out = out.slice(0, i.from) + i.replacement + out.slice(i.to);
	return { text: out, applied: chosen.length };
}

/** Pick the fixable issues whose ranges do not overlap, in document order. */
export function planFixes(issues: Issue[]): Issue[] {
	const fixable = issues
		.filter((i) => i.replacement !== undefined)
		.sort((a, b) => a.from - b.from || a.to - b.to);
	const chosen: Issue[] = [];
	let lastEnd = -1;
	for (const i of fixable) {
		if (i.from < lastEnd) continue;
		chosen.push(i);
		lastEnd = Math.max(i.to, i.from + 1);
	}
	return chosen;
}
