import { Button } from '@/components/ui/button';
import * as React from 'react';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import { normalizeErrorMessage } from '../../../shared/errors';
import type { StorageMigrationProgress } from '../../../shared/storageMigration';
import { DataMigrationProgress } from './DataMigrationProgress';
import { useConfirm } from '@/components/ui/confirm-dialog';

const INITIAL: StorageMigrationProgress = { phase: 'scanning', percent: 0, completedFiles: 0, totalFiles: 0 };
export function StorageMigrationPrompt(): React.ReactElement {
  const { api, booted } = useBridge();
  const confirm = useConfirm();
  const inspected = React.useRef(false);
  const alive = React.useRef(true);
  const [destination, setDestination] = React.useState('');
  const [progress, setProgress] = React.useState<StorageMigrationProgress | null>(null);
  const [failure, setFailure] = React.useState('');
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const migrate = React.useCallback(async () => {
    setFailure(''); setProgress(INITIAL);
    const off = api.onStorageMigrationProgress?.(value => { if (alive.current) setProgress(value); });
    try {
      const result = await api.migrateStorage!();
      const pending = (result as typeof result & { storageMigrationResult?: { cleanupPending?: number } }).storageMigrationResult?.cleanupPending ?? 0;
      if (pending > 0) showToast(`数据已迁移，${pending} 个发生变化或被占用的原文件已保留。`, 'warning');
      if (alive.current) setProgress(null);
    } catch (error) { if (alive.current) setFailure(normalizeErrorMessage(error)); }
    finally { off?.(); }
  }, [api]);
  React.useEffect(() => {
    if (!booted || inspected.current || !api.inspectStorageMigration || !api.migrateStorage) return;
    const inspect = async () => {
      if (inspected.current || document.querySelector('#onboarding-setup')) return;
      inspected.current = true;
      try {
        const plan = await api.inspectStorageMigration!();
        if (plan?.deferred) { inspected.current = false; return; }
        if (!plan || !alive.current) return;
        setDestination(plan.destination);
        const agreed = await confirm({
          title: '迁移数据目录？',
          body: `将默认 Trace、运行日志和备份移动到安装目录下的 ${plan.destination}。校验完成后才切换目录，已有自定义目录保留。选择稍后处理会继续使用当前位置。`,
          confirmText: '迁移', cancelText: '稍后处理', size: 'wide'
        });
        if (agreed && alive.current) await migrate();
      } catch (error) { if (alive.current) showErrorToast('无法检查数据目录', error); }
    };
    const observer = new MutationObserver(() => { void inspect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setInterval(() => { void inspect(); }, 2000);
    void inspect();
    return () => { clearInterval(timer); observer.disconnect(); };
  }, [api, booted, confirm, migrate]);
  return <DataMigrationProgress title={failure ? '数据迁移未完成' : '正在整理数据目录'} description={`Trace、运行日志和备份迁移至 ${destination}。校验完成后自动切换，配置和自定义目录保留。`} progress={progress} phase="正在迁移并校验数据">
    {failure && <><p className="provider-field-error" role="alert">{failure}</p><div className="data-migration-actions">
      <Button variant="outline" onClick={() => setProgress(null)}>稍后处理</Button>
      <Button variant="default" onClick={() => { void migrate(); }}>重试迁移</Button>
    </div></>}
  </DataMigrationProgress>;
}
