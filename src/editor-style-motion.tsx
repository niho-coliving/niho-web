"use client";

import { useId, useState } from "react";
import { AlignGrid, ColorField, NumberField, PercentField, Row, Segmented, SelectField, Toggle, UnitField, type Align, type Choice, type ColorChoice, type Pending, type RowStatus } from "./editor-fields.js";
import type { EditorOperation, NodePath } from "./editor-model.js";
import { hiddenTiers, rangesForTiers, resolveValue, tierName, type EditorTier } from "./style-model.js";
import type { Appear, AppearEffect, ComponentNode, ElementNode, InstanceNode, PageDocument, StateName, StateProperty, StyleProperty, StyleValue } from "./types.js";

/** 通常の見た目か、編集中の状態（ホバー・フォーカス・押下中）。 */
export type StyleState = "normal" | StateName;
type Values = Partial<Record<StyleProperty, StyleValue | undefined>>;
type Permission = StyleProperty | "states" | "appear" | "hidden";
export type MotionProps = {
  document: PageDocument; node: ElementNode | ComponentNode | InstanceNode; saved: ElementNode | ComponentNode | InstanceNode | undefined; path: NodePath; tiers: readonly EditorTier[];
  state: StyleState; setState: (state: StyleState) => void;
  apply: (operation: EditorOperation) => string | undefined; preview: (operation: EditorOperation | null) => void; pending: Pending; fieldKey: string; disabled: boolean;
  reason: (field: string) => string | undefined; notify: (message: string) => void; can: (permission: Permission) => boolean; colorTokens: readonly ColorChoice[];
  /** 通常の見た目（選択中の段）への書き込み。 */
  tier: { key: string; get: (property: StyleProperty) => StyleValue | undefined; set: (values: Values) => string | undefined; preview: (values: Values | null) => void;
    status: (property: StyleProperty) => RowStatus; lock: (property: StyleProperty) => string | undefined; effective: (property: StyleProperty) => string | number | undefined };
};
export const stateLabels: Record<StyleState, string> = { normal: "通常", hover: "ホバー", focus: "フォーカス", active: "押下中" };
const during: Record<StateName, string> = { hover: "ホバー中", focus: "フォーカス中", active: "押下中" };
const easings: Choice[] = [["ease", "なめらか"], ["ease-in", "ゆっくり始まる"], ["ease-out", "ゆっくり終わる"], ["ease-in-out", "ゆっくり始まりゆっくり終わる"], ["linear", "一定"]];
// fade-left は左へ動く（右から入る）。fade-up が上へ動く（下から入る）のと同じ向きの決め方。
const effects: Choice[] = [["fade", "ふわっと表示"], ["fade-up", "下から"], ["fade-down", "上から"], ["fade-right", "左から"], ["fade-left", "右から"], ["zoom", "拡大"]];
const seconds = { read: (value: string | number) => typeof value === "number" ? value / 1000 : /ms$/.test(value) ? parseFloat(value) / 1000 : parseFloat(value), write: (amount: number) => Math.round(amount * 1000) };
const degrees = { read: (value: string | number) => parseFloat(String(value)), write: (amount: number) => amount };
const percent = { read: (value: string | number) => parseFloat(String(value).split(" ")[0]!) * 100, write: (amount: number) => Number((amount / 100).toFixed(4)) };
const pixels = (part: string): string | number => /^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(part) ? parseFloat(part) : part === "0" ? 0 : part;
function translateParts(value: string | number | undefined): [StyleValue | undefined, StyleValue | undefined] {
  if (value === undefined || typeof value === "number") return [value, undefined];
  const [x, y] = value.split(" ");
  return [pixels(x!), y === undefined ? undefined : pixels(y)];
}
function translateValue(x: StyleValue | undefined, y: StyleValue | undefined): StyleValue | undefined {
  const css = (value: StyleValue | undefined) => value === undefined ? "0" : typeof value === "number" ? `${value}px` : typeof value === "object" ? "0" : value;
  if (x === undefined && y === undefined) return undefined;
  return y === undefined || y === 0 || y === "0" ? x ?? 0 : `${css(x)} ${css(y)}`;
}
const axis = { start: "left", center: "center", end: "right" } as const, rows = { start: "top", center: "center", end: "bottom" } as const;
const origin = (x: Align, y: Align) => x === "center" && y === "center" ? "center" : `${axis[x]} ${rows[y]}`;
function originAlign(value: unknown): [Align, Align] | undefined {
  if (typeof value !== "string") return undefined;
  const [h, v = "center"] = value === "center" ? ["center", "center"] : value.split(" ");
  const x = (Object.entries(axis).find(([, name]) => name === h)?.[0]), y = Object.entries(rows).find(([, name]) => name === v)?.[0];
  return x && y ? [x as Align, y as Align] : undefined;
}

type TransformProps = { prefix: string; disabled: boolean; get: (property: StateProperty) => StyleValue | undefined; resolve: (value: StyleValue | undefined) => string | number | undefined;
  set: (values: Values) => string | undefined; preview: (values: Values | null) => void; status: (property: StyleProperty) => RowStatus; pending: Pending };
/** 移動・回転・拡大。通常の見た目（段ごと）と状態の見た目で共通。 */
function TransformFields({ prefix, disabled, get, resolve, set, preview, status, pending }: TransformProps) {
  const [x, y] = translateParts(resolve(get("translate"))), statusX = status("translate"), lengths = ["px", "%", "rem"];
  return <>
    <div className="e-grid2">
      <UnitField key={`${prefix}-tx`} caption="移動 X" value={x} units={lengths} apply={(value) => set({ translate: translateValue(value, y) })} preview={(value) => preview(value === null ? null : { translate: translateValue(value, y) })}
        pending={pending} fieldKey={`${prefix}-tx`} disabled={disabled} status={statusX} placeholder="0" />
      <UnitField key={`${prefix}-ty`} caption="移動 Y" value={y} units={lengths} apply={(value) => set({ translate: translateValue(x, value) })} preview={(value) => preview(value === null ? null : { translate: translateValue(x, value) })}
        pending={pending} fieldKey={`${prefix}-ty`} disabled={disabled} status={{ ...statusX, reset: undefined }} placeholder="0" />
    </div>
    <div className="e-grid2">
      <NumberField key={`${prefix}-rotate`} caption="回転" suffix="°" {...degrees} min={-360} max={360} value={get("rotate")} apply={(value) => set({ rotate: value })} preview={(value) => preview(value === null ? null : { rotate: value })}
        pending={pending} fieldKey={`${prefix}-rotate`} disabled={disabled} status={status("rotate")} placeholder="0" />
      <NumberField key={`${prefix}-scale`} caption="拡大・縮小" suffix="%" {...percent} min={0} max={500} value={get("scale")} apply={(value) => set({ scale: value })} preview={(value) => preview(value === null ? null : { scale: value })}
        pending={pending} fieldKey={`${prefix}-scale`} disabled={disabled} status={status("scale")} placeholder="100" />
    </div>
  </>;
}

/** インスペクタの「演出」。状態・変形・動き・登場・表示する幅。公開ページでは JS なしで動き、動きを減らす設定では動かない。 */
export function MotionFields(props: MotionProps) {
  const { document, node, saved, path, tiers, state, apply, pending, fieldKey, disabled, reason, notify, can, tier } = props;
  const [mirror, setMirror] = useState(true), legend = useId();
  const report = (error: string | undefined) => { if (error) notify(error); };
  const states = node.style?.states ?? {}, hasStates = Object.values(states).some((values) => Object.keys(values ?? {}).length);
  const stateLock = reason("style.states");
  const segment = can("states") && <Row caption="状態" group status={{}}>
    <Segmented label="編集する状態" value={state} disabled={disabled} onChange={props.setState} options={(["normal", "hover", "focus", "active"] as const).map((value) => ({ value, text: stateLabels[value] }))} />
  </Row>;
  if (state !== "normal") {
    const values = states[state] ?? {}, savedValues = saved?.style?.states?.[state] ?? {};
    const mirrored = state === "hover" && (!Object.keys(values).length || JSON.stringify(values) === JSON.stringify(states.focus ?? {}));
    const operation = (next: Values): EditorOperation => ({ type: "state", path, state, values: next, ...(mirrored && mirror ? { also: ["focus"] as const } : {}) });
    const set = (next: Values) => apply(operation(next)), preview = (next: Values | null) => props.preview(next === null ? null : operation(next));
    const status = (property: StyleProperty): RowStatus => {
      const own = (values as Values)[property];
      return { own: own !== undefined, reset: () => report(set({ [property]: undefined })), lock: stateLock, unsaved: JSON.stringify((savedValues as Values)[property]) !== JSON.stringify(own),
        ...(own === undefined ? { inherited: "通常と同じ", inheritedTitle: "通常の見た目のまま変えません" } : {}) };
    };
    const key = (property: string) => `${fieldKey}-state-${state}-${property}`, locked = disabled || !!stateLock;
    const color = (property: StateProperty, caption: string) => {
      const normal = tier.effective(property);
      return <ColorField key={key(property)} caption={caption} value={values[property]} tokens={props.colorTokens} inherited={typeof normal === "string" ? normal : undefined} apply={(next) => set({ [property]: next })}
        preview={(next) => preview(next === null ? null : { [property]: next })} pending={pending} fieldKey={key(property)} disabled={locked} status={status(property)} />;
    };
    const underline = values.textDecorationLine === "underline";
    return <>
      {segment}
      <p className="e-help e-state-note">{during[state]}に変える見た目だけを表示しています。すべての幅に適用します。</p>
      {mirrored && <label className="e-check"><input type="checkbox" checked={mirror} disabled={locked} onChange={(event) => setMirror(event.target.checked)} />キーボードのフォーカス時も同じ見た目にする</label>}
      {color("color", "文字色")}{color("backgroundColor", "背景色")}{color("borderColor", "枠線の色")}
      <PercentField key={key("opacity")} caption="不透明度" value={values.opacity} apply={(next) => set({ opacity: next })} preview={(next) => preview(next === null ? null : { opacity: next })} pending={pending} fieldKey={key("opacity")} disabled={locked} status={status("opacity")} placeholder="100" />
      <div className="e-actions"><Toggle text="下線" icon="U" pressed={underline} disabled={locked} onChange={() => report(set({ textDecorationLine: underline ? undefined : "underline" }))} /></div>
      <TransformFields prefix={key("transform")} disabled={locked} get={(property) => values[property]} resolve={(value) => resolveValue(document, value)} set={set} preview={preview} status={status} pending={pending} />
    </>;
  }
  const appear = node.style?.appear, appearLock = reason("style.appear"), appearOff = disabled || !!appearLock;
  const setAppear = (next: Appear | undefined) => apply({ type: "appear", path, value: next });
  const hiddenKeys = hiddenTiers(node, tiers), hiddenLock = reason("style.hidden");
  const aligned = JSON.stringify(rangesForTiers(tiers, hiddenKeys)) === JSON.stringify(node.style?.hidden ?? []);
  const transforms = (["translate", "rotate", "scale", "transformOrigin"] as const).some(can), motion = (["transitionDuration", "transitionDelay", "transitionTimingFunction"] as const).some(can);
  const motionReason = hasStates ? undefined : "ホバー・フォーカス・押下中の見た目を作ると使えます。";
  const secondsHint = (property: StyleProperty) => { const value = tier.effective(property); return value === undefined ? undefined : String(Number(seconds.read(value)!.toFixed(2))); };
  return <>
    {segment}
    {transforms && <><h4>変形</h4>
      <TransformFields prefix={`${fieldKey}-${tier.key}-transform`} disabled={disabled || !!tier.lock("translate")} get={tier.get} resolve={(value) => resolveValue(document, value)} set={tier.set} preview={tier.preview} status={tier.status} pending={pending} />
      {can("transformOrigin") && <Row caption="変形の原点" group status={tier.status("transformOrigin")}><AlignGrid label="変形の原点" value={originAlign(tier.effective("transformOrigin"))} disabled={disabled || !!tier.lock("transformOrigin")}
        onChange={(x, y) => report(tier.set({ transformOrigin: origin(x, y) }))} /></Row>}</>}
    {motion && <><h4>動き</h4>
      <div className="e-grid2">
        <NumberField key={`${fieldKey}-${tier.key}-duration`} caption="変化の時間" suffix="秒" {...seconds} min={0} max={5} value={tier.get("transitionDuration")} apply={(value) => tier.set({ transitionDuration: value })}
          pending={pending} fieldKey={`${fieldKey}-${tier.key}-duration`} disabled={disabled || !hasStates || !!tier.lock("transitionDuration")} status={tier.status("transitionDuration")} placeholder={secondsHint("transitionDuration") ?? "0"} />
        <NumberField key={`${fieldKey}-${tier.key}-delay`} caption="遅れ" suffix="秒" {...seconds} min={0} max={5} value={tier.get("transitionDelay")} apply={(value) => tier.set({ transitionDelay: value })}
          pending={pending} fieldKey={`${fieldKey}-${tier.key}-delay`} disabled={disabled || !hasStates || !!tier.lock("transitionDelay")} status={tier.status("transitionDelay")} placeholder={secondsHint("transitionDelay") ?? "0"} />
      </div>
      <SelectField key={`${fieldKey}-${tier.key}-easing`} caption="動き方" value={typeof tier.get("transitionTimingFunction") === "string" ? String(tier.get("transitionTimingFunction")) : undefined} options={easings}
        apply={(value) => tier.set({ transitionTimingFunction: value })} disabled={disabled || !hasStates || !!tier.lock("transitionTimingFunction")} status={tier.status("transitionTimingFunction")} />
      {motionReason && <small className="e-help">{motionReason}</small>}</>}
    {can("appear") && <><h4>登場</h4>
      <SelectField key={`${fieldKey}-appear-effect`} caption="登場の効果" empty="なし" value={appear?.effect} options={effects} disabled={appearOff} status={{ lock: appearLock }}
        apply={(value) => setAppear(typeof value === "string" ? { ...(appear ?? { trigger: "load", duration: 600, delay: 0 }), effect: value as AppearEffect } : undefined)} />
      {appear && <>
        <Row caption="きっかけ" group status={{}}><Segmented label="登場のきっかけ" value={appear.trigger} disabled={appearOff} onChange={(trigger) => report(setAppear({ ...appear, trigger }))}
          options={[{ value: "load", text: "ページを開いたとき" }, { value: "view", text: "画面に入ったとき" }] as const} /></Row>
        {appear.trigger === "view" && <small className="e-help">画面に入ったときはスクロール量に合わせて動きます。時間と遅れは使いません。</small>}
        <div className="e-grid2">
          <NumberField key={`${fieldKey}-appear-duration`} caption="登場の時間" suffix="秒" {...seconds} min={0.1} max={3} value={appear.duration} disabled={appearOff || appear.trigger === "view"} pending={pending} fieldKey={`${fieldKey}-appear-duration`}
            apply={(value) => typeof value === "number" ? setAppear({ ...appear, duration: value }) : "0.1〜3 の数値で入力してください。"} />
          <NumberField key={`${fieldKey}-appear-delay`} caption="登場の遅れ" suffix="秒" {...seconds} min={0} max={3} value={appear.delay} disabled={appearOff || appear.trigger === "view"} pending={pending} fieldKey={`${fieldKey}-appear-delay`}
            apply={(value) => typeof value === "number" ? setAppear({ ...appear, delay: value }) : "0〜3 の数値で入力してください。"} />
        </div>
        <SelectField key={`${fieldKey}-appear-easing`} caption="登場の動き方" value={appear.easing} options={easings} disabled={appearOff}
          apply={(value) => { const { easing: _easing, ...rest } = appear; return setAppear(typeof value === "string" ? { ...rest, easing: value as Appear["easing"] & string } : rest); }} />
      </>}
      <small className="e-help">動きを減らす設定の利用者には動きなしで表示します。</small></>}
    {can("hidden") && <fieldset className="e-widths" aria-labelledby={legend} disabled={disabled || !!hiddenLock}><span className="e-cap-text" id={legend}>表示する幅</span>
      {tiers.map((entry) => <label className="e-check" key={String(entry.key)}><input type="checkbox" checked={!hiddenKeys.includes(entry.key)} onChange={(event) => {
        const next = event.target.checked ? hiddenKeys.filter((key) => key !== entry.key) : [...hiddenKeys, entry.key];
        if (next.length === tiers.length) { notify("どこかの幅では表示してください。"); return; }
        report(apply({ type: "hidden", path, ranges: rangesForTiers(tiers, next) }));
      }} />{tierName(entry)}</label>)}
      {!aligned && <small className="e-help">段とそろっていない範囲があります。切り替えると段ごとの指定に置き換えます。</small>}
      {hiddenLock && <small className="e-help">ロック: {hiddenLock}</small>}
    </fieldset>}
  </>;
}
