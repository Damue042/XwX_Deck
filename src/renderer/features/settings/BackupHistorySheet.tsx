import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ChevronRight, FolderOpen, LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useBridge } from '@/bridge/store';
import type { BackupRecord } from '@/bridge/types';
import { t, useLanguage } from '@/lib/i18n';
import { OPEN_BACKUPS_EVENT, openBackups, showErrorToast, showToast } from '@/lib/toast';

export function BackupHistorySheet(): React.ReactElement {
  const language = useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [records, setRecords] = React.useState<readonly BackupRecord[]>([]);
  const [selectedPath, setSelectedPath] = React.useState<string>();
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const generation = React.useRef(0);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const load = React.useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setFailed(false);
    try {
      const rows = await bridge.api.getBackupHistory();
      if (current === generation.current) setRecords(rows);
    } catch {
      if (current === generation.current) setFailed(true);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [bridge.api]);
  React.useEffect(() => {
    if (open) void load();
    return () => { generation.current++; };
  }, [open, load]);
  React.useEffect(() => {
    const show = (event: Event) => {
      setSelectedPath((event as CustomEvent<string | undefined>).detail);
      setOpen(true);
    };
    window.addEventListener(OPEN_BACKUPS_EVENT, show);
    return () => window.removeEventListener(OPEN_BACKUPS_EVENT, show);
  }, []);
  React.useLayoutEffect(() => {
    const record = records.find(item => item.path === selectedPath);
    const container = body.current;
    const row = record && container?.querySelector<HTMLElement>(`[data-backup-id="${record.id}"]`);
    if (!row || !container) return;
    const a = row.getBoundingClientRect(), b = container.getBoundingClientRect();
    if (a.top < b.top || a.bottom > b.bottom) container.scrollTop += a.top - b.top;
  }, [records, selectedPath]);
  const openFolder = async (id?: string) => {
    try { await bridge.api.openBackupFolder(id); }
    catch (error) { showErrorToast(t('无法打开备份位置'), error); }
  };
  const restore = async (record: BackupRecord) => {
    if (busy || !await confirm({ title: t('恢复{0}？', t(record.title)), body: t('将替换当前配置，并先备份现有文件。数据位置保持不变。'), confirmText: t('恢复'), cancelText: t('取消') })) return;
    setBusy(true);
    try {
      const result = await bridge.api.restoreBackup(record);
      const [runtime, providers, codexConfig] = await Promise.allSettled([bridge.api.getState(), bridge.api.getProviders(), bridge.api.getCodexConfig()]);
      bridge.patch({
        ...(runtime.status === 'fulfilled' ? { runtime: runtime.value } : {}),
        ...(providers.status === 'fulfilled' ? { providers: providers.value } : {}),
        ...(codexConfig.status === 'fulfilled' ? { codexConfig: codexConfig.value } : {}),
      });
      window.dispatchEvent(new Event('xwxdeck:metadata-changed'));
      void bridge.api.getModelClients?.().then(modelClients => bridge.patch({ modelClients })).catch(() => undefined);
      void bridge.api.getModelServices().then(modelServices => bridge.patch({ modelServices })).catch(() => undefined);
      await load();
      showToast(t('配置已恢复'), 'success', undefined, { actionProps: result.backupPath ? { children: t('查看备份'), onClick: () => openBackups(result.backupPath ?? undefined) } : undefined });
    } catch (error) { showErrorToast(t('恢复备份失败'), error); }
    finally { setBusy(false); }
  };
  const locale = language === 'zh-CN' ? 'zh-CN' : language;
  const day = (at: number) => {
    const date = new Date(at), today = new Date(), yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return t('今天');
    if (date.toDateString() === yesterday.toDateString()) return t('昨天');
    return date.toLocaleDateString(locale, { year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
  };
  return <section className="group repair-entry-group">
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger ref={trigger} type="button" className="repair-entry" id="backupEntry" onClick={() => setSelectedPath(undefined)}>
        <span className="repair-entry-title">{t('备份')}</span><ChevronRight className="ic repair-entry-chevron" aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="repair-sheet-backdrop" />
        <Dialog.Popup className="repair-sheet-popup backup-history-sheet" id="backupsSheet" finalFocus={trigger}>
          <header className="repair-sheet-header backup-history-header">
            <Dialog.Title>{t('备份')}</Dialog.Title>
            <Dialog.Description className="sr-only">{t('查看备份历史')}</Dialog.Description>
            <span className="backup-header-actions">
              <Button type="button" variant="ghost" size="icon" title={t('打开备份目录')} aria-label={t('打开备份目录')} onClick={() => void openFolder()}><FolderOpen className="ic" aria-hidden="true" /></Button>
              <Dialog.Close render={<Button type="button" variant="ghost" size="icon" aria-label={t('关闭备份')} />}><X className="ic" aria-hidden="true" /></Dialog.Close>
            </span>
          </header>
          <div ref={body} className="repair-sheet-body backup-history-body">
            {loading ? <LoaderCircle className="ic backup-history-loading" aria-label={t('正在读取备份')} /> : failed ? <div className="backup-history-empty">{t('无法读取备份')}<Button type="button" variant="ghost" onClick={() => void load()}>{t('重试')}</Button></div> : records.length === 0 ? <p className="backup-history-empty">{t('暂无备份')}</p> : records.map((record, index) => <React.Fragment key={record.id}>
              {(!index || day(records[index - 1].createdAt) !== day(record.createdAt)) && <p className="backup-day">{day(record.createdAt)}</p>}
              <div className="backup-record" data-backup-id={record.id} data-selected={record.path === selectedPath || undefined}>
                <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                <span className="backup-record-name" title={t(record.title)}>{t(record.title)}</span>
                <span className="backup-record-actions">
                  <Button type="button" variant="ghost" size="icon" title={t('打开位置')} aria-label={t('打开{0}备份位置', t(record.title))} onClick={() => void openFolder(record.id)}><FolderOpen className="ic" aria-hidden="true" /></Button>
                  {record.canRestore && <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={t('恢复{0}', t(record.title))} onClick={() => void restore(record)}>{t('恢复')}</Button>}
                </span>
              </div>
            </React.Fragment>)}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
