# 業務ブロックの表示領域契約 v1

ホストが登録した業務ブロック（体験カードの一覧、料金表示、予約導線など）の内側を、スタッフが**見た目だけ**整えられるようにする契約です。どの領域を変えられるかはホストが registry で宣言し、文書には領域ごとの見た目だけを保存します。価格・在庫・販売者・キャンセル条件・予約可否・送信先・決済処理・個人情報は、引き続きホストの API とコードが正本です。

## registry での宣言

```tsx
import type { BlockRegistry } from '@niho/web/react';

const blocks = {
  ExperienceCards: {
    props: {
      heading: { type: 'string', maxLength: 120 },
      ctaLabel: { type: 'string', maxLength: 40 },
    },
    slots: {
      list: { label: 'カードの並び', style: ['display', 'gridTemplateColumns', 'gap'] },
      image: { label: 'カード画像', style: ['objectFit', 'borderRadius', 'height'] },
      title: { label: 'カードの見出し', style: ['color', 'fontSize', 'fontWeight'] },
      price: {
        label: '料金表示', style: ['color', 'fontSize'],
        data: { reason: '体験ごとの料金を表示します。', source: 'NIHO の体験データ' },
      },
      cta: { label: '予約ボタン', style: ['color', 'backgroundColor', 'borderRadius', 'padding'], text: 'ctaLabel' },
      checkout: { label: '決済', data: { reason: '決済はホストの予約画面で処理します。', source: 'NIHO の予約・決済' } },
    },
    component: ({ heading, ctaLabel }) => (
      <section>
        <h2>{heading}</h2>
        <ul data-nw-slot="list">{experiences.map((experience) => (
          <li key={experience.slug}>
            <img data-nw-slot="image" src={experience.image} alt="" />
            <h3 data-nw-slot="title">{experience.title}</h3>
            <span data-nw-slot="price">{formatPrice(experience.price)}</span>
            <a data-nw-slot="cta" href={`/experiences/${experience.slug}/book`}>{ctaLabel ?? '予約する'}</a>
          </li>
        ))}</ul>
      </section>
    ),
  },
} satisfies BlockRegistry;
```

| 項目 | 内容 |
| --- | --- |
| `label` | スタッフに見せる領域名。200文字以内、空白だけは不可 |
| `style` | この領域で変更できる見た目のプロパティ。値の検証は文書の style と同じ。省略・空なら見た目も変更できない |
| `text` | 領域の文字を変える表示用の `string` prop（例: 予約ボタンのラベル）。値の正本は props のまま |
| `data` | 値がホストのデータから来る場合の理由と正本。エディターはこの領域を「値は変更できない」と示す |

- slot 名は ID と同じ規則（英字開始、英数字・`_`・`-`、最大80文字）で、`constructor` 等の予約名は使えません。宣言の形が不正なブロックを使う文書は `invalid block slot contract` で拒否します。
- ブロックは、領域にあたる内側の要素へ `data-nw-slot="<名前>"` を付けます。同じ名前を複数の要素に付けると、すべてに同じ見た目が適用されます。一覧のカードを繰り返す場合も、デザインの定義は1つです。
- 値（料金・在庫・リンク先・予約可否）は props に含めず、ブロックがホストのデータから描画します。`text` で変えられるのは表示用の文字だけです。

## 文書

```json
{
  "type": "component", "id": "cards", "block": "ExperienceCards",
  "props": { "heading": "人気の体験", "ctaLabel": "予約する" },
  "slots": {
    "title": { "base": { "color": { "token": "accent" }, "fontSize": 18 } },
    "list": { "responsive": [{ "minWidth": 768, "declarations": { "gridTemplateColumns": "repeat(3, minmax(0, 1fr))" } }] }
  }
}
```

- `slots` は宣言された領域だけを持てます。各領域は通常の `style` と同じ `base` / `responsive` の形で、tokens も使えます。
- 宣言にない領域、その領域で許可されていないプロパティ、`style` を宣言していない領域（`checkout` 等）への指定を拒否します。値の形式や上限は文書の style と同じです。
- 検証は `parsePageDocument`・`generatePageCss`・`PageRenderer`・`renderPageToHtml` のすべてで同じ registry を使います。公開 SSR もエディターと同じ契約で描画し、無効な文書は途中まで描画しません。ホストの保存 API も同じ registry で検証してください。
- 共通部品の中に置いた業務ブロックも同じ規則です。展開後は `<インスタンスID>--<部品内ID>` のノードとして CSS を生成します。

## CSS と表示の優先順位

領域の CSS は文書の scope の下に、ノード単位で生成します。

```css
[data-nw-scope="…"] [data-nw-owner="…"][data-nw-node="cards"] [data-nw-slot="title"]{color:var(--nw-accent);font-size:18px;}
```

- 属性 selector を3つ重ねるため、ブロックの class による既定の見た目より優先されます。ブロックが `style` 属性（インライン）で指定したプロパティは上書きできないため、スタッフに変えさせるプロパティは class で指定してください。
- ブロックの中に別の niho-web 文書を描画する場合、その文書の `data-nw-slot` にも同じ規則が当たります。業務ブロックの中で文書を入れ子にしないでください。

## 互換性

- `BlockContract.slots` と `ComponentNode.slots` は任意です。slots を宣言していない registry・slots を持たない文書の検証と描画は変わりません。
- `schemaVersion` は 1 のままです。slots を持つ文書を古い版の renderer に渡すと `unknown field` で止まり、途中までを公開しません。
