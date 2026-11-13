import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFixes, check, maskMarkdown, MASK, parseCustomVariants, RULES } from "../src/rules.ts";
import type { RuleId } from "../src/rules.ts";

const only = (id: RuleId, extra: Record<string, unknown> = {}) => ({
	enabled: Object.fromEntries(RULES.map((r) => [r.id, r.id === id])),
	...extra,
});
const ids = (text: string, id: RuleId, extra = {}) => check(text, only(id, extra));
const fix = (text: string, id: RuleId, extra = {}) => applyFixes(text, ids(text, id, extra)).text;

test("mask keeps length and newlines", () => {
	const src = "---\ntitle: 見れる\n---\n本文 `見れる` [[a|見れる]] ![x](http://e.com/見れる)\n```\n見れる\n```\n";
	const m = maskMarkdown(src);
	assert.equal(m.length, src.length);
	assert.equal(m.split("\n").length, src.split("\n").length);
	assert.ok(m.includes("本文"));
	// only the wikilink alias survives
	assert.equal((m.match(/見れる/g) ?? []).length, 1);
	assert.ok(m.includes(MASK));
});

test("ra-nuki is detected and fixed", () => {
	assert.equal(fix("映画が見れる。明日は来れない。", "ra-nuki"), "映画が見られる。明日は来られない。");
	assert.equal(fix("それを食べれた", "ra-nuki"), "それを食べられた");
	// not ra-nuki
	assert.equal(ids("見れば分かる。出来れば行く。入れる。", "ra-nuki").length, 0);
	assert.equal(ids("意見れ", "ra-nuki").length, 0);
});

test("ra-nuki is ignored in code", () => {
	assert.equal(ids("`見れる` と\n```\n来れる\n```\n~~~js\n寝れる", "ra-nuki").length, 0);
});

test("double honorifics", () => {
	assert.equal(ids("先生がおっしゃられた。", "double-honorific").length, 1);
	assert.equal(ids("社長がご覧になられました。", "double-honorific").length, 1);
	assert.equal(ids("社長がご覧になりました。", "double-honorific").length, 0);
});

test("redundant phrases", () => {
	assert.equal(fix("まず最初に頭痛が痛いと言った。", "redundant"), "最初に頭が痛いと言った。");
	const i = ids("違和感を感じる", "redundant");
	assert.equal(i.length, 1);
	assert.equal(i[0].replacement, undefined);
});

test("variants flag the minority form", () => {
	const text = "ご確認ください。お待ちください。少々お待ち下さい。";
	const i = ids(text, "variant");
	assert.equal(i.length, 1);
	assert.equal(text.slice(i[0].from, i[0].to), "下さい");
	assert.equal(applyFixes(text, i).text, "ご確認ください。お待ちください。少々お待ちください。");
});

test("variants keep conjugated forms parallel", () => {
	assert.equal(fix("できる。できない。出来た。", "variant"), "できる。できない。できた。");
});

test("katakana variants respect word boundary", () => {
	assert.equal(ids("ユーザビリティとユーザー", "variant").length, 0);
	assert.equal(fix("ユーザーとユーザーとユーザ", "variant"), "ユーザーとユーザーとユーザー");
});

test("no variant issue when only one form is used", () => {
	assert.equal(ids("サーバーとサーバー", "variant").length, 0);
});

test("custom variants", () => {
	assert.deepEqual(parseCustomVariants("メール/Eメール\n\n単独"), [[["メール"], ["Eメール"]]]);
	const i = ids("Eメールとメールとメール", "variant", { customVariants: "メール/Eメール" });
	assert.ok(i.some((x) => x.replacement === "メール"));
});

test("full-width alnum and half-width kana", () => {
	assert.equal(fix("ＡＢＣ１２３です", "fullwidth-alnum"), "ABC123です");
	assert.equal(fix("ｶﾞｷﾞです", "halfwidth-kana"), "ガギです");
});

test("ellipsis", () => {
	assert.equal(fix("えっと...そうだね・・・ふむ…", "ellipsis"), "えっと……そうだね……ふむ……");
	assert.equal(ids("Wait... what", "ellipsis").length, 0);
	assert.equal(ids("そう……", "ellipsis").length, 0);
});

test("dash", () => {
	assert.equal(fix("それは―つまり", "dash"), "それは――つまり");
	assert.equal(fix("それはーーつまり", "dash"), "それは――つまり");
	assert.equal(ids("コーヒー", "dash").length, 0);
});

test("punctuation mix", () => {
	assert.equal(fix("これは、ペンです。あれは，本です．", "punct-mix"), "これは、ペンです。あれは、本です。");
	assert.equal(ids("これは、ペンです。", "punct-mix").length, 0);
});

test("space between Japanese", () => {
	assert.equal(fix("日本 語の文", "space-between-ja"), "日本語の文");
	assert.equal(ids("日本 Japan 語", "space-between-ja").length, 0);
	assert.equal(ids("日本 `x` 語", "space-between-ja").length, 0);
});

test("long sentence and commas", () => {
	const long = "あ".repeat(120) + "。";
	assert.equal(ids(long, "long-sentence").length, 1);
	assert.equal(ids(long, "long-sentence", { maxSentenceLength: 200 }).length, 0);
	assert.equal(ids("a、b、c、d、e、fです。", "many-commas").length, 1);
	assert.equal(ids("a、b、cです。", "many-commas").length, 0);
});

test("sentences inside quotes are not split", () => {
	const s = "彼は「そうだ。違う。」と言った。";
	assert.equal(ids(s, "long-sentence", { maxSentenceLength: 10 }).length, 1);
});

test("same sentence ending run", () => {
	const t = "朝が来た。顔を洗った。飯を食べた。外に出た。";
	const i = ids(t, "same-ending");
	assert.equal(i.length, 1);
	assert.match(i[0].message, /4回/);
	assert.equal(ids("朝が来た。顔を洗った。飯を食べる。外に出た。", "same-ending").length, 0);
	// a blank line resets the run
	assert.equal(ids("来た。洗った。\n\n食べた。出た。", "same-ending").length, 0);
});

test("novel rules", () => {
	assert.equal(fix("えっ！本当？うん", "space-after-mark"), "えっ！　本当？　うん");
	assert.equal(ids("えっ！」", "space-after-mark").length, 0);
	assert.equal(ids("Hi! there", "space-after-mark").length, 0);
	assert.equal(fix("「はい。」", "period-before-bracket"), "「はい」");
	assert.equal(fix("地の文です。\n「台詞」\n　字下げ済み\n# 見出し", "indent"), "　地の文です。\n「台詞」\n　字下げ済み\n# 見出し");
});

test("novel rules are off by default", () => {
	const all = check("「はい。」えっ！本当");
	assert.ok(!all.some((i) => ["space-after-mark", "period-before-bracket", "indent"].includes(i.ruleId)));
});

test("ignore words", () => {
	assert.equal(ids("見れる", "ra-nuki", { ignoreWords: "見れる" }).length, 0);
	assert.equal(ids("見れる", "ra-nuki", { ignoreWords: "無関係" }).length, 1);
});

test("overlapping fixes are applied once", () => {
	const text = "ｱｲｳ・・・";
	const r = applyFixes(text, check(text));
	assert.equal(r.text, "アイウ……");
});

test("ruby readings are not checked", () => {
	assert.equal(ids("漢字《ｶﾝｼﾞ》", "halfwidth-kana").length, 0);
	assert.equal(ids("{漢字|ｶﾝｼﾞ}", "halfwidth-kana").length, 0);
});

test("plain clean text has no issues", () => {
	assert.deepEqual(check("今日はいい天気です。散歩に行きました。"), []);
});
