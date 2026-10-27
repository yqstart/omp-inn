import { useEffect, useId, useRef } from "react";
import { Loader } from "reicon-react";
import { useText } from "../../lib/useText";
import { EnumSelect } from "./EnumSelect";
import {
 apiOptionsFor,
 isDuplicateProviderId,
 isValidProviderId,
 isValidBaseUrl,
 providerFormComplete,
 type CustomProviderForm,
} from "../../lib/customModels";

/** 接口类型的触发按钮：表单字段形态（全宽、与旁边的输入框同高、等宽字体）。 */
const API_TRIGGER_CLASS =
 "flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] transition-colors duration-100 hover:bg-hover disabled:opacity-60";

/** 接口类型的列表项：与触发按钮同字体（wire API 名是等宽字，读起来才分得清）。 */
const API_ITEM_CLASS =
 "block w-full cursor-pointer truncate rounded px-2 py-1 text-left font-mono text-[12px] transition-colors duration-100 hover:bg-hover";

/**
 * 自定义供应商的配置表单（`models.yml` 的新建 / 编辑共用）——「添加供应商」弹窗里选「自定义」
 * 后的内容（V12c 起是弹窗，标题由弹窗给，这里不再自带标题）。
 *
 * **只做供应商配置**（2026-10-17 拆分）：名称 / 接口地址 / 接口类型 / API Key。
 * 模型清单不在这里编辑——保存后到「已配置」的供应商行上点「挑选模型」，用「获取可用模型」
 * 从端点拉候选、勾选后逐项调参（见 `CustomProviderModelsDialog.tsx`）。
 * 这样做的理由：手工敲模型 id 既容易写错，也拿不到端点真实提供的清单。
 *
 * 表单只改本地态，保存时交给 `lib/customModels.ts` 的保真编辑（注释与界面之外的字段原样保留，
 * 含已有的 `models` 列表），再由后端预校验 / 备份 / 原子写。
 *
 * 口径：**名称可改**（`form.originalId` 记录原键名，保存时就地改名）；**接口类型三档**
 * （openai-completions / openai-responses / anthropic-messages，既有文件里的其它值原样列出），
 * 形态是**浮层下拉**（`EnumSelect`，与设置页的枚举项同一套定位与开合），不做行内展开；
 * **认证只有 API Key** 一种（Key 常驻输入框；留空 = 该端点无需鉴权，落盘为 `auth: none`）。
 */
export function CustomProviderEditForm({
 form,
 busy,
 error,
 existingIds,
 onChange,
 onCancel,
 onSave,
}: {
 form: CustomProviderForm;
 busy: boolean;
 error: string | null;
 existingIds: string[];
 onChange: (form: CustomProviderForm) => void;
 onCancel: () => void;
 onSave: () => void;
}) {
 const t = useText();
 const fieldId = useId();
 const errorRef = useRef<HTMLParagraphElement>(null);
 useEffect(() => {
  if (error) errorRef.current?.focus();
 }, [error]);
 const idTrim = form.id.trim();
 /** 名称格式错（空串 = 还没填，归入「必填项没填完」）：给专门提示，不然用户只看到笼统的「没填完」。 */
 const invalidId = idTrim !== "" && !isValidProviderId(idTrim);
 const dupId = isDuplicateProviderId(form, existingIds);
 const invalidUrl = form.baseUrl.trim() !== "" && !isValidBaseUrl(form.baseUrl);
 const complete = providerFormComplete(form) && !dupId;
 const hint = invalidId ? t.customFormIdInvalid : dupId ? t.customFormDupId : invalidUrl ? t.customFormBaseUrlInvalid : t.customFormIncomplete;

 const inputCls =
  "min-w-0 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] transition-colors duration-100 focus:border-accent aria-invalid:border-danger disabled:opacity-60";

 return (
  <fieldset disabled={busy} aria-busy={busy} className="min-w-0">
   <div className="grid min-w-0 gap-4 sm:grid-cols-2">
    <label className="flex min-w-0 flex-col gap-2 text-[13px]">
     <span className="shrink-0 text-muted">{t.customFormName}</span>
     <input
      value={form.id}
      onChange={(e) => onChange({ ...form, id: e.target.value })}
      placeholder="my-gateway"
      title={t.customFormNameHint}
      aria-invalid={invalidId || dupId}
      aria-describedby={invalidId || dupId ? `${fieldId}-name-error` : undefined}
      className={`${inputCls} font-mono`}
     />
     {(invalidId || dupId) && <span id={`${fieldId}-name-error`} className="text-xs text-danger">{invalidId ? t.customFormIdInvalid : t.customFormDupId}</span>}
    </label>
    <label className="flex min-w-0 flex-col gap-2 text-[13px]">
     <span className="shrink-0 text-muted">{t.customFormBaseUrl}</span>
     <input
      value={form.baseUrl}
      onChange={(e) => onChange({ ...form, baseUrl: e.target.value })}
      placeholder="https://gw.example.com/v1"
      aria-invalid={invalidUrl}
      aria-describedby={invalidUrl ? `${fieldId}-url-error` : undefined}
      className={`${inputCls} font-mono`}
     />
     {invalidUrl && <span id={`${fieldId}-url-error`} className="text-xs text-danger">{t.customFormBaseUrlInvalid}</span>}
    </label>
   </div>
   {form.originalId && idTrim !== form.originalId && <p className="mt-2 text-xs text-warn">{t.customFormRenameHint}</p>}

   <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
    <div className="flex min-w-0 flex-col gap-2 text-[13px]">
     <span className="text-muted">{t.customFormApi}</span>
     {/* 浮层下拉（`EnumSelect`），不是行内展开：内嵌列表会把保存按钮整体推下去（用户实测） */}
     <EnumSelect
      label={t.customFormApi}
      value={form.api}
      choices={apiOptionsFor(form.api).map((opt) => ({ value: opt, label: opt }))}
      busy={busy}
      triggerClassName={API_TRIGGER_CLASS}
      itemClassName={API_ITEM_CLASS}
      onPick={(api) => onChange({ ...form, api })}
     />
    </div>

    <label className="flex min-w-0 flex-col gap-2 text-[13px]">
     <span className="shrink-0 text-muted">{t.customFormAuthKey}</span>
     <input
      value={form.apiKey}
      type="password"
      onChange={(e) => onChange({ ...form, apiKey: e.target.value })}
      placeholder="MY_GW_KEY"
      title={t.customFormApiKeyHint}
      className={`${inputCls} font-mono`}
     />
    </label>
   </div>

   {error && (
    <p ref={errorRef} role="alert" tabIndex={-1} className="mt-3 font-mono text-xs whitespace-pre-wrap break-all text-danger">
     {error}
    </p>
   )}

   <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border-soft pt-4">
    <button
     onClick={onSave}
     disabled={busy || !complete}
     className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md bg-active px-4 py-2 text-[13px] font-medium text-accent transition-colors duration-100 hover:bg-hover disabled:opacity-50"
    >
     {busy && <Loader size={12} className="animate-spin" aria-hidden />}
     {t.customSave}
    </button>
    <button
     onClick={onCancel}
     disabled={busy}
     className="min-h-9 cursor-pointer rounded-md px-3 py-2 text-[13px] text-muted transition-colors duration-100 hover:bg-hover disabled:opacity-50"
    >
     {t.cancel}
    </button>
    {!complete && <span className="text-[11px] text-warn">{hint}</span>}
   </div>
  </fieldset>
 );
}
