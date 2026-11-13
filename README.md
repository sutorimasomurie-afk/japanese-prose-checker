# Japanese Prose Checker

Check Japanese writing inside Obsidian — while you type, fully offline.

Japanese Prose Checker underlines common problems in Japanese text and lists them in a side panel. Many of them can be fixed with one click, or all at once.

## What it checks

| Rule | Example | Auto-fix |
| --- | --- | --- |
| ら抜き言葉 (*ra*-dropping) | 見れる → 見られる | ✓ |
| 二重敬語 (double honorifics) | おっしゃられる, ご覧になられる | – |
| 重複表現 (redundant phrases) | 頭痛が痛い → 頭が痛い, 一番最初 → 最初 | ✓ (most) |
| 表記ゆれ (inconsistent spelling within a note) | 下さい / ください, サーバ / サーバー — the less frequent form is flagged | ✓ |
| Full-width letters and digits | ＡＢＣ１２３ → ABC123 | ✓ |
| Half-width katakana | ｶﾀｶﾅ → カタカナ | ✓ |
| Ellipsis | `...`, `・・・`, `…` → `……` | ✓ |
| Dash | `―`, `ーー` → `――` | ✓ |
| Mixed punctuation | 、。 mixed with ，． | ✓ |
| Spaces between Japanese characters | 日本 語 → 日本語 | ✓ |
| Long sentences | more than 100 characters (configurable) | – |
| Too many commas in a sentence | more than 4 読点 (configurable) | – |
| Repetitive sentence endings | 〜た。〜た。〜た。〜た。 (configurable) | – |

**Fiction-manuscript rules** (off by default, one switch turns them all on):

| Rule | Example | Auto-fix |
| --- | --- | --- |
| Full-width space after ！ and ？ | えっ！本当 → えっ！　本当 | ✓ |
| No 。 before a closing bracket | 「はい。」 → 「はい」 | ✓ |
| Paragraph indentation | 地の文 → 　地の文 | ✓ |

The checker ignores front matter, code blocks, inline code, math, comments, HTML, link targets, URLs, tags, and ruby readings such as `漢字《かんじ》` and `{漢字|かんじ}`. That means it works alongside furigana and vertical-writing plugins.

## How to use

- Problems are underlined in the editor. Hover over one to read the explanation.
- Click the status bar item (`日本語チェック N件`), or run **Japanese Prose Checker: 問題の一覧を開く** to open the issues panel. Click an issue to jump to it. Click **修正** to fix one, or **すべて自動修正** to fix every auto-fixable issue in the note.
- Run **このノートの自動修正できる問題をすべて直す** to fix the current note from the command palette. It's a single undo step.
- To skip a note, add `prose-check: false` to its properties.
- In the settings you can turn rules on or off, change thresholds, add your own spelling-variant groups (for example `メール/Eメール`), and list words to ignore.

## Privacy

- Everything runs locally. The plugin makes no network requests, collects no telemetry and has no ads.
- It reads only the note open in the editor. It never accesses files outside your vault.

## Development

```bash
npm install
npm run build   # type-check + bundle to main.js
npm test        # unit tests (rules) + smoke test of the built main.js
```

Requires Node.js 22.18 or later, because the tests run TypeScript directly through Node's type stripping.

## License

MIT

---

## 日本語での使い方

日本語の文章をオフラインでチェックするプラグインです。ら抜き言葉、表記ゆれ、重複表現、約物（……・――）、句読点の混在、長すぎる文、Web 小説の作法などを見つけます。

- 問題のある箇所にエディタ上で波線が付きます。マウスを乗せると説明が出ます。
- ステータスバーの「日本語チェック N件」をクリックすると、問題の一覧パネルが開きます。項目をクリックするとその場所へ移動し、「修正」で1件ずつ、「すべて自動修正」でまとめて直せます。
- コマンドパレットの「このノートの自動修正できる問題をすべて直す」は、1回の取り消し（Ctrl/Cmd+Z）で元に戻せます。
- 小説作法のルール（！？の後の全角スペース、閉じかっこ前の句点、段落頭の字下げ）は初期状態でオフです。設定画面の「すべてオン」でまとめて有効にできます。
- 独自の表記ゆれ（例：`メール/Eメール`）や無視する語を設定画面で追加できます。
- チェックしたくないノートは、プロパティに `prose-check: false` を書きます。
- コードブロック・数式・リンク先・URL・タグ・ルビの読み（`漢字《かんじ》`、`{漢字|かんじ}`）はチェックしません。ふりがな・縦書き系プラグインと一緒に使えます。
- 通信は一切しません。テレメトリも広告もありません。
