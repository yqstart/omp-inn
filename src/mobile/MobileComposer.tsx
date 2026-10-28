import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, Stop, X } from "reicon-react";
import { api } from "@shared/api";
import type { ImageAttachment } from "@shared/types";
import { ATTACH_MAX_BYTES } from "../lib/attachments";
import { restoreImageOrder, withImageOrderNote } from "../lib/imageRefs";
import { prepareSessionForSend, refreshTitleAfterFirstSend } from "../lib/sessionOpen";
import { useText } from "../lib/useText";
import { useApp } from "../stores/app";

const MAX_IMAGES = 4;
const MAX_EDGE = 2048;

async function fileToImage(file: File): Promise<ImageAttachment> {
 // iOS 相机的 HEIC 在部分版本里 type 是 `image/heic` 甚至空串；不按 MIME 白名单卡死，
 // 交给 createImageBitmap/Image 解码，输出统一转 JPEG（PNG 小图保留）。
 if (file.type && !file.type.startsWith("image/")) {
  throw new Error("unsupported");
 }
 const bmp = await loadBitmap(file).catch(() => null);
 if (!bmp) throw new Error("decode");
 const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
 const w = Math.max(1, Math.round(bmp.width * scale));
 const h = Math.max(1, Math.round(bmp.height * scale));
 const canvas = document.createElement("canvas");
 canvas.width = w;
 canvas.height = h;
 const ctx = canvas.getContext("2d");
 if (!ctx) throw new Error("canvas");
 ctx.drawImage(bmp.source, 0, 0, w, h);
 const mime = file.type === "image/png" && file.size <= 1.5 * 1024 * 1024 ? "image/png" : "image/jpeg";
 const dataUrl = canvas.toDataURL(mime, 0.85);
 const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
 const bytes = Math.floor((dataBase64.length * 3) / 4);
 if (bytes > ATTACH_MAX_BYTES) throw new Error("too-large");
 if (typeof ImageBitmap !== "undefined" && bmp.source instanceof ImageBitmap) bmp.source.close();
 return { name: file.name || "photo.jpg", mimeType: mime, dataBase64, bytes };
}

async function loadBitmap(file: File): Promise<{ source: CanvasImageSource; width: number; height: number }> {
 if (typeof createImageBitmap === "function") {
  try {
   const bmp = await createImageBitmap(file);
   return { source: bmp, width: bmp.width, height: bmp.height };
  } catch {
   // HEIC / 部分 Safari 版本 createImageBitmap 不认，退回 <img> 解码。
  }
 }
 return new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
   URL.revokeObjectURL(url);
   resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
  };
  img.onerror = () => {
   URL.revokeObjectURL(url);
   reject(new Error("decode"));
  };
  img.src = url;
 });
}

export function MobileComposer({
 sid,
 onSent,
 onStop,
}: {
 sid: string;
 onSent: () => void;
 onStop: () => void;
}) {
 const t = useText();
 const draft = useApp((s) => s.drafts[sid] ?? "");
 const attachments = useApp((s) => s.attachmentsBySession[sid]) ?? [];
 const state = useApp((s) => s.statusBySession[sid]?.state);
 const queued = useApp((s) => s.queuedBySession[sid]);
 const [busy, setBusy] = useState(false);
 const busyRef = useRef(false);
 const [error, setError] = useState<string | null>(null);
 const [showConfirmStop, setShowConfirmStop] = useState(false);
 const ta = useRef<HTMLTextAreaElement>(null);
 const fileRef = useRef<HTMLInputElement>(null);
 const running = state === "running" || state === "awaiting-approval";

 useEffect(() => {
  const el = ta.current;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.3))}px`;
 }, [draft]);

 const setDraft = (v: string) => {
  useApp.getState().setDraft(sid, v);
  setError(null);
 };

 const send = async (kind: "send" | "steer" | "queue") => {
  if (busyRef.current) return;
  const text = draft.trim();
  if (!text && attachments.length === 0) {
   setError(t.mobileNoMessage);
   return;
  }
  busyRef.current = true;
  setBusy(true);
  setError(null);
  const initial = useApp.getState();
  initial.setDraft(sid, "");
  initial.clearAttachments(sid);
  let target = sid;
  const movePending = (id: string) => {
   target = id;
   const st = useApp.getState();
   const pending = st.draftOf(sid);
   const images = st.attachmentsOf(sid);
   const occupied = new Set(st.attachmentsOf(id).map((image) => image.slot));
   const assigned = st.addAttachments(id, images.map((image) => occupied.has(image.slot) ? { ...image, slot: undefined } : image));
   const mapped = images.length ? restoreImageOrder(withImageOrderNote(pending, images), assigned) : pending;
   const existing = st.draftOf(id);
   st.setDraft(id, existing.trim() && mapped.trim() ? `${existing}\n\n${mapped}` : existing + mapped);
   st.setDraft(sid, "");
   st.clearAttachments(sid);
  };
  // 正文引用 `#N` 且带图时补附件顺序注记（只进 wire text；界面 / 标题仍用原文）
  const wireText = withImageOrderNote(text, attachments);
  try {
   if (text.startsWith("/") && attachments.length === 0) {
    target = await prepareSessionForSend(sid, movePending);
    await api.runSlash(target, text);
   } else if (kind === "queue") {
    await api.followUpMessage(sid, wireText, attachments.length ? attachments : undefined);
   } else if (kind === "steer") {
    await api.steerMessage(sid, wireText, attachments.length ? attachments : undefined);
   } else {
    target = await prepareSessionForSend(sid, movePending);
    await api.sendMessage(target, wireText, attachments.length ? attachments : undefined);
    // 新回合开始：上一轮已全部完成的任务清单收起（与桌面 Composer 同一口径）
    useApp.getState().dismissCompletedPlans(target);
   }
   if (text && !text.startsWith("/")) void refreshTitleAfterFirstSend(target, text).catch(() => undefined);
   onSent();
  } catch (e) {
   const st = useApp.getState();
   const occupied = new Set(st.attachmentsOf(target).map((image) => image.slot));
   const restored = st.addAttachments(target, attachments.map((image) => occupied.has(image.slot) ? { ...image, slot: undefined } : image));
   const original = attachments.length ? restoreImageOrder(withImageOrderNote(text, attachments), restored) : text;
   const current = st.draftOf(target);
   st.setDraft(target, original.trim() && current.trim() ? `${original}\n\n${current}` : original + current);
   setError(e instanceof Error ? e.message : String(e));
  } finally {
   busyRef.current = false;
   setBusy(false);
  }
 };

 const addFiles = async (files: FileList | null) => {
  if (!files || files.length === 0) return;
  setError(null);
  const room = MAX_IMAGES - attachments.length;
  if (room <= 0) {
   setError(t.mobileImageLimit);
   return;
  }
  const picked = Array.from(files).slice(0, room);
  const out: ImageAttachment[] = [];
  for (const f of picked) {
   try {
    out.push(await fileToImage(f));
   } catch {
    setError(t.mobileImageFailed);
   }
  }
  if (out.length > 0) useApp.getState().addAttachments(sid, out);
  if (fileRef.current) fileRef.current.value = "";
 };

 return (
  <div className="mobile-composer px-3 pt-2">
   {attachments.length > 0 && (
    <div className="mb-2 flex gap-2 overflow-x-auto">
     {attachments.map((a, i) => (
      <div key={`${a.name}-${i}`} className="relative shrink-0">
       <img
        src={`data:${a.mimeType};base64,${a.dataBase64}`}
        alt={a.name}
        className="h-16 w-16 rounded-lg border border-border object-cover"
       />
       <button
        type="button"
        onClick={() => useApp.getState().removeAttachment(sid, i)}
        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-surface text-foreground shadow"
        aria-label={t.cancel}
       >
        <X size={13} />
       </button>
      </div>
     ))}
    </div>
   )}

   {queued && (queued.steering.length > 0 || queued.followUp.length > 0) && (
    <div className="mb-2 truncate text-[11px] text-faint">
     {queued.steering.length > 0 && `${t.pendingSteer} ${queued.steering.length}`}
     {queued.steering.length > 0 && queued.followUp.length > 0 && " · "}
     {queued.followUp.length > 0 && `${t.pendingQueue} ${queued.followUp.length}`}
    </div>
   )}

   <div className="flex items-end gap-2 rounded-xl border border-border bg-surface px-2 py-1.5">
    <button
     type="button"
     onClick={() => fileRef.current?.click()}
     className="mb-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-faint hover:bg-hover hover:text-foreground"
     aria-label={t.mobileAddImage}
    >
     <ImagePlus size={19} />
    </button>
    <input
     ref={fileRef}
     type="file"
     accept="image/*"
     multiple
     className="hidden"
     onChange={(e) => void addFiles(e.target.files)}
    />
    <textarea
     ref={ta}
     value={draft}
     onChange={(e) => setDraft(e.target.value)}
     onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
       e.preventDefault();
       void send(running ? "steer" : "send");
      }
     }}
     rows={1}
     placeholder={running ? t.placeholderRunning : t.placeholderIdle}
     className="min-h-9 max-h-[30vh] min-w-0 flex-1 resize-none bg-transparent py-2 outline-none placeholder:text-faint"
    />
    {running ? (
     <>
      <button
       type="button"
       disabled={busy}
       onClick={() => void send("queue")}
       className="mb-0.5 shrink-0 cursor-pointer rounded-lg border border-border px-2.5 py-2 text-[12px] hover:bg-hover disabled:opacity-50"
      >
       {t.pendingQueue}
      </button>
      <button
       type="button"
       disabled={busy}
       onClick={() => void send("steer")}
       className="mb-0.5 flex shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
      >
       <Send size={15} />
       {t.pendingSteer}
      </button>
      <button
       type="button"
       onClick={() => setShowConfirmStop(true)}
       className="mb-0.5 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-danger hover:bg-danger/10"
       aria-label={t.stop}
      >
       <Stop size={16} />
      </button>
     </>
    ) : (
     <button
      type="button"
      disabled={busy}
      onClick={() => void send("send")}
      className="mb-0.5 flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
     >
      <Send size={15} />
      {busy ? t.mobileConnecting : t.sendAria}
     </button>
    )}
   </div>

   {error && (
    <div role="alert" className="mt-1.5 text-[12px] text-danger">
     {error}
    </div>
   )}

   {showConfirmStop && (
    <div className="mobile-sheet-backdrop" onClick={() => setShowConfirmStop(false)}>
     <div className="mobile-sheet p-4" onClick={(e) => e.stopPropagation()}>
      <div className="text-[15px] font-medium">{t.stop}</div>
      <p className="mt-1 text-[13px] leading-6 text-muted">{t.mobileStopConfirm}</p>
      <div className="mt-4 flex gap-2">
       <button
        type="button"
        onClick={() => setShowConfirmStop(false)}
        className="flex-1 cursor-pointer rounded-lg border border-border py-2.5 text-[14px]"
       >
        {t.cancel}
       </button>
       <button
        type="button"
        onClick={() => {
         setShowConfirmStop(false);
         onStop();
        }}
        className="flex-1 cursor-pointer rounded-lg bg-danger/15 py-2.5 text-[14px] font-medium text-danger"
       >
        {t.stop}
       </button>
      </div>
     </div>
    </div>
   )}
  </div>
 );
}
