/** 当前编辑器提供的同步草稿迁移入口。 */
type DraftTransfer = (from: string, to: string) => void;
let activeTransfer: DraftTransfer | null = null;

export function registerDraftTransfer(transfer: DraftTransfer): () => void {
 activeTransfer = transfer;
 return () => {
  if (activeTransfer === transfer) activeTransfer = null;
 };
}

export function transferEditorDraft(from: string, to: string): boolean {
 if (!activeTransfer) return false;
 activeTransfer(from, to);
 return true;
}
